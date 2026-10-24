import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BTN_FIRE, CLOSE, PROTOCOL_VERSION } from '../shared/constants';
import { radToAim } from '../shared/math';
import { startServer, type RunningServer } from '../server/index';

let srv: RunningServer;
let url: string;

class Bot {
  ws: WebSocket;
  msgs: any[] = [];
  closeCode = 0;
  welcome: any = null;
  lobby: any = null;
  lastSnap: any = null;
  result: any = null;
  seq = 0;
  private waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = [];

  constructor(headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      this.msgs.push(m);
      if (m.t === 'welcome') this.welcome = m;
      if (m.t === 'lobby') this.lobby = m;
      if (m.t === 's') this.lastSnap = m;
      if (m.t === 'result') this.result = m;
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(m)) {
          w.res(m);
          return false;
        }
        return true;
      });
    });
    this.ws.on('close', (code) => {
      this.closeCode = code;
    });
    this.ws.on('error', () => {});
  }
  open() {
    return new Promise<void>((res, rej) => {
      if (this.ws.readyState === WebSocket.OPEN) return res();
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  wait(pred: (m: any) => boolean, ms = 8000): Promise<any> {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting')), ms);
      this.waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
    });
  }
  waitClose(ms = 5000): Promise<number> {
    return new Promise((res, rej) => {
      if (this.ws.readyState === WebSocket.CLOSED) return res(this.closeCode);
      const t = setTimeout(() => rej(new Error('timeout close')), ms);
      this.ws.once('close', (code) => { clearTimeout(t); res(code); });
    });
  }
  input(mx: number, mz: number, btn: number, aimRad = 0) {
    this.seq++;
    this.send({ t: 'in', s: [[this.seq, mx, mz, radToAim(aimRad), 50, btn]] });
  }
  close() {
    this.ws.close();
  }
}

async function hello(b: Bot, act: string, extra: object = {}) {
  await b.open();
  b.send({ t: 'hello', v: PROTOCOL_VERSION, act, name: 'bot', ...extra });
}

beforeAll(async () => {
  srv = await startServer({
    port: 0, host: '127.0.0.1', quiet: true,
    room: { roundSecOverride: 3, countdownMsOverride: 300, resultsMsOverride: 1500 },
  });
  url = `ws://127.0.0.1:${srv.port}/ws`;
});
afterAll(async () => {
  await srv.close();
});

describe('联机完整流程', () => {
  it('创建 → 加入 → 准备 → 开始 → 对局 → 结算 → 再来一局', async () => {
    const a = new Bot();
    await hello(a, 'create');
    const wa = await a.wait((m) => m.t === 'welcome');
    const code = wa.room;
    expect(code).toMatch(/^[0-9A-Z]{5}$/);

    const b = new Bot();
    await hello(b, 'join', { room: code });
    await b.wait((m) => m.t === 'welcome');
    const lob = await a.wait((m) => m.t === 'lobby' && m.players.length === 2);
    const teams = lob.players.map((p: any) => p.team).sort();
    expect(teams).toEqual([0, 1]);
    expect(lob.host).toBe(wa.me);

    // 未准备时不能开始
    a.send({ t: 'start' });
    const e = await a.wait((m) => m.t === 'err');
    expect(e.code).toBe('cannot-start');

    b.send({ t: 'ready', r: true });
    await a.wait((m) => m.t === 'lobby' && m.players.every((p: any) => p.id === wa.me || p.ready));
    a.send({ t: 'start' });
    await a.wait((m) => m.t === 'cd');
    await b.wait((m) => m.t === 'cd');
    await a.wait((m) => m.t === 's' && m.ph === 'playing');

    // 双方对射 2 秒
    const meA = wa.me;
    const timer = setInterval(() => {
      a.input(100, 0, BTN_FIRE, 0);
      b.input(-100, 0, BTN_FIRE, Math.PI);
    }, 16);
    const ra = await a.wait((m) => m.t === 'result', 10000);
    const rb = await b.wait((m) => m.t === 'result', 10000);
    clearInterval(timer);
    expect(ra).toEqual(rb);
    expect(ra.cells[0]).toBeGreaterThan(0);
    expect(ra.cells[1]).toBeGreaterThan(0);
    expect(ra.reason).toBe('time');
    // 服务器确认了输入
    expect(a.lastSnap.ack[meA]).toBeGreaterThan(10);

    // 两人都投票再来一局 → 直接进入新的倒计时
    a.send({ t: 'again' });
    b.send({ t: 'again' });
    const cd2 = await a.wait((m) => m.t === 'cd' && m.matchNo === 2);
    expect(cd2.matchNo).toBe(2);
    a.close();
    b.close();
  });

  it('刷新后用座位令牌恢复原座位', async () => {
    const a = new Bot();
    await hello(a, 'create');
    const wa = await a.wait((m) => m.t === 'welcome');
    const b = new Bot();
    await hello(b, 'join', { room: wa.room });
    const wb = await b.wait((m) => m.t === 'welcome');
    b.ws.terminate();
    await a.wait((m) => m.t === 'lobby' && m.players.some((p: any) => p.id === wb.me && !p.online));

    const b2 = new Bot();
    await hello(b2, 'resume', { room: wa.room, tok: wb.tok });
    const wb2 = await b2.wait((m) => m.t === 'welcome');
    expect(wb2.me).toBe(wb.me);
    expect(wb2.tok).not.toBe(wb.tok);
    await a.wait((m) => m.t === 'lobby' && m.players.find((p: any) => p.id === wb.me)?.online === true);

    // 旧令牌已失效
    const b3 = new Bot();
    await hello(b3, 'resume', { room: wa.room, tok: wb.tok });
    expect(await b3.waitClose()).toBe(CLOSE.NO_ROOM);
    a.close();
    b2.close();
  });

  it('同一令牌的新连接会接管座位，旧连接收到 4001', async () => {
    const a = new Bot();
    await hello(a, 'create');
    const wa = await a.wait((m) => m.t === 'welcome');
    const a2 = new Bot();
    await hello(a2, 'resume', { room: wa.room, tok: wa.tok });
    await a2.wait((m) => m.t === 'welcome');
    expect(await a.waitClose()).toBe(CLOSE.REPLACED);
    a2.close();
  });

  it('对局中加入的人成为观战者', async () => {
    const a = new Bot();
    await hello(a, 'create');
    const wa = await a.wait((m) => m.t === 'welcome');
    const b = new Bot();
    await hello(b, 'join', { room: wa.room });
    await b.wait((m) => m.t === 'welcome');
    b.send({ t: 'ready', r: true });
    await a.wait((m) => m.t === 'lobby' && m.players.length === 2 && m.players.every((p: any) => p.id === wa.me || p.ready));
    a.send({ t: 'start' });
    await a.wait((m) => m.t === 'cd');
    const c = new Bot();
    await hello(c, 'join', { room: wa.room });
    const wc = await c.wait((m) => m.t === 'welcome');
    const lob = await c.wait((m) => m.t === 'lobby');
    expect(lob.players.find((p: any) => p.id === wc.me).role).toBe('spectator');
    await c.wait((m) => m.t === 's');
    a.close();
    b.close();
    c.close();
  });

  it('一队全部掉线 10 秒后判负', async () => {
    const a = new Bot();
    await hello(a, 'create');
    const wa = await a.wait((m) => m.t === 'welcome');
    const b = new Bot();
    await hello(b, 'join', { room: wa.room });
    await b.wait((m) => m.t === 'welcome');
    b.send({ t: 'ready', r: true });
    await a.wait((m) => m.t === 'lobby' && m.players.length === 2 && m.players.every((p: any) => p.id === wa.me || p.ready));
    // 本用例用较长的对局，确保是弃权而不是时间到
    srv.rooms.get(wa.room)!.roundSec = 120;
    (srv.rooms.get(wa.room) as any).opts = { ...(srv.rooms.get(wa.room) as any).opts, roundSecOverride: 60 };
    a.send({ t: 'start' });
    await a.wait((m) => m.t === 's' && m.ph === 'playing');
    b.ws.terminate();
    const r = await a.wait((m) => m.t === 'result', 15000);
    expect(r.reason).toBe('forfeit');
    expect(r.winner).toBe(lobTeam(a, wa.me));
    a.close();
  }, 20000);

  it('重复与乱序的输入被丢弃', async () => {
    const a = new Bot();
    await hello(a, 'create');
    const wa = await a.wait((m) => m.t === 'welcome');
    a.send({ t: 'in', s: [[5, 100, 0, 0, 50, 0]] });
    a.send({ t: 'in', s: [[3, 100, 0, 0, 50, 0]] });
    a.send({ t: 'in', s: [[5, 100, 0, 0, 50, 0]] });
    const s = await a.wait((m) => m.t === 's' && m.ack[wa.me] === 5);
    expect(s.ack[wa.me]).toBe(5);
    a.close();
  });
});

describe('安全', () => {
  it('拒绝跨站 Origin', async () => {
    const bad = new Bot({ origin: 'http://evil.example' });
    await expect(bad.open()).rejects.toBeTruthy();
  });
  it('协议版本不一致返回 4002', async () => {
    const b = new Bot();
    await b.open();
    b.send({ t: 'hello', v: 999, act: 'create', name: 'x' });
    expect(await b.waitClose()).toBe(CLOSE.VERSION);
  });
  it('房间不存在返回 4004', async () => {
    const b = new Bot();
    await hello(b, 'join', { room: 'ZZZZZ' });
    expect(await b.waitClose()).toBe(CLOSE.NO_ROOM);
  });
  it('持续发送非法消息会被断开', async () => {
    const b = new Bot();
    await hello(b, 'create');
    await b.wait((m) => m.t === 'welcome');
    for (let i = 0; i < 6; i++) b.send({ t: 'in', s: [[1, 999, 0, 0, 0, 0]] });
    expect(await b.waitClose()).toBe(CLOSE.INVALID);
  });
  it('非房主不能开始游戏', async () => {
    const a = new Bot();
    await hello(a, 'create');
    const wa = await a.wait((m) => m.t === 'welcome');
    const b = new Bot();
    await hello(b, 'join', { room: wa.room });
    await b.wait((m) => m.t === 'welcome');
    b.send({ t: 'start' });
    const e = await b.wait((m) => m.t === 'err');
    expect(e.code).toBe('not-host');
    a.close();
    b.close();
  });
});

function lobTeam(b: Bot, id: number): number {
  return b.lobby.players.find((p: any) => p.id === id).team;
}
