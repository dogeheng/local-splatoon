import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { WebSocket } from 'ws';
import {
  CLOSE, COUNTDOWN_MS, DEFAULT_ROUND_SEC, DT, EMPTY_ROOM_MS, FORFEIT_MS, GRACE_MS, MAX_CATCHUP_STEPS,
  MAX_PLAYERS, MAX_SPECTATORS, PROTOCOL_VERSION, RESULTS_MS, SNAPSHOT_EVERY, TEAM_MAX,
} from '../shared/constants';
import { PAINTABLE_COUNT } from '../shared/arena';
import { bytesToBase64 } from '../shared/math';
import type {
  ControlMsg, LobbyMsg, LobbyPlayer, Phase, ResultMsg, Role, SnapshotMsg,
} from '../shared/protocol';
import type { InputFrame } from '../shared/sim';
import { type Actor, World } from './world';
import { log } from './log';

export const serverNow = () => performance.timeOrigin + performance.now();

export interface Member {
  id: number;
  name: string;
  tok: string;
  role: Role;
  team: number;
  slot: number;
  ws: WebSocket | null;
  online: boolean;
  ready: boolean;
  again: boolean;
  joinedAt: number;
  graceTimer: NodeJS.Timeout | null;
  actor: Actor | null;
}

export interface RoomOptions {
  roundSecOverride?: number; // 测试用：缩短对局
  resultsMsOverride?: number;
  countdownMsOverride?: number;
  lanUrls: () => string[];
}

const newToken = () => randomBytes(16).toString('hex');

export class Room {
  readonly code: string;
  readonly world = new World();
  readonly members = new Map<number, Member>();
  phase: Phase = 'lobby';
  hostId = 0;
  roundSec = DEFAULT_ROUND_SEC;
  wins: [number, number] = [0, 0];
  matchNo = 0;
  private nextId = 1;
  private startAt = 0;
  private endAt = 0;
  private resultsUntil = 0;
  private lastResult: ResultMsg | null = null;
  private loop: NodeJS.Timeout | null = null;
  private acc = 0;
  private lastTime = 0;
  private emptySince = 0;
  private teamGoneSince = [0, 0];
  destroyed = false;

  constructor(code: string, private opts: RoomOptions, private onDestroy: (r: Room) => void) {
    this.code = code;
    this.lastTime = serverNow();
    this.loop = setInterval(() => this.update(), 1000 / 120);
  }

  // ------------------------------------------------------------------ 成员

  private seatedPlayers(): Member[] {
    return [...this.members.values()].filter((m) => m.role === 'player');
  }

  private teamCount(team: number): number {
    return this.seatedPlayers().filter((m) => m.team === team).length;
  }

  private freeSlot(team: number): number {
    const used = new Set(this.seatedPlayers().filter((m) => m.team === team).map((m) => m.slot));
    for (let s = 0; s < TEAM_MAX; s++) if (!used.has(s)) return s;
    return -1;
  }

  canAccept(): boolean {
    const players = this.seatedPlayers().length;
    const specs = this.members.size - players;
    return players < MAX_PLAYERS || specs < MAX_SPECTATORS;
  }

  /** 新成员加入；对局进行中或已满员时成为观战者。 */
  join(ws: WebSocket, name: string): Member | null {
    const players = this.seatedPlayers().length;
    const specs = this.members.size - players;
    const canPlay = this.phase === 'lobby' && players < MAX_PLAYERS;
    if (!canPlay && specs >= MAX_SPECTATORS) return null;
    const m: Member = {
      id: this.nextId++, name, tok: newToken(), role: 'spectator', team: -1, slot: -1,
      ws, online: true, ready: false, again: false, joinedAt: serverNow(), graceTimer: null, actor: null,
    };
    this.members.set(m.id, m);
    if (canPlay) this.seat(m);
    this.electHost();
    log('join', { room: this.code, id: m.id, role: m.role, team: m.team });
    this.sendWelcome(m);
    this.broadcastLobby();
    return m;
  }

  private seat(m: Member, preferTeam = -1): boolean {
    const counts = [this.teamCount(0), this.teamCount(1)];
    let team = preferTeam;
    if (team < 0 || counts[team] >= TEAM_MAX) team = counts[0] <= counts[1] ? 0 : 1;
    if (counts[team] >= TEAM_MAX) return false;
    m.role = 'player';
    m.team = team;
    m.slot = this.freeSlot(team);
    m.ready = false;
    m.actor = this.world.addActor(m.id, m.team, m.slot);
    m.actor.online = m.online;
    this.world.updateHandicap();
    return true;
  }

  private unseat(m: Member): void {
    if (m.actor) this.world.removeActor(m.id);
    m.actor = null;
    m.role = 'spectator';
    m.team = -1;
    m.slot = -1;
    this.world.updateHandicap();
  }

  /** 用座位令牌恢复（刷新或断线重连）。 */
  resume(ws: WebSocket, tok: string): Member | null {
    const m = [...this.members.values()].find((x) => x.tok === tok);
    if (!m) return null;
    if (m.ws && m.ws !== ws) {
      const old = m.ws;
      m.ws = null;
      try {
        old.close(CLOSE.REPLACED, 'replaced');
      } catch { /* ignore */ }
    }
    if (m.graceTimer) clearTimeout(m.graceTimer);
    m.graceTimer = null;
    m.ws = ws;
    m.online = true;
    m.tok = newToken();
    if (m.actor) {
      m.actor.online = true;
      m.actor.inputQ.length = 0;
    }
    this.emptySince = 0;
    this.electHost();
    log('resume', { room: this.code, id: m.id });
    this.sendWelcome(m);
    this.broadcastLobby();
    if (this.phase === 'results' && this.lastResult) this.send(m, this.lastResult);
    if (this.phase === 'countdown' || this.phase === 'playing') {
      this.send(m, { t: 'cd', startAt: this.startAt, endAt: this.endAt, roundSec: this.roundSec, matchNo: this.matchNo, grid: bytesToBase64(this.world.grid.cells) });
    }
    return m;
  }

  /** 连接断开：玩家进入宽限期，观战者直接移除。 */
  disconnected(m: Member, ws: WebSocket): void {
    if (m.ws !== ws) return; // 已被新连接接管
    m.ws = null;
    m.online = false;
    if (m.actor) m.actor.online = false;
    log('disconnect', { room: this.code, id: m.id });
    if (m.role === 'spectator') {
      this.remove(m, 'spectator-left');
      return;
    }
    m.graceTimer = setTimeout(() => this.remove(m, 'grace-expired'), GRACE_MS);
    this.electHost();
    this.broadcastLobby();
  }

  remove(m: Member, reason: string): void {
    if (!this.members.has(m.id)) return;
    if (m.graceTimer) clearTimeout(m.graceTimer);
    this.unseat(m);
    this.members.delete(m.id);
    if (m.ws) {
      try {
        m.ws.close(CLOSE.NORMAL, reason);
      } catch { /* ignore */ }
    }
    log('leave', { room: this.code, id: m.id, reason });
    if (this.phase === 'lobby') this.fillSeats();
    this.electHost();
    this.broadcastLobby();
  }

  private electHost(): void {
    const online = [...this.members.values()].filter((m) => m.online).sort((a, b) => a.joinedAt - b.joinedAt);
    const players = online.filter((m) => m.role === 'player');
    const cur = this.members.get(this.hostId);
    if (cur && cur.online && (cur.role === 'player' || players.length === 0)) return;
    this.hostId = (players[0] ?? online[0])?.id ?? 0;
  }

  /** 有空位时让观战者按加入顺序入座。 */
  private fillSeats(): void {
    const specs = [...this.members.values()]
      .filter((m) => m.role === 'spectator' && m.online)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    for (const s of specs) {
      if (this.seatedPlayers().length >= MAX_PLAYERS) break;
      this.seat(s);
    }
  }

  // ------------------------------------------------------------------ 命令

  handleControl(m: Member, msg: ControlMsg): void {
    switch (msg.t) {
      case 'ping':
        this.send(m, { t: 'pong', t0: msg.t0, ts: serverNow() });
        return;
      case 'leave':
        this.remove(m, 'left');
        return;
      case 'ready':
        if (this.phase !== 'lobby' || m.role !== 'player') return;
        m.ready = msg.r;
        this.broadcastLobby();
        return;
      case 'team': {
        if (this.phase !== 'lobby' || m.role !== 'player' || m.team === msg.team) return;
        if (this.teamCount(msg.team) >= TEAM_MAX) return this.err(m, 'team-full', '该队伍已满');
        this.unseat(m);
        this.seat(m, msg.team);
        if (m.actor) this.world.placeAtSpawn(m.actor);
        this.broadcastLobby();
        return;
      }
      case 'set':
        if (this.phase !== 'lobby' || m.id !== this.hostId) return;
        this.roundSec = msg.roundSec;
        this.broadcastLobby();
        return;
      case 'start': {
        if (this.phase !== 'lobby') return;
        if (m.id !== this.hostId) return this.err(m, 'not-host', '只有房主可以开始游戏');
        const problem = this.startProblem();
        if (problem) return this.err(m, 'cannot-start', problem);
        this.beginCountdown();
        return;
      }
      case 'again':
        if (this.phase !== 'results' || m.role !== 'player') return;
        m.again = true;
        this.broadcastLobby();
        this.checkRematch();
        return;
    }
  }

  startProblem(): string | null {
    const ps = this.seatedPlayers().filter((p) => p.online);
    if (!ps.some((p) => p.team === 0) || !ps.some((p) => p.team === 1)) return '两队都至少需要一名在线玩家';
    const notReady = ps.filter((p) => p.id !== this.hostId && !p.ready);
    if (notReady.length) return `还有玩家未准备：${notReady.map((p) => p.name).join('、')}`;
    return null;
  }

  handleInputs(m: Member, frames: InputFrame[]): void {
    if (m.actor) this.world.pushInputs(m.actor, frames);
  }

  // ------------------------------------------------------------------ 阶段

  private beginCountdown(): void {
    this.fillSeats();
    this.matchNo++;
    this.phase = 'countdown';
    this.world.frozen = true;
    this.world.updateHandicap();
    this.world.resetForMatch();
    const cd = this.opts.countdownMsOverride ?? COUNTDOWN_MS;
    const roundMs = (this.opts.roundSecOverride ?? this.roundSec) * 1000;
    this.startAt = serverNow() + cd;
    this.endAt = this.startAt + roundMs;
    this.teamGoneSince = [0, 0];
    for (const m of this.members.values()) {
      m.again = false;
      m.ready = false;
    }
    log('countdown', { room: this.code, match: this.matchNo, players: this.seatedPlayers().length });
    this.broadcast({ t: 'cd', startAt: this.startAt, endAt: this.endAt, roundSec: this.roundSec, matchNo: this.matchNo, grid: bytesToBase64(this.world.grid.cells) });
    this.broadcastLobby();
  }

  private finish(reason: 'time' | 'forfeit', forfeitTeam = -1): void {
    this.phase = 'results';
    this.world.frozen = true;
    const cells: [number, number] = [this.world.grid.counts[0], this.world.grid.counts[1]];
    const pct: [number, number] = [
      Math.round((cells[0] / PAINTABLE_COUNT) * 1000) / 10,
      Math.round((cells[1] / PAINTABLE_COUNT) * 1000) / 10,
    ];
    let winner = cells[0] === cells[1] ? -1 : cells[0] > cells[1] ? 0 : 1;
    if (reason === 'forfeit') winner = 1 - forfeitTeam;
    if (winner >= 0) this.wins[winner]++;
    const stats = this.seatedPlayers().map((m) => ({
      id: m.id, name: m.name, team: m.team,
      paint: m.actor?.stats.paint ?? 0, splats: m.actor?.stats.splats ?? 0, deaths: m.actor?.stats.deaths ?? 0,
    }));
    this.resultsUntil = serverNow() + (this.opts.resultsMsOverride ?? RESULTS_MS);
    this.lastResult = {
      t: 'result', cells, pct, winner, reason, stats, wins: [...this.wins] as [number, number],
      until: this.resultsUntil, matchNo: this.matchNo,
    };
    log('result', { room: this.code, match: this.matchNo, pct, winner, reason });
    this.broadcastSnapshot();
    this.broadcast(this.lastResult);
    this.broadcastLobby();
  }

  private checkRematch(): void {
    const ps = this.seatedPlayers().filter((p) => p.online);
    if (ps.length > 0 && ps.every((p) => p.again) && !this.startProblemIgnoringReady()) this.beginCountdown();
  }

  private startProblemIgnoringReady(): boolean {
    const ps = this.seatedPlayers().filter((p) => p.online);
    return !ps.some((p) => p.team === 0) || !ps.some((p) => p.team === 1);
  }

  private backToLobby(): void {
    this.phase = 'lobby';
    this.world.frozen = false;
    for (const m of this.members.values()) {
      m.ready = m.again;
      m.again = false;
    }
    this.fillSeats();
    this.electHost();
    log('lobby', { room: this.code });
    this.broadcastLobby();
  }

  // ------------------------------------------------------------------ 循环

  private update(): void {
    if (this.destroyed) return;
    const now = serverNow();
    this.acc += Math.min(250, now - this.lastTime);
    this.lastTime = now;

    // 阶段切换
    if (this.phase === 'countdown' && now >= this.startAt) {
      this.phase = 'playing';
      this.world.frozen = false;
      this.broadcastLobby();
    } else if (this.phase === 'playing') {
      if (now >= this.endAt) this.finish('time');
      else this.checkForfeit(now);
    } else if (this.phase === 'results' && now >= this.resultsUntil) {
      this.backToLobby();
    }

    // 固定步长模拟
    const stepMs = DT * 1000;
    let steps = 0;
    while (this.acc >= stepMs && steps < MAX_CATCHUP_STEPS) {
      this.world.step();
      this.acc -= stepMs;
      steps++;
      if (this.world.tick % SNAPSHOT_EVERY === 0) this.broadcastSnapshot();
    }
    if (steps >= MAX_CATCHUP_STEPS) this.acc = 0;

    // 空房间回收
    const anyOnline = [...this.members.values()].some((m) => m.online);
    if (!anyOnline) {
      if (!this.emptySince) this.emptySince = now;
      else if (now - this.emptySince > EMPTY_ROOM_MS || this.members.size === 0) this.destroy();
    } else this.emptySince = 0;
  }

  private checkForfeit(now: number): void {
    for (let t = 0; t < 2; t++) {
      const online = this.seatedPlayers().some((p) => p.team === t && p.online);
      if (online) this.teamGoneSince[t] = 0;
      else if (!this.teamGoneSince[t]) this.teamGoneSince[t] = now;
    }
    const gone0 = this.teamGoneSince[0] && now - this.teamGoneSince[0] >= FORFEIT_MS;
    const gone1 = this.teamGoneSince[1] && now - this.teamGoneSince[1] >= FORFEIT_MS;
    // 两队都已全员离线：不按掉线先后判负，按当前涂地面积结算
    if ((gone0 && this.teamGoneSince[1]) || (gone1 && this.teamGoneSince[0])) this.finish('time');
    else if (gone0) this.finish('forfeit', 0);
    else if (gone1) this.finish('forfeit', 1);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.loop) clearInterval(this.loop);
    for (const m of this.members.values()) {
      if (m.graceTimer) clearTimeout(m.graceTimer);
      if (m.ws) {
        try {
          m.ws.close(CLOSE.SHUTDOWN, 'room-closed');
        } catch { /* ignore */ }
      }
    }
    log('room-destroyed', { room: this.code });
    this.onDestroy(this);
  }

  // ------------------------------------------------------------------ 发送

  private send(m: Member, msg: object): void {
    const ws = m.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: object): void {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) {
      if (m.ws && m.ws.readyState === m.ws.OPEN) m.ws.send(data);
    }
  }

  private err(m: Member, code: string, msg: string): void {
    this.send(m, { t: 'err', code, msg });
  }

  private sendWelcome(m: Member): void {
    this.send(m, {
      t: 'welcome', v: PROTOCOL_VERSION, room: this.code, me: m.id, tok: m.tok, phase: this.phase,
      grid: bytesToBase64(this.world.grid.cells), tick: this.world.tick, st: serverNow(), lan: this.opts.lanUrls(),
    });
  }

  lobbyState(): LobbyMsg {
    const players: LobbyPlayer[] = [...this.members.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((m) => ({
        id: m.id, name: m.name, team: m.team, slot: m.slot, ready: m.ready, online: m.online, role: m.role, again: m.again,
      }));
    return {
      t: 'lobby', room: this.code, phase: this.phase, host: this.hostId, roundSec: this.roundSec,
      players, wins: this.wins, matchNo: this.matchNo,
    };
  }

  broadcastLobby(): void {
    this.broadcast(this.lobbyState());
  }

  private broadcastSnapshot(): void {
    const ack: Record<string, number> = {};
    for (const a of this.world.actors.values()) ack[a.id] = a.lastSeq;
    const left = this.phase === 'playing' ? Math.max(0, this.endAt - serverNow())
      : this.phase === 'countdown' ? (this.opts.roundSecOverride ?? this.roundSec) * 1000 : 0;
    const snap: SnapshotMsg = {
      t: 's', k: this.world.tick, st: serverNow(), ph: this.phase, left: Math.round(left), ack,
      p: this.world.snapshotPlayers(), d: this.world.grid.flushDeltas(), ev: this.world.events,
    };
    this.world.events = [];
    const data = JSON.stringify(snap);
    for (const m of this.members.values()) {
      const ws = m.ws;
      if (!ws || ws.readyState !== ws.OPEN) continue;
      // 慢客户端保护：发送缓冲过大时直接断开，让其重连拿完整状态（增量不能丢）
      if (ws.bufferedAmount > 512 * 1024) {
        try {
          ws.close(CLOSE.RATE, 'slow-consumer');
        } catch { /* ignore */ }
        continue;
      }
      ws.send(data);
    }
  }

  listing() {
    const host = this.members.get(this.hostId);
    const players = this.seatedPlayers().length;
    return {
      code: this.code, host: host?.name ?? '', players, spectators: this.members.size - players, phase: this.phase,
    };
  }
}
