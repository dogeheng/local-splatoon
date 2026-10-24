import { CLOSE, PING_INTERVAL_MS, PROTOCOL_VERSION } from '../../../shared/constants';
import type { ServerMsg } from '../../../shared/protocol';

export type NetState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** 与服务器的时钟同步：取最近 8 个样本里 RTT 最小者计算偏移。 */
export class Clock {
  private samples: { rtt: number; off: number }[] = [];
  offset = 0;
  rtt = 0;
  jitter = 0;
  private target = 0;
  private hasSample = false;

  sample(t0: number, ts: number): void {
    const t1 = performance.now();
    const rtt = t1 - t0;
    const off = ts + rtt / 2 - t1;
    this.samples.push({ rtt, off });
    if (this.samples.length > 8) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    const mean = this.samples.reduce((s, x) => s + x.rtt, 0) / this.samples.length;
    this.jitter = Math.sqrt(this.samples.reduce((s, x) => s + (x.rtt - mean) ** 2, 0) / this.samples.length);
    this.rtt = rtt;
    this.target = best.off;
    if (!this.hasSample) {
      this.offset = best.off;
      this.hasSample = true;
    }
  }

  /** 每帧调用：偏移平滑趋近目标，避免时间跳变。 */
  tick(dtMs: number): void {
    const d = this.target - this.offset;
    if (Math.abs(d) > 250) this.offset = this.target;
    else this.offset += d * Math.min(1, dtMs / 500);
  }

  /** 首次握手时用 welcome 中的服务器时间粗略对齐。 */
  roughAlign(st: number): void {
    if (!this.hasSample) {
      this.offset = st - performance.now();
      this.target = this.offset;
    }
  }

  serverNow(): number {
    return performance.now() + this.offset;
  }
}

export interface NetCallbacks {
  onMessage: (m: ServerMsg) => void;
  onState: (s: NetState, info?: { code?: number; reason?: string }) => void;
}

const tokKey = (room: string) => `sa.tok.${room}`;

export function savedToken(room: string): string | null {
  return sessionStorage.getItem(tokKey(room));
}

export function clearToken(room: string): void {
  sessionStorage.removeItem(tokKey(room));
}

/** 不会自动重连的关闭码（终止性错误）。 */
const TERMINAL = new Set<number>([CLOSE.REPLACED, CLOSE.VERSION, CLOSE.FULL, CLOSE.NO_ROOM, CLOSE.INVALID, CLOSE.NORMAL, CLOSE.SHUTDOWN]);

export class Net {
  ws: WebSocket | null = null;
  state: NetState = 'idle';
  readonly clock = new Clock();
  room = '';
  private name = '';
  private attempt = 0;
  private everWelcomed = false;
  private retryTimer = 0;
  private pingTimer = 0;
  private wantClose = false;
  lastMsgAt = 0;

  constructor(private cb: NetCallbacks) {}

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  create(name: string): void {
    this.name = name;
    this.room = '';
    this.open({ act: 'create' });
  }

  join(room: string, name: string): void {
    this.name = name;
    this.room = room;
    const tok = savedToken(room);
    this.open(tok ? { act: 'resume', room, tok } : { act: 'join', room });
  }

  private open(hello: { act: string; room?: string; tok?: string }): void {
    this.wantClose = false;
    this.setState(this.everWelcomed ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: this.name, ...hello }));
    };
    ws.onmessage = (ev) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      this.lastMsgAt = performance.now();
      if (m.t === 'welcome') {
        this.room = m.room;
        sessionStorage.setItem(tokKey(m.room), m.tok);
        this.everWelcomed = true;
        this.attempt = 0;
        this.clock.roughAlign(m.st);
        this.setState('open');
        this.startPing();
      } else if (m.t === 'pong') {
        this.clock.sample(m.t0, m.ts);
        return;
      }
      this.cb.onMessage(m);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      if (this.wantClose) {
        this.setState('closed', { code: ev.code });
        return;
      }
      if (ev.code === CLOSE.NO_ROOM || ev.code === CLOSE.REPLACED || ev.code === CLOSE.NORMAL) {
        if (this.room && ev.code !== CLOSE.REPLACED) clearToken(this.room);
      }
      if (TERMINAL.has(ev.code) || !this.room) {
        this.setState('closed', { code: ev.code, reason: ev.reason });
        return;
      }
      // 网络闪断：指数退避加随机抖动后用令牌恢复座位
      const base = ev.code === CLOSE.RATE ? 5000 : Math.min(4000, 500 * 2 ** this.attempt);
      const delay = base * (0.8 + Math.random() * 0.4);
      this.attempt++;
      this.setState('reconnecting', { code: ev.code });
      if (this.attempt > 20) {
        this.setState('closed', { code: ev.code, reason: 'gave-up' });
        return;
      }
      this.retryTimer = window.setTimeout(() => {
        const tok = savedToken(this.room);
        if (tok) this.open({ act: 'resume', room: this.room, tok });
        else this.open({ act: 'join', room: this.room });
      }, delay);
    };
  }

  /** 立即重试（例如页面从后台切回、网络恢复）。 */
  retryNow(): void {
    if (this.state !== 'reconnecting' || this.ws) return;
    clearTimeout(this.retryTimer);
    const tok = savedToken(this.room);
    if (tok) this.open({ act: 'resume', room: this.room, tok });
  }

  private startPing(): void {
    this.stopPing();
    const ping = () => this.send({ t: 'ping', t0: performance.now() });
    ping();
    this.pingTimer = window.setInterval(ping, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    clearInterval(this.pingTimer);
  }

  send(m: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  leave(): void {
    this.wantClose = true;
    clearTimeout(this.retryTimer);
    this.send({ t: 'leave' });
    if (this.room) clearToken(this.room);
    try {
      this.ws?.close(1000);
    } catch { /* ignore */ }
    this.ws = null;
    this.everWelcomed = false;
    this.room = '';
    this.setState('idle');
  }

  private setState(s: NetState, info?: { code?: number; reason?: string }): void {
    this.state = s;
    this.cb.onState(s, info);
  }
}
