import {
  ARENA_H, ARENA_W, CELL, GRID_H, GRID_W, PAINT_BLOCKED, SPAWN_BARRIER_R,
} from './constants';

export interface Box { x0: number; z0: number; x1: number; z1: number; h: number }

// 左半场的障碍物，按场地中心点对称自动生成右半场，保证双方完全公平。
const HALF: Box[] = [
  { x0: 7.0, z0: 4.0, x1: 9.0, z1: 8.0, h: 1.4 },
  { x0: 7.0, z0: 16.0, x1: 9.0, z1: 20.0, h: 1.4 },
  { x0: 12.5, z0: 10.0, x1: 14.0, z1: 14.0, h: 1.1 },
  { x0: 15.5, z0: 3.0, x1: 19.0, z1: 4.8, h: 1.0 },
  { x0: 15.5, z0: 19.2, x1: 17.5, z1: 21.0, h: 1.0 },
  { x0: 18.8, z0: 10.6, x1: 21.2, z1: 13.4, h: 1.8 },
  { x0: 11.0, z0: 0.0, x1: 12.0, z1: 2.5, h: 0.9 },
  { x0: 11.0, z0: 21.5, x1: 12.0, z1: 24.0, h: 0.9 },
];

function mirror(b: Box): Box {
  return { x0: ARENA_W - b.x1, z0: ARENA_H - b.z1, x1: ARENA_W - b.x0, z1: ARENA_H - b.z0, h: b.h };
}
const key = (b: Box) => `${b.x0},${b.z0},${b.x1},${b.z1}`;

export const WALLS: Box[] = (() => {
  const out: Box[] = [];
  const seen = new Set<string>();
  for (const b of HALF) {
    for (const w of [b, mirror(b)]) {
      if (!seen.has(key(w))) {
        seen.add(key(w));
        out.push(w);
      }
    }
  }
  return out;
})();

/** 队伍 0（橙）在左，队伍 1（青）在右。 */
export const SPAWNS = [
  { x: 2.7, z: ARENA_H / 2 },
  { x: ARENA_W - 2.7, z: ARENA_H / 2 },
];

/** 同队第 n 名玩家的复活位置（略微错开）。 */
export function spawnPoint(team: number, slot: number): { x: number; z: number } {
  const s = SPAWNS[team];
  const off = slot === 0 ? -0.9 : 0.9;
  return { x: s.x, z: s.z + off };
}

export const cellIndex = (ix: number, iz: number) => iz * GRID_W + ix;

export function buildBaseGrid(): Uint8Array {
  const g = new Uint8Array(GRID_W * GRID_H);
  for (let iz = 0; iz < GRID_H; iz++) {
    for (let ix = 0; ix < GRID_W; ix++) {
      const cx = (ix + 0.5) * CELL;
      const cz = (iz + 0.5) * CELL;
      for (const w of WALLS) {
        if (cx > w.x0 && cx < w.x1 && cz > w.z0 && cz < w.z1) {
          g[cellIndex(ix, iz)] = PAINT_BLOCKED;
          break;
        }
      }
    }
  }
  return g;
}

export const BASE_GRID = buildBaseGrid();
export const PAINTABLE_COUNT = BASE_GRID.reduce((n, v) => n + (v === PAINT_BLOCKED ? 0 : 1), 0);

export function cellAt(grid: Uint8Array, x: number, z: number): number {
  const ix = Math.floor(x / CELL);
  const iz = Math.floor(z / CELL);
  if (ix < 0 || iz < 0 || ix >= GRID_W || iz >= GRID_H) return PAINT_BLOCKED;
  return grid[iz * GRID_W + ix];
}

/** 把圆推出所有障碍与场地边界（原地修改）。 */
export function resolveCircle(p: { x: number; z: number }, r: number, enemyBarrierTeam: number): void {
  for (let pass = 0; pass < 2; pass++) {
    for (const w of WALLS) {
      const nx = p.x < w.x0 ? w.x0 : p.x > w.x1 ? w.x1 : p.x;
      const nz = p.z < w.z0 ? w.z0 : p.z > w.z1 ? w.z1 : p.z;
      const dx = p.x - nx;
      const dz = p.z - nz;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r) {
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          p.x = nx + (dx / d) * r;
          p.z = nz + (dz / d) * r;
        } else {
          // 圆心已在盒子内部：沿最短方向推出
          const left = p.x - w.x0, right = w.x1 - p.x, top = p.z - w.z0, bottom = w.z1 - p.z;
          const m = Math.min(left, right, top, bottom);
          if (m === left) p.x = w.x0 - r;
          else if (m === right) p.x = w.x1 + r;
          else if (m === top) p.z = w.z0 - r;
          else p.z = w.z1 + r;
        }
      }
    }
    // 敌方出生点屏障
    if (enemyBarrierTeam >= 0) {
      const s = SPAWNS[enemyBarrierTeam];
      const dx = p.x - s.x;
      const dz = p.z - s.z;
      const rr = SPAWN_BARRIER_R + r;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr) {
        const d = Math.sqrt(d2) || 1e-6;
        p.x = s.x + (dx / d) * rr;
        p.z = s.z + (dz / d) * rr;
      }
    }
    if (p.x < r) p.x = r;
    if (p.x > ARENA_W - r) p.x = ARENA_W - r;
    if (p.z < r) p.z = r;
    if (p.z > ARENA_H - r) p.z = ARENA_H - r;
  }
}

/** 射线与障碍/场地边界的最早相交距离（不超过 maxDist）。 */
export function raycastWalls(x0: number, z0: number, dx: number, dz: number, maxDist: number): number {
  let best = maxDist;
  // 场地边界
  if (dx > 1e-9) best = Math.min(best, (ARENA_W - x0) / dx);
  else if (dx < -1e-9) best = Math.min(best, (0 - x0) / dx);
  if (dz > 1e-9) best = Math.min(best, (ARENA_H - z0) / dz);
  else if (dz < -1e-9) best = Math.min(best, (0 - z0) / dz);
  for (const w of WALLS) {
    let tmin = 0;
    let tmax = best;
    if (Math.abs(dx) < 1e-9) {
      if (x0 <= w.x0 || x0 >= w.x1) continue;
    } else {
      let t1 = (w.x0 - x0) / dx;
      let t2 = (w.x1 - x0) / dx;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    if (Math.abs(dz) < 1e-9) {
      if (z0 <= w.z0 || z0 >= w.z1) continue;
    } else {
      let t1 = (w.z0 - z0) / dz;
      let t2 = (w.z1 - z0) / dz;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    if (tmin < best) best = tmin;
  }
  return Math.max(0, best);
}
