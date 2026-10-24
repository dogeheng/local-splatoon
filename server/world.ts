import {
  BOMB_DMG_R, BOMB_EDGE_DMG, BOMB_FLIGHT_TICKS, BOMB_FUSE_TICKS, BOMB_LETHAL_DMG, BOMB_LETHAL_R,
  BOMB_PAINT_R, BTN_BOMB, BTN_SPECIAL, DEATH_SPLAT_R, DT, ENEMY_INK_DPS, ENEMY_INK_MIN_HP,
  F_DEAD, F_FIRING, F_HANDICAP, F_INKED, F_OFFLINE, F_PROTECT, F_SPECIAL, F_SWIM,
  HANDICAP_RESPAWN_TICKS, HP_MAX, HP_REGEN_DELAY_TICKS, HP_REGEN_PER_S, HP_REGEN_SWIM_PER_S,
  INPUT_QUEUE_KEEP, INPUT_QUEUE_MAX, RESPAWN_TICKS, SHOT_DAMAGE, SHOT_HIT_R, SHOT_SPECIAL_SPLAT_MULT,
  SHOT_SPEED, SHOT_SPLAT_R, SHOT_TRAIL_EVERY, SHOT_TRAIL_R, SPAWN_PREPAINT_R, SPAWN_PROTECT_TICKS,
  SPECIAL_BURST_DMG, SPECIAL_BURST_DMG_R, SPECIAL_BURST_PAINT_R, SPECIAL_COST, SPECIAL_DEATH_KEEP,
  SPECIAL_DURATION_TICKS, BTN_FIRE, teamPaint,
} from '../shared/constants';
import { SPAWNS, cellAt, spawnPoint } from '../shared/arena';
import { PaintGrid } from '../shared/paint';
import { round2, segmentCircle } from '../shared/math';
import {
  type InputFrame, type PlayerSim, type ShotPath, emptyInput, newSim, stepPlayer, traceShot,
} from '../shared/sim';
import type { GameEvent, SnapPlayer } from '../shared/protocol';

export interface Actor {
  id: number;
  team: number;
  slot: number;
  sim: PlayerSim;
  hp: number;
  dead: boolean;
  respawnTick: number;
  protectUntil: number;
  specialUntil: number;
  gauge: number;
  sinceDmg: number;
  inputQ: InputFrame[];
  lastSeq: number;
  lastInput: InputFrame;
  online: boolean;
  handicap: boolean;
  stats: { paint: number; splats: number; deaths: number };
}

interface Shot {
  id: number;
  owner: number;
  team: number;
  path: ShotPath;
  traveled: number;
  nextTrail: number;
  splatR: number;
}

interface Bomb {
  id: number;
  owner: number;
  team: number;
  tx: number;
  tz: number;
  boomTick: number;
}

export class World {
  tick = 0;
  readonly grid = new PaintGrid();
  readonly actors = new Map<number, Actor>();
  private shots: Shot[] = [];
  private bombs: Bomb[] = [];
  events: GameEvent[] = [];
  private nextEntity = 1;
  /** 倒计时与结算阶段为 true：忽略移动与动作输入。 */
  frozen = false;

  addActor(id: number, team: number, slot: number): Actor {
    const sp = spawnPoint(team, slot);
    const a: Actor = {
      id, team, slot,
      sim: newSim(sp.x, sp.z),
      hp: HP_MAX, dead: false, respawnTick: 0, protectUntil: this.tick + SPAWN_PROTECT_TICKS,
      specialUntil: 0, gauge: 0, sinceDmg: 999,
      inputQ: [], lastSeq: 0, lastInput: emptyInput(),
      online: true, handicap: false,
      stats: { paint: 0, splats: 0, deaths: 0 },
    };
    this.actors.set(id, a);
    return a;
  }

  removeActor(id: number): void {
    this.actors.delete(id);
  }

  /** 换队或换位后把角色放回出生点。 */
  placeAtSpawn(a: Actor): void {
    const sp = spawnPoint(a.team, a.slot);
    const keepSeq = a.lastSeq;
    a.sim = newSim(sp.x, sp.z);
    a.hp = HP_MAX;
    a.dead = false;
    a.protectUntil = this.tick + SPAWN_PROTECT_TICKS;
    a.specialUntil = 0;
    a.lastSeq = keepSeq;
  }

  /** 新对局：清空地面、重置所有角色。 */
  resetForMatch(): void {
    this.grid.reset();
    this.shots = [];
    this.bombs = [];
    this.events = [];
    for (let t = 0; t < 2; t++) {
      this.grid.paintCircle(SPAWNS[t].x, SPAWNS[t].z, SPAWN_PREPAINT_R, t, 999, false);
    }
    this.grid.flushDeltas();
    for (const a of this.actors.values()) {
      this.placeAtSpawn(a);
      a.gauge = 0;
      a.stats = { paint: 0, splats: 0, deaths: 0 };
      a.inputQ.length = 0;
    }
  }

  /** 接收一批输入：丢弃重复与过期的序号，限制队列长度。 */
  pushInputs(a: Actor, frames: InputFrame[]): void {
    const tail = a.inputQ.length ? a.inputQ[a.inputQ.length - 1].seq : a.lastSeq;
    for (const f of frames) {
      if (f.seq <= tail || f.seq <= a.lastSeq) continue;
      if (a.inputQ.length && f.seq <= a.inputQ[a.inputQ.length - 1].seq) continue;
      a.inputQ.push(f);
    }
    if (a.inputQ.length > INPUT_QUEUE_MAX) a.inputQ.splice(0, a.inputQ.length - INPUT_QUEUE_KEEP);
  }

  private paint(a: Actor | undefined, x: number, z: number, r: number, team: number, salt: number): void {
    const gained = this.grid.paintCircle(x, z, r, team, salt);
    if (a && a.team === team) {
      a.stats.paint += gained;
      if (this.tick >= a.specialUntil) a.gauge = Math.min(SPECIAL_COST, a.gauge + gained);
    }
  }

  private damage(victim: Actor, amount: number, by: Actor | undefined): void {
    // 离线（等待重连）的玩家免伤，避免被对手反复刷击倒
    if (victim.dead || !victim.online || this.tick < victim.protectUntil) return;
    victim.hp -= amount;
    victim.sinceDmg = 0;
    if (victim.hp <= 0) this.splat(victim, by);
  }

  private splat(v: Actor, by: Actor | undefined): void {
    v.hp = 0;
    v.dead = true;
    v.respawnTick = this.tick + (v.handicap ? HANDICAP_RESPAWN_TICKS : RESPAWN_TICKS);
    v.gauge = Math.floor(v.gauge * SPECIAL_DEATH_KEEP);
    v.specialUntil = 0;
    v.sim.vx = 0;
    v.sim.vz = 0;
    v.stats.deaths++;
    const team = by ? by.team : 1 - v.team;
    if (by) by.stats.splats++;
    this.paint(by, v.sim.x, v.sim.z, DEATH_SPLAT_R, team, this.nextEntity++);
    this.events.push({ e: 'splat', v: v.id, by: by ? by.id : 0, x: round2(v.sim.x), z: round2(v.sim.z) });
  }

  step(): void {
    this.tick++;
    const paintAt = (x: number, z: number) => cellAt(this.grid.cells, x, z);

    // ---- 1. 输入与移动 ----
    for (const a of this.actors.values()) {
      let inp = a.inputQ.shift();
      if (inp) {
        a.lastSeq = inp.seq;
        a.lastInput = inp;
      } else {
        // 没有新输入：沿用上一条（保持方向），但不重复触发边沿动作
        inp = { ...a.lastInput, btn: a.lastInput.btn & ~(BTN_BOMB | BTN_SPECIAL) };
        if (!a.online) inp = { ...emptyInput(a.lastSeq), aim: a.lastInput.aim };
      }
      if (this.frozen) inp = { ...emptyInput(inp.seq), aim: inp.aim };

      if (a.dead) {
        if (this.tick >= a.respawnTick && !this.frozen) {
          this.placeAtSpawn(a);
          this.events.push({ e: 'respawn', v: a.id, x: round2(a.sim.x), z: round2(a.sim.z) });
        }
        continue;
      }

      const special = this.tick < a.specialUntil;
      const res = stepPlayer(a.sim, inp, { team: a.team, seat: a.id, handicap: a.handicap, special, paintAt });

      if (res.shot) {
        const path = traceShot(res.shot.x, res.shot.z, res.shot.angle, a.team);
        const id = this.nextEntity++;
        this.shots.push({
          id, owner: a.id, team: a.team, path, traveled: 0, nextTrail: 0.9,
          splatR: SHOT_SPLAT_R * (special ? SHOT_SPECIAL_SPLAT_MULT : 1),
        });
        this.events.push({
          e: 'shot', id, o: a.id, x: round2(res.shot.x), z: round2(res.shot.z),
          a: Math.round(res.shot.angle * 10000) / 10000, sp: special ? 1 : 0, k: this.tick, seq: res.shot.seq,
        });
      }
      if (res.bomb) {
        const tr = traceShot(a.sim.x, a.sim.z, res.bomb.angle, a.team, res.bomb.dist);
        const land = Math.max(0, tr.len - (tr.hitWall ? 0.35 : 0));
        const tx = round2(tr.x0 + tr.dx * land);
        const tz = round2(tr.z0 + tr.dz * land);
        const id = this.nextEntity++;
        const landTick = this.tick + BOMB_FLIGHT_TICKS;
        const boomTick = landTick + BOMB_FUSE_TICKS;
        this.bombs.push({ id, owner: a.id, team: a.team, tx, tz, boomTick });
        this.events.push({
          e: 'bomb', id, o: a.id, x: round2(a.sim.x), z: round2(a.sim.z), tx, tz,
          k: this.tick, land: landTick, boom: boomTick, seq: res.bomb.seq,
        });
      }
      // 大招
      if ((inp.btn & BTN_SPECIAL) !== 0 && !special && a.gauge >= SPECIAL_COST && !this.frozen) {
        a.gauge = 0;
        a.specialUntil = this.tick + SPECIAL_DURATION_TICKS;
        this.paint(undefined, a.sim.x, a.sim.z, SPECIAL_BURST_PAINT_R, a.team, this.nextEntity++);
        for (const v of this.actors.values()) {
          if (v.team === a.team || v.dead) continue;
          if (Math.hypot(v.sim.x - a.sim.x, v.sim.z - a.sim.z) <= SPECIAL_BURST_DMG_R) this.damage(v, SPECIAL_BURST_DMG, a);
        }
        this.events.push({ e: 'special', o: a.id, x: round2(a.sim.x), z: round2(a.sim.z) });
      }
    }

    // ---- 2. 子弹 ----
    const alive: Shot[] = [];
    for (const s of this.shots) {
      if (this.frozen) continue; // 结算时清掉空中的子弹
      const p = s.path;
      const from = s.traveled;
      const to = Math.min(p.len, from + SHOT_SPEED * DT);
      const sx = p.x0 + p.dx * from;
      const sz = p.z0 + p.dz * from;
      let hitT = -1;
      let victim: Actor | undefined;
      for (const v of this.actors.values()) {
        if (v.team === s.team || v.dead || !v.online || this.tick < v.protectUntil) continue;
        const t = segmentCircle(sx, sz, p.dx, p.dz, to - from, v.sim.x, v.sim.z, SHOT_HIT_R);
        if (t >= 0 && (hitT < 0 || t < hitT)) {
          hitT = t;
          victim = v;
        }
      }
      const owner = this.actors.get(s.owner);
      if (victim) {
        const hx = sx + p.dx * hitT;
        const hz = sz + p.dz * hitT;
        this.paint(owner, hx, hz, SHOT_TRAIL_R * 1.2, s.team, s.id);
        this.events.push({ e: 'hit', id: s.id, v: victim.id, o: s.owner });
        this.damage(victim, SHOT_DAMAGE, owner);
        continue;
      }
      while (s.nextTrail <= to) {
        this.paint(owner, p.x0 + p.dx * s.nextTrail, p.z0 + p.dz * s.nextTrail, SHOT_TRAIL_R, s.team, s.id * 7 + Math.round(s.nextTrail));
        s.nextTrail += SHOT_TRAIL_EVERY;
      }
      s.traveled = to;
      if (to >= p.len - 1e-6) {
        this.paint(owner, p.x0 + p.dx * p.len, p.z0 + p.dz * p.len, s.splatR, s.team, s.id);
        continue;
      }
      alive.push(s);
    }
    this.shots = alive;

    // ---- 3. 炸弹 ----
    const pending: Bomb[] = [];
    for (const b of this.bombs) {
      if (this.frozen) continue;
      if (this.tick < b.boomTick) {
        pending.push(b);
        continue;
      }
      const owner = this.actors.get(b.owner);
      this.paint(owner, b.tx, b.tz, BOMB_PAINT_R, b.team, b.id);
      for (const v of this.actors.values()) {
        if (v.team === b.team || v.dead) continue;
        const d = Math.hypot(v.sim.x - b.tx, v.sim.z - b.tz);
        if (d <= BOMB_LETHAL_R) this.damage(v, BOMB_LETHAL_DMG, owner);
        else if (d <= BOMB_DMG_R) {
          const k = 1 - (d - BOMB_LETHAL_R) / (BOMB_DMG_R - BOMB_LETHAL_R);
          this.damage(v, BOMB_EDGE_DMG + k * (70 - BOMB_EDGE_DMG), owner);
        }
      }
      this.events.push({ e: 'boom', id: b.id, o: b.owner, x: b.tx, z: b.tz });
    }
    this.bombs = pending;

    // ---- 4. 地面效果与回血 ----
    for (const a of this.actors.values()) {
      if (a.dead) continue;
      a.sinceDmg++;
      const under = paintAt(a.sim.x, a.sim.z);
      if (!this.frozen && a.online && under === teamPaint(1 - a.team) && a.hp > ENEMY_INK_MIN_HP && this.tick >= a.protectUntil) {
        a.hp = Math.max(ENEMY_INK_MIN_HP, a.hp - ENEMY_INK_DPS * DT);
        a.sinceDmg = 0;
      } else if (a.sinceDmg >= HP_REGEN_DELAY_TICKS && a.hp < HP_MAX) {
        const swimOwn = a.sim.swim && under === teamPaint(a.team);
        a.hp = Math.min(HP_MAX, a.hp + (swimOwn ? HP_REGEN_SWIM_PER_S : HP_REGEN_PER_S) * DT);
      }
    }
  }

  snapshotPlayers(): SnapPlayer[] {
    const out: SnapPlayer[] = [];
    for (const a of this.actors.values()) {
      const s = a.sim;
      let f = 0;
      if (s.swim) f |= F_SWIM;
      if (a.dead) f |= F_DEAD;
      if (this.tick < a.protectUntil) f |= F_PROTECT;
      if (this.tick < a.specialUntil) f |= F_SPECIAL;
      if ((a.lastInput.btn & BTN_FIRE) && !s.swim && !this.frozen) f |= F_FIRING;
      if (!a.online) f |= F_OFFLINE;
      if (s.swim && cellAt(this.grid.cells, s.x, s.z) === teamPaint(a.team)) f |= F_INKED;
      if (a.handicap) f |= F_HANDICAP;
      out.push([
        a.id, Math.round(s.x * 1000) / 1000, Math.round(s.z * 1000) / 1000,
        Math.round(s.vx * 1000) / 1000, Math.round(s.vz * 1000) / 1000,
        f, Math.round(a.hp), Math.round(s.ink * 100) / 100, Math.floor((a.gauge / SPECIAL_COST) * 100),
        a.lastInput.aim, s.fireCd, Math.min(999, s.sinceShot),
        a.dead ? Math.max(0, a.respawnTick - this.tick) : Math.max(0, a.specialUntil - this.tick),
      ]);
    }
    return out;
  }

  /** 若某队人数更少，给该队加成。 */
  updateHandicap(): void {
    const n = [0, 0];
    for (const a of this.actors.values()) n[a.team]++;
    for (const a of this.actors.values()) a.handicap = n[a.team] < n[1 - a.team];
  }
}
