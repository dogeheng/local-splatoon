import {
  ACCEL, BOMB_COST, BOMB_MIN_RANGE, BOMB_RANGE, BTN_BOMB, BTN_FIRE, BTN_SWIM, DT,
  ENEMY_INK_SPEED, HANDICAP_INK_MULT, INK_MAX, INK_REGEN_DELAY_TICKS, INK_REGEN_PER_S,
  INK_REGEN_SWIM_PER_S, MUZZLE_OFFSET, PLAYER_RADIUS, SHOT_COST, SHOT_INTERVAL_SPECIAL_TICKS,
  SHOT_INTERVAL_TICKS, SHOT_RANGE, SHOT_SPREAD_RAD, SPAWN_BARRIER_R,
  SQUID_DRY_SPEED, SWIM_ACCEL, SWIM_SPEED, WALK_FIRE_SPEED, WALK_SPEED, teamPaint,
} from './constants';
import { SPAWNS, raycastWalls, resolveCircle } from './arena';
import { aimToRad, hash01, segmentCircle } from './math';

/** 角色的可预测状态（客户端预测与服务器模拟共用）。 */
export interface PlayerSim {
  x: number;
  z: number;
  vx: number;
  vz: number;
  ink: number;
  fireCd: number;
  sinceShot: number;
  swim: boolean;
}

/** 一个模拟步的输入。 */
export interface InputFrame {
  seq: number;
  mx: number; // -100..100
  mz: number; // -100..100
  aim: number; // 0..AIM_STEPS-1
  dist: number; // 0..100，投掷距离 ×0.1
  btn: number;
}

export interface SimEnv {
  team: number;
  seat: number;
  handicap: boolean;
  special: boolean;
  paintAt: (x: number, z: number) => number;
}

export interface ShotSpawn { seq: number; angle: number; x: number; z: number }
export interface BombSpawn { seq: number; angle: number; dist: number }
export interface StepResult { shot: ShotSpawn | null; bomb: BombSpawn | null }

export const emptyInput = (seq = 0): InputFrame => ({ seq, mx: 0, mz: 0, aim: 0, dist: 0, btn: 0 });

export function newSim(x: number, z: number): PlayerSim {
  return { x, z, vx: 0, vz: 0, ink: INK_MAX, fireCd: 0, sinceShot: 999, swim: false };
}

export function copySim(s: PlayerSim): PlayerSim {
  return { x: s.x, z: s.z, vx: s.vx, vz: s.vz, ink: s.ink, fireCd: s.fireCd, sinceShot: s.sinceShot, swim: s.swim };
}

/** 子弹散布：由座位和输入序号决定，客户端预测与服务器结果一致。 */
export function shotAngle(aim: number, seat: number, seq: number): number {
  return aimToRad(aim) + (hash01(seat, seq, 7) - 0.5) * 2 * SHOT_SPREAD_RAD;
}

/** 推进一个固定步。原地修改 p，返回本步产生的射击与投掷。 */
export function stepPlayer(p: PlayerSim, inp: InputFrame, env: SimEnv): StepResult {
  const res: StepResult = { shot: null, bomb: null };
  const own = teamPaint(env.team);
  const enemy = teamPaint(1 - env.team);
  const under = env.paintAt(p.x, p.z);
  const swimming = (inp.btn & BTN_SWIM) !== 0;
  const firing = !swimming && (inp.btn & BTN_FIRE) !== 0;

  // ---- 移动 ----
  let mx = inp.mx / 100;
  let mz = inp.mz / 100;
  const ml = Math.hypot(mx, mz);
  if (ml > 1) {
    mx /= ml;
    mz /= ml;
  }
  let target: number;
  let accel = ACCEL;
  if (swimming) {
    if (under === own) {
      target = SWIM_SPEED;
      accel = SWIM_ACCEL;
    } else if (under === enemy) target = ENEMY_INK_SPEED * 0.8;
    else target = SQUID_DRY_SPEED;
  } else if (under === enemy) target = ENEMY_INK_SPEED;
  else target = firing ? WALK_FIRE_SPEED : WALK_SPEED;

  const dvx = mx * target - p.vx;
  const dvz = mz * target - p.vz;
  const dl = Math.hypot(dvx, dvz);
  const maxDv = accel * DT;
  if (dl > maxDv) {
    p.vx += (dvx / dl) * maxDv;
    p.vz += (dvz / dl) * maxDv;
  } else {
    p.vx += dvx;
    p.vz += dvz;
  }
  const ox = p.x;
  const oz = p.z;
  p.x += p.vx * DT;
  p.z += p.vz * DT;
  resolveCircle(p, PLAYER_RADIUS, 1 - env.team);
  // 被墙挡住时去掉对应速度分量，避免“贴墙蓄速”
  const ax = (p.x - ox) / DT;
  const az = (p.z - oz) / DT;
  if (Math.abs(ax - p.vx) > 0.01) p.vx = ax;
  if (Math.abs(az - p.vz) > 0.01) p.vz = az;
  p.swim = swimming;

  // ---- 射击 ----
  if (p.fireCd > 0) p.fireCd--;
  p.sinceShot++;
  if (firing && p.fireCd <= 0 && (env.special || p.ink >= SHOT_COST)) {
    const a = shotAngle(inp.aim, env.seat, inp.seq);
    res.shot = { seq: inp.seq, angle: a, x: p.x, z: p.z };
    p.fireCd = env.special ? SHOT_INTERVAL_SPECIAL_TICKS : SHOT_INTERVAL_TICKS;
    if (!env.special) p.ink -= SHOT_COST;
    p.sinceShot = 0;
  }

  // ---- 投掷炸弹 ----
  if ((inp.btn & BTN_BOMB) !== 0 && p.ink >= BOMB_COST) {
    const dist = Math.max(BOMB_MIN_RANGE, Math.min(BOMB_RANGE, inp.dist / 10));
    res.bomb = { seq: inp.seq, angle: aimToRad(inp.aim), dist };
    p.ink -= BOMB_COST;
    p.sinceShot = 0;
  }

  // ---- 补墨 ----
  const mult = env.handicap ? HANDICAP_INK_MULT : 1;
  if (env.special) p.ink = INK_MAX;
  else if (swimming && under === own) p.ink += INK_REGEN_SWIM_PER_S * mult * DT;
  else if (p.sinceShot >= INK_REGEN_DELAY_TICKS) p.ink += INK_REGEN_PER_S * mult * DT;
  if (p.ink > INK_MAX) p.ink = INK_MAX;
  if (p.ink < 0) p.ink = 0;
  return res;
}

export interface ShotPath {
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  len: number; // 弹道长度（到射程、墙或敌方屏障为止）
  hitWall: boolean;
}

/** 计算一发子弹在没有命中玩家时的完整弹道。 */
export function traceShot(x: number, z: number, angle: number, team: number, range = SHOT_RANGE): ShotPath {
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  const x0 = x + dx * MUZZLE_OFFSET * 0.2;
  const z0 = z + dz * MUZZLE_OFFSET * 0.2;
  let len = raycastWalls(x0, z0, dx, dz, range);
  let hitWall = len < range - 1e-6;
  // 敌方出生点屏障会吸收墨弹
  const s = SPAWNS[1 - team];
  const tb = segmentCircle(x0, z0, dx, dz, len, s.x, s.z, SPAWN_BARRIER_R);
  if (tb >= 0 && tb < len) {
    len = tb;
    hitWall = true;
  }
  return { x0, z0, dx, dz, len, hitWall };
}
