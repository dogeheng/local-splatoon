import * as THREE from 'three';
import {
  ARENA_H, ARENA_W, BOMB_COST, BOMB_MIN_RANGE, BOMB_RANGE, BTN_BOMB, BTN_FIRE, BTN_SPECIAL, BTN_SWIM,
  DT, F_DEAD, F_FIRING, F_HANDICAP, F_INKED, F_OFFLINE, F_PROTECT, F_SPECIAL, F_SWIM, LAST_MINUTE_SEC,
  PLAYER_RADIUS, TICK_HZ, teamPaint,
} from '../../../shared/constants';
import { SPAWNS, cellAt, resolveCircle } from '../../../shared/arena';
import { PaintGrid } from '../../../shared/paint';
import { aimToRad, base64ToBytes, clamp, radToAim } from '../../../shared/math';
import { type InputFrame, type PlayerSim, copySim, stepPlayer, traceShot } from '../../../shared/sim';
import type {
  CountdownMsg, GameEvent, LobbyMsg, Phase, ResultMsg, Role, SnapPlayer, SnapshotMsg, WelcomeMsg,
} from '../../../shared/protocol';
import { Scene3D } from './scene';
import { Effects } from './fx';
import { CharacterView, type CharState } from './characters';
import { Controls } from './input';
import type { Sfx } from '../audio/sfx';
import type { Net } from '../net/connection';

const STEP_MS = DT * 1000;
const TICK_MS = 1000 / TICK_HZ;

interface PState {
  id: number;
  team: number;
  x: number; z: number; vx: number; vz: number;
  flags: number; hp: number; ink: number; gauge: number; aim: number; extra: number;
  snapAt: number;
  rx: number; rz: number;
  view: CharacterView | null;
  tag: HTMLDivElement | null;
  tagName: HTMLSpanElement | null;
  tagHp: HTMLElement | null;
}

export interface GameHooks {
  onKill: (by: { name: string; team: number } | null, victim: { name: string; team: number }) => void;
  onBanner: (text: string, kind?: 'big' | 'small') => void;
  onPhase: (phase: Phase, prev: Phase) => void;
}

export interface MeInfo {
  ink: number; gauge: number; hp: number; dead: boolean; respawnS: number; special: boolean; specialS: number; handicap: boolean;
}

export class GameClient {
  readonly scene: Scene3D;
  readonly fx: Effects;
  readonly controls: Controls;
  readonly grid = new PaintGrid();
  inRoom = false;
  me = 0;
  myTeam = -1;
  role: Role = 'spectator';
  phase: Phase = 'lobby';
  lobby: LobbyMsg | null = null;
  readonly players = new Map<number, PState>();

  // 预测
  private pred: PlayerSim | null = null;
  private pending: InputFrame[] = [];
  private outbox: InputFrame[] = [];
  private seq = 0;
  private awaitingAck = true;
  private acc = 0;
  private visOff = { x: 0, z: 0 };
  private predShots = new Map<number, number>();
  private ownShotIds = new Map<number, number>();
  private lastFlush = 0;
  private aimPoint = new THREE.Vector3(ARENA_W / 2, 0, ARENA_H / 2);

  // 时间
  startAt = 0;
  endAt = 0;
  roundSec = 180;
  private leftMs = 0;
  private lastBeep = 0;
  private lastMinuteShown = false;

  // 调试
  private lastSnapRecv = 0;
  snapGap = 0;
  lastCorrection = 0;
  maxCorrection = 0;
  fps = 0;

  // 首页演示
  private demoT = 0;
  private time = 0;

  constructor(canvas: HTMLCanvasElement, private labels: HTMLElement, private sfx: Sfx, readonly net: Net, private hooks: GameHooks) {
    this.scene = new Scene3D(canvas);
    this.fx = new Effects(this.scene.scene, this.scene.gradientMap);
    this.controls = new Controls(canvas);
    this.fx.onBombLand = () => this.sfx.play('land', { vol: 2 });
    this.scene.writePaint(this.grid.cells);
  }

  // ================================================================ 房间进出

  enterRoom(w: WelcomeMsg): void {
    this.inRoom = true;
    this.me = w.me;
    this.grid.loadFull(base64ToBytes(w.grid));
    this.scene.writePaint(this.grid.cells);
    this.clearPlayers();
    this.fx.clear();
    this.pred = null;
    this.pending = [];
    this.outbox = [];
    this.awaitingAck = true;
    this.predShots.clear();
    this.ownShotIds.clear();
    const prev = this.phase;
    this.phase = w.phase;
    if (prev !== w.phase) this.hooks.onPhase(w.phase, prev);
    this.updateMusic();
  }

  leaveRoom(): void {
    this.inRoom = false;
    this.lobby = null;
    this.clearPlayers();
    this.fx.clear();
    this.grid.reset();
    this.scene.writePaint(this.grid.cells);
    this.phase = 'lobby';
    this.myTeam = -1;
    this.role = 'spectator';
    this.updateMusic();
  }

  private clearPlayers(): void {
    for (const p of this.players.values()) this.dropView(p);
    this.players.clear();
  }

  private dropView(p: PState): void {
    if (p.view) {
      this.scene.scene.remove(p.view.group);
      p.view.dispose();
      p.view = null;
    }
    p.tag?.remove();
    p.tag = null;
  }

  // ================================================================ 服务器消息

  onLobby(l: LobbyMsg): void {
    const prevJoined = new Set(this.lobby?.players.map((p) => p.id) ?? []);
    this.lobby = l;
    const mine = l.players.find((p) => p.id === this.me);
    const role = mine?.role ?? 'spectator';
    const team = mine?.team ?? -1;
    if (role !== this.role || team !== this.myTeam) {
      this.awaitingAck = true;
      this.pred = null;
      this.pending = [];
    }
    this.role = role;
    this.myTeam = team;
    this.roundSec = l.roundSec;
    for (const p of l.players) if (prevJoined.size && !prevJoined.has(p.id)) this.sfx.play('join');
    // 队伍变化时重建角色模型
    for (const st of this.players.values()) {
      const lp = l.players.find((x) => x.id === st.id);
      if (!lp || lp.role !== 'player') {
        this.dropView(st);
        this.players.delete(st.id);
      } else if (lp.team !== st.team) {
        this.dropView(st);
        st.team = lp.team;
      }
    }
    this.setPhase(l.phase);
  }

  onCountdown(c: CountdownMsg): void {
    this.grid.loadFull(base64ToBytes(c.grid));
    this.scene.writePaint(this.grid.cells);
    this.fx.clear();
    this.startAt = c.startAt;
    this.endAt = c.endAt;
    this.roundSec = c.roundSec;
    this.lastBeep = 0;
    this.lastMinuteShown = false;
    this.maxCorrection = 0;
    if (this.net.clock.serverNow() < c.startAt) this.setPhase('countdown');
  }

  onResult(_r: ResultMsg): void {
    this.setPhase('results');
  }

  private setPhase(ph: Phase): void {
    if (ph === this.phase) return;
    const prev = this.phase;
    this.phase = ph;
    if (ph === 'playing' && prev === 'countdown') {
      this.sfx.play('go');
      this.hooks.onBanner('开始！');
    }
    if (ph === 'results') {
      this.sfx.play('whistle');
      this.hooks.onBanner('结束！');
      this.controls.clear();
    }
    this.updateMusic();
    this.hooks.onPhase(ph, prev);
  }

  updateMusic(): void {
    if (!this.inRoom || this.phase === 'lobby') this.sfx.music('lobby');
    else if (this.phase === 'countdown' || this.phase === 'playing') {
      const left = this.timeLeftMs();
      this.sfx.music('battle', this.phase === 'playing' && left !== null && left <= LAST_MINUTE_SEC * 1000 ? 1.1 : 1);
    }
  }

  private teamOf(id: number): number {
    return this.lobby?.players.find((p) => p.id === id)?.team ?? -1;
  }

  nameOf(id: number): string {
    return this.lobby?.players.find((p) => p.id === id)?.name ?? '？';
  }

  onSnapshot(s: SnapshotMsg): void {
    const now = performance.now();
    if (this.lastSnapRecv) this.snapGap = this.snapGap * 0.8 + (now - this.lastSnapRecv) * 0.2;
    this.lastSnapRecv = now;
    this.leftMs = s.left;
    if (s.d.length) {
      this.grid.applyDeltas(s.d);
      this.scene.writePaint(this.grid.cells, s.d.map((c) => Math.abs(c) - 1));
    }
    const seen = new Set<number>();
    for (const p of s.p) {
      const id = p[0];
      seen.add(id);
      let st = this.players.get(id);
      const team = this.teamOf(id);
      if (team < 0) continue;
      if (!st) {
        st = {
          id, team, x: p[1], z: p[2], vx: 0, vz: 0, flags: 0, hp: 100, ink: 100, gauge: 0, aim: 0, extra: 0,
          snapAt: s.st, rx: p[1], rz: p[2], view: null, tag: null, tagName: null, tagHp: null,
        };
        this.players.set(id, st);
      }
      const wasDead = (st.flags & F_DEAD) !== 0;
      st.team = team;
      st.x = p[1]; st.z = p[2]; st.vx = p[3]; st.vz = p[4];
      st.flags = p[5]; st.hp = p[6]; st.ink = p[7]; st.gauge = p[8]; st.aim = aimToRad(p[9]); st.extra = p[12];
      st.snapAt = s.st;
      if (wasDead && !(st.flags & F_DEAD)) {
        st.rx = st.x;
        st.rz = st.z;
      }
      if (id === this.me && this.role === 'player') this.reconcile(p, s.ack[id] ?? 0);
    }
    for (const [id, st] of this.players) {
      if (!seen.has(id)) {
        this.dropView(st);
        this.players.delete(id);
      }
    }
    for (const ev of s.ev) this.handleEvent(ev, s);
    this.setPhase(s.ph);
  }

  private simEnv(flags: number) {
    return {
      team: this.myTeam,
      seat: this.me,
      handicap: (flags & F_HANDICAP) !== 0,
      special: (flags & F_SPECIAL) !== 0,
      paintAt: (x: number, z: number) => cellAt(this.grid.cells, x, z),
    };
  }

  /** 服务器校正：以权威状态为起点重放未确认输入，误差转为视觉偏移逐渐淡出。 */
  private reconcile(p: SnapPlayer, ack: number): void {
    const server: PlayerSim = {
      x: p[1], z: p[2], vx: p[3], vz: p[4], ink: p[7], fireCd: p[10], sinceShot: p[11], swim: (p[5] & F_SWIM) !== 0,
    };
    if (this.awaitingAck || !this.pred) {
      this.seq = Math.max(this.seq, ack);
      this.awaitingAck = false;
      this.pending = [];
      this.pred = server;
      this.visOff = { x: 0, z: 0 };
      return;
    }
    this.pending = this.pending.filter((f) => f.seq > ack);
    const dispX = this.pred.x + this.visOff.x;
    const dispZ = this.pred.z + this.visOff.z;
    if (p[5] & F_DEAD) {
      this.pred = server;
      this.visOff = { x: 0, z: 0 };
      return;
    }
    const sim = copySim(server);
    const env = this.simEnv(p[5]);
    for (const f of this.pending) stepPlayer(sim, f, env);
    this.lastCorrection = Math.hypot(this.pred.x - sim.x, this.pred.z - sim.z);
    if (this.phase === 'playing') this.maxCorrection = Math.max(this.maxCorrection, this.lastCorrection);
    const ex = dispX - sim.x;
    const ez = dispZ - sim.z;
    this.pred = sim;
    if (Math.hypot(ex, ez) > 2.5) this.visOff = { x: 0, z: 0 };
    else this.visOff = { x: ex, z: ez };
  }

  private evLocalSec(s: SnapshotMsg, tick: number): number {
    const serverMs = s.st + (tick - s.k) * TICK_MS;
    return (serverMs - this.net.clock.offset) / 1000;
  }

  private panOf(x: number): number {
    return ((x - ARENA_W / 2) / (ARENA_W / 2)) * 0.7;
  }

  private volOf(x: number, z: number): number {
    const m = this.myPos();
    if (!m) return 0.8;
    const d = Math.hypot(x - m.x, z - m.z);
    return clamp(1.2 - d / 26, 0.25, 1);
  }

  private handleEvent(ev: GameEvent, s: SnapshotMsg): void {
    const nowS = performance.now() / 1000;
    switch (ev.e) {
      case 'shot': {
        const team = this.teamOf(ev.o);
        if (team < 0) return;
        if (ev.o === this.me && this.role === 'player') {
          const n = this.predShots.get(ev.seq) ?? 0;
          if (n > 0) {
            // 已在本地预测显示过
            if (n === 1) this.predShots.delete(ev.seq);
            else this.predShots.set(ev.seq, n - 1);
            this.ownShotIds.set(ev.id, -ev.seq);
            return;
          }
        }
        const path = traceShot(ev.x, ev.z, ev.a, team);
        const age = clamp(nowS - this.evLocalSec(s, ev.k), 0, 0.3);
        this.fx.shot(ev.id, team, path.x0, path.z0, ev.a, path.len, nowS, age, ev.sp === 1);
        this.players.get(ev.o)?.view?.onShoot();
        this.sfx.play('shotOther', { pan: this.panOf(ev.x), vol: this.volOf(ev.x, ev.z) });
        break;
      }
      case 'hit': {
        const local = this.ownShotIds.get(ev.id);
        const fid = local ?? ev.id;
        this.fx.killShot((p) => p.id === fid);
        if (ev.o === this.me) this.sfx.play('hit');
        if (ev.v === this.me) {
          this.sfx.play('hurt');
          this.scene.addShake(0.12);
        }
        break;
      }
      case 'bomb': {
        const team = this.teamOf(ev.o);
        if (team < 0) return;
        this.fx.bomb(ev.id, team, ev.x, ev.z, ev.tx, ev.tz, this.evLocalSec(s, ev.k), this.evLocalSec(s, ev.land), this.evLocalSec(s, ev.boom));
        this.sfx.play('throw', { pan: this.panOf(ev.x), vol: this.volOf(ev.x, ev.z) });
        break;
      }
      case 'boom': {
        const team = this.teamOf(ev.o);
        this.fx.boom(ev.id, ev.x, ev.z, team < 0 ? 0 : team);
        const v = this.volOf(ev.x, ev.z);
        this.sfx.play('boom', { pan: this.panOf(ev.x), vol: v });
        this.scene.addShake(0.12 + 0.3 * v);
        break;
      }
      case 'splat': {
        const vt = this.teamOf(ev.v);
        const color = vt < 0 ? 0 : 1 - vt;
        this.fx.splash(ev.x, 0.5, ev.z, color, 60, 6, 1.5);
        this.fx.ring(ev.x, ev.z, color, 0.3, 2.4, 0.5);
        this.sfx.play('splat', { pan: this.panOf(ev.x), vol: ev.v === this.me || ev.by === this.me ? 1.2 : this.volOf(ev.x, ev.z) });
        if (ev.v === this.me || ev.by === this.me) this.scene.addShake(0.35);
        this.hooks.onKill(
          ev.by ? { name: this.nameOf(ev.by), team: this.teamOf(ev.by) } : null,
          { name: this.nameOf(ev.v), team: vt },
        );
        break;
      }
      case 'special': {
        const team = this.teamOf(ev.o);
        this.fx.ring(ev.x, ev.z, 'lime', 0.4, 3.6, 0.55);
        this.fx.splash(ev.x, 0.4, ev.z, team < 0 ? 0 : team, 90, 8, 1.4);
        this.sfx.play('special', { pan: this.panOf(ev.x) });
        this.scene.addShake(0.3);
        if (ev.o === this.me) this.hooks.onBanner('墨潮！', 'small');
        break;
      }
      case 'respawn': {
        const team = this.teamOf(ev.v);
        this.fx.ring(ev.x, ev.z, team < 0 ? 0 : team, 0.2, 1.6, 0.45);
        if (ev.v === this.me) this.sfx.play('respawn');
        break;
      }
    }
  }

  // ================================================================ 本地输入步

  private myPos(): { x: number; z: number } | null {
    if (this.pred && this.role === 'player') return { x: this.pred.x + this.visOff.x, z: this.pred.z + this.visOff.z };
    return null;
  }

  private localStep(): void {
    if (!this.pred || this.awaitingAck || this.role !== 'player' || this.myTeam < 0) return;
    const meS = this.players.get(this.me);
    const flags = meS?.flags ?? 0;
    const dead = (flags & F_DEAD) !== 0;
    const frozen = this.phase === 'countdown' || this.phase === 'results';
    const pos = this.myPos()!;
    const dx = this.aimPoint.x - pos.x;
    const dz = this.aimPoint.z - pos.z;
    let { mx, mz } = this.controls.move();
    let btn = 0;
    if (this.controls.firing()) btn |= BTN_FIRE;
    if (this.controls.swimHeld()) btn |= BTN_SWIM;
    if (this.controls.consumeBomb()) btn |= BTN_BOMB;
    if (this.controls.consumeSpecial()) btn |= BTN_SPECIAL;
    if (frozen || dead) {
      mx = 0;
      mz = 0;
      btn = 0;
    }
    const f: InputFrame = {
      seq: ++this.seq, mx, mz,
      aim: radToAim(Math.atan2(dz, dx)),
      dist: clamp(Math.round(Math.hypot(dx, dz) * 10), 0, 100),
      btn,
    };
    this.pending.push(f);
    this.outbox.push(f);
    if (this.pending.length > 300) this.pending.splice(0, this.pending.length - 300);
    if (!dead) {
      const res = stepPlayer(this.pred, f, this.simEnv(flags));
      if (res.shot) {
        const path = traceShot(res.shot.x, res.shot.z, res.shot.angle, this.myTeam);
        const nowS = performance.now() / 1000;
        this.fx.shot(-res.shot.seq, this.myTeam, path.x0, path.z0, res.shot.angle, path.len, nowS, 0, (flags & F_SPECIAL) !== 0,
          () => this.sfx.play('land', { pan: this.panOf(path.x0) }));
        this.predShots.set(res.shot.seq, (this.predShots.get(res.shot.seq) ?? 0) + 1);
        if (this.predShots.size > 200) this.predShots.clear();
        if (this.ownShotIds.size > 400) this.ownShotIds.clear();
        meS?.view?.onShoot();
        this.sfx.play('shot', { pan: this.panOf(pos.x) });
      }
    }
    if (this.outbox.length >= 2 || (btn & (BTN_BOMB | BTN_SPECIAL)) !== 0) this.flush();
  }

  private flush(): void {
    if (!this.outbox.length) return;
    while (this.outbox.length) {
      const chunk = this.outbox.splice(0, 6);
      this.net.send({ t: 'in', s: chunk.map((f) => [f.seq, f.mx, f.mz, f.aim, f.dist, f.btn]) });
    }
    this.lastFlush = performance.now();
  }

  // ================================================================ 每帧

  timeLeftMs(): number | null {
    if (this.phase === 'playing') return Math.max(0, this.endAt - this.net.clock.serverNow());
    if (this.phase === 'countdown') return this.roundSec * 1000;
    if (this.phase === 'results') return 0;
    return null;
  }

  countdownLeftMs(): number {
    return Math.max(0, this.startAt - this.net.clock.serverNow());
  }

  frame(dtMs: number): void {
    const dt = Math.min(0.1, dtMs / 1000);
    this.time += dt;
    this.fps = this.fps * 0.95 + (1000 / Math.max(1, dtMs)) * 0.05;
    this.net.clock.tick(dtMs);
    const gp = this.scene.screenToGround(this.controls.mouseX, this.controls.mouseY, 0);
    if (gp) this.aimPoint.copy(gp);

    if (this.inRoom) {
      this.acc += dtMs;
      let n = 0;
      while (this.acc >= STEP_MS && n < 5) {
        this.localStep();
        this.acc -= STEP_MS;
        n++;
      }
      if (n >= 5) this.acc = 0;
      if (this.outbox.length && performance.now() - this.lastFlush > 40) this.flush();
      this.updateTimers();
      this.updateVisuals(dt);
    } else {
      this.demo(dt);
      this.fx.reticle.visible = false;
      this.fx.showBombPreview(false);
    }
    this.fx.update(dt);
    this.scene.render(dt, this.time);
  }

  private updateTimers(): void {
    if (this.phase === 'countdown') {
      const n = Math.ceil(this.countdownLeftMs() / 1000);
      if (n !== this.lastBeep && n >= 1 && n <= 3) {
        this.lastBeep = n;
        this.sfx.play('beep');
        this.hooks.onBanner(String(n));
      }
    }
    if (this.phase === 'playing' && !this.lastMinuteShown && this.roundSec > LAST_MINUTE_SEC) {
      const left = this.timeLeftMs() ?? 999999;
      if (left <= LAST_MINUTE_SEC * 1000 && left > 0) {
        this.lastMinuteShown = true;
        this.hooks.onBanner('最后一分钟！', 'small');
        this.sfx.play('lastMinute');
        this.updateMusic();
      }
    }
  }

  private updateVisuals(dt: number): void {
    const k = Math.exp(-dt * 10);
    this.visOff.x *= k;
    this.visOff.z *= k;
    const serverNow = this.net.clock.serverNow();

    for (const st of this.players.values()) {
      if (!st.view) {
        st.view = new CharacterView(st.team, this.scene.gradientMap, st.id === this.me);
        this.scene.scene.add(st.view.group);
      }
      const isMe = st.id === this.me && this.role === 'player' && this.pred;
      let cs: CharState;
      if (isMe && this.pred) {
        const x = this.pred.x + this.visOff.x;
        const z = this.pred.z + this.visOff.z;
        st.rx = x;
        st.rz = z;
        const swim = this.pred.swim;
        cs = {
          x, z, vx: this.pred.vx, vz: this.pred.vz,
          aim: Math.atan2(this.aimPoint.z - z, this.aimPoint.x - x),
          swim, inked: swim && cellAt(this.grid.cells, this.pred.x, this.pred.z) === teamPaint(this.myTeam),
          dead: (st.flags & F_DEAD) !== 0, protect: (st.flags & F_PROTECT) !== 0, special: (st.flags & F_SPECIAL) !== 0,
          firing: this.controls.firing() && !swim, offline: false, ink: this.pred.ink, hp: st.hp,
        };
      } else {
        const age = clamp((serverNow - st.snapAt) / 1000, 0, 0.12);
        const t = { x: st.x + st.vx * age, z: st.z + st.vz * age };
        resolveCircle(t, PLAYER_RADIUS, 1 - st.team);
        if (Math.hypot(t.x - st.rx, t.z - st.rz) > 3) {
          st.rx = t.x;
          st.rz = t.z;
        } else {
          const a = Math.min(1, dt * 18);
          st.rx += (t.x - st.rx) * a;
          st.rz += (t.z - st.rz) * a;
        }
        cs = {
          x: st.rx, z: st.rz, vx: st.vx, vz: st.vz, aim: st.aim,
          swim: (st.flags & F_SWIM) !== 0, inked: (st.flags & F_INKED) !== 0, dead: (st.flags & F_DEAD) !== 0,
          protect: (st.flags & F_PROTECT) !== 0, special: (st.flags & F_SPECIAL) !== 0, firing: (st.flags & F_FIRING) !== 0,
          offline: (st.flags & F_OFFLINE) !== 0, ink: st.ink, hp: st.hp,
        };
      }
      st.view.hiddenFromViewer = this.myTeam >= 0 && st.team !== this.myTeam;
      st.view.update(cs, dt);
      this.updateTag(st, cs);
    }

    // 准星与投掷预览
    const meS = this.players.get(this.me);
    const alive = this.role === 'player' && this.pred && meS && !(meS.flags & F_DEAD);
    const active = alive && (this.phase === 'lobby' || this.phase === 'playing');
    this.fx.reticle.visible = !!active;
    this.fx.reticle.position.set(this.aimPoint.x, 0.03, this.aimPoint.z);
    if (active && this.controls.bombHeld && this.pred && this.pred.ink >= BOMB_COST) {
      const pos = this.myPos()!;
      const dx = this.aimPoint.x - pos.x;
      const dz = this.aimPoint.z - pos.z;
      const d = clamp(Math.hypot(dx, dz), BOMB_MIN_RANGE, BOMB_RANGE);
      const ang = Math.atan2(dz, dx);
      const tr = traceShot(pos.x, pos.z, ang, this.myTeam, d);
      const land = Math.max(0, tr.len - (tr.hitWall ? 0.35 : 0));
      this.fx.showBombPreview(true, pos.x, pos.z, tr.x0 + tr.dx * land, tr.z0 + tr.dz * land);
    } else this.fx.showBombPreview(false);
  }

  private updateTag(st: PState, cs: CharState): void {
    const hidden = cs.dead || (cs.inked && st.view?.hiddenFromViewer) || this.phase === 'results';
    if (!st.tag) {
      const tag = document.createElement('div');
      tag.className = `tag t${st.team}${st.id === this.me ? ' me' : ''}`;
      const nm = document.createElement('span');
      const hp = document.createElement('span');
      hp.className = 'hp';
      const bar = document.createElement('i');
      hp.appendChild(bar);
      tag.append(nm, hp);
      this.labels.appendChild(tag);
      st.tag = tag;
      st.tagName = nm;
      st.tagHp = bar;
    }
    const name = st.id === this.me ? '我' : this.nameOf(st.id);
    if (st.tagName!.textContent !== name) st.tagName!.textContent = name;
    if (hidden) {
      st.tag.style.display = 'none';
      return;
    }
    st.tag.style.display = '';
    const p = this.scene.worldToScreen(new THREE.Vector3(cs.x, cs.swim ? 0.7 : 1.3, cs.z));
    st.tag.style.left = `${p.x.toFixed(1)}px`;
    st.tag.style.top = `${p.y.toFixed(1)}px`;
    const hpPct = clamp(cs.hp, 0, 100);
    (st.tagHp!.parentElement as HTMLElement).style.display = hpPct < 100 ? '' : 'none';
    st.tagHp!.style.width = `${hpPct}%`;
  }

  /** 首页背景：随机泼洒颜料。 */
  private demo(dt: number): void {
    this.demoT += dt;
    if (this.demoT < 0.22) return;
    this.demoT = 0;
    const team = Math.random() < 0.5 ? 0 : 1;
    const x = 2 + Math.random() * (ARENA_W - 4);
    const z = 2 + Math.random() * (ARENA_H - 4);
    const r = 0.8 + Math.random() * 2.2;
    this.grid.paintCircle(x, z, r, team, Math.floor(Math.random() * 1e6));
    const d = this.grid.flushDeltas();
    this.scene.writePaint(this.grid.cells, d.map((c) => Math.abs(c) - 1));
    this.fx.splash(x, 0.4, z, team, 14, 4);
    if (this.grid.counts[0] + this.grid.counts[1] > 9000) {
      this.grid.reset();
      this.scene.writePaint(this.grid.cells);
    }
  }

  // ================================================================ HUD 数据

  meInfo(): MeInfo | null {
    if (this.role !== 'player') return null;
    const st = this.players.get(this.me);
    if (!st) return null;
    const dead = (st.flags & F_DEAD) !== 0;
    const special = (st.flags & F_SPECIAL) !== 0;
    return {
      ink: this.pred ? this.pred.ink : st.ink,
      gauge: st.gauge,
      hp: st.hp,
      dead,
      respawnS: dead ? st.extra / TICK_HZ : 0,
      special,
      specialS: special ? st.extra / TICK_HZ : 0,
      handicap: (st.flags & F_HANDICAP) !== 0,
    };
  }

  roster(team: number): { id: number; name: string; dead: boolean; respawnS: number; special: boolean; offline: boolean }[] {
    if (!this.lobby) return [];
    return this.lobby.players
      .filter((p) => p.role === 'player' && p.team === team)
      .sort((a, b) => a.slot - b.slot)
      .map((p) => {
        const st = this.players.get(p.id);
        const f = st?.flags ?? 0;
        return {
          id: p.id, name: p.name, dead: (f & F_DEAD) !== 0, respawnS: (f & F_DEAD) !== 0 ? (st!.extra / TICK_HZ) : 0,
          special: (f & F_SPECIAL) !== 0, offline: !p.online,
        };
      });
  }

  debugText(): string {
    const c = this.net.clock;
    return [
      `FPS        ${this.fps.toFixed(0)}`,
      `RTT        ${c.rtt.toFixed(1)} ms   抖动 ${c.jitter.toFixed(1)} ms`,
      `时钟偏移   ${c.offset.toFixed(0)} ms`,
      `快照间隔   ${this.snapGap.toFixed(1)} ms`,
      `未确认输入 ${this.pending.length}`,
      `校正量     ${this.lastCorrection.toFixed(3)}  (本局最大 ${this.maxCorrection.toFixed(3)})`,
      `视觉偏移   ${Math.hypot(this.visOff.x, this.visOff.z).toFixed(3)}`,
      `玩家       ${this.players.size}   阶段 ${this.phase}`,
      `涂色格     橙 ${this.grid.counts[0]}  青 ${this.grid.counts[1]}`,
    ].join('\n');
  }

  spawnOf(team: number) {
    return SPAWNS[team];
  }
}
