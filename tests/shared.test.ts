import { describe, expect, it } from 'vitest';
import {
  BTN_FIRE, BTN_SWIM, INK_MAX, SHOT_COST, SHOT_INTERVAL_TICKS, SWIM_SPEED, WALK_SPEED, PAINT_BLOCKED,
} from '../shared/constants';
import { BASE_GRID, PAINTABLE_COUNT, SPAWNS, WALLS, cellAt, raycastWalls } from '../shared/arena';
import { PaintGrid } from '../shared/paint';
import { copySim, newSim, stepPlayer, traceShot, type InputFrame } from '../shared/sim';
import { parseInputs, sanitizeName } from '../shared/protocol';

const env = (grid: PaintGrid, team = 0) => ({
  team, seat: 1, handicap: false, special: false, paintAt: (x: number, z: number) => cellAt(grid.cells, x, z),
});
const frame = (seq: number, mx: number, mz: number, btn = 0, aim = 0): InputFrame => ({ seq, mx, mz, aim, dist: 50, btn });

describe('场地', () => {
  it('障碍物点对称，双方公平', () => {
    expect(WALLS.length).toBeGreaterThan(8);
    expect(SPAWNS[0].x + SPAWNS[1].x).toBeCloseTo(40);
    let blocked = 0;
    for (const v of BASE_GRID) if (v === PAINT_BLOCKED) blocked++;
    expect(PAINTABLE_COUNT + blocked).toBe(BASE_GRID.length);
  });
  it('射线会被墙挡住', () => {
    const w = WALLS[0];
    const d = raycastWalls(w.x0 - 2, (w.z0 + w.z1) / 2, 1, 0, 10);
    expect(d).toBeCloseTo(2, 5);
  });
});

describe('步进函数', () => {
  it('走路速度收敛到 WALK_SPEED', () => {
    const g = new PaintGrid();
    const p = newSim(20, 7.5);
    for (let i = 1; i <= 30; i++) stepPlayer(p, frame(i, 0, 100), env(g));
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(WALK_SPEED, 1);
  });
  it('在己方墨水中潜游更快', () => {
    const g = new PaintGrid();
    g.paintCircle(20, 8, 6, 0, 1);
    const p = newSim(20, 7.5);
    for (let i = 1; i <= 20; i++) stepPlayer(p, frame(i, 100, 0, BTN_SWIM), env(g));
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(SWIM_SPEED, 1);
  });
  it('按住射击按固定间隔开火并消耗墨水', () => {
    const g = new PaintGrid();
    const p = newSim(20, 7.5);
    let shots = 0;
    for (let i = 1; i <= SHOT_INTERVAL_TICKS * 10; i++) if (stepPlayer(p, frame(i, 0, 0, BTN_FIRE), env(g)).shot) shots++;
    expect(shots).toBe(10);
    expect(p.ink).toBeCloseTo(INK_MAX - 10 * SHOT_COST, 5);
  });
  it('相同输入序列的结果完全一致（预测与服务器对拍）', () => {
    const g = new PaintGrid();
    g.paintCircle(10, 10, 4, 0, 3);
    const a = newSim(5, 12);
    const b = copySim(a);
    for (let i = 1; i <= 300; i++) {
      const f = frame(i, Math.round(Math.sin(i / 9) * 100), Math.round(Math.cos(i / 13) * 100), i % 50 < 25 ? BTN_FIRE : BTN_SWIM, (i * 37) % 4096);
      const ra = stepPlayer(a, f, env(g));
      const rb = stepPlayer(b, f, env(g));
      expect(ra.shot?.angle).toBe(rb.shot?.angle);
    }
    expect(a).toEqual(b);
  });
  it('角色不会穿过障碍物', () => {
    const g = new PaintGrid();
    const w = WALLS[0];
    const p = newSim(w.x0 - 1, (w.z0 + w.z1) / 2);
    for (let i = 1; i <= 120; i++) stepPlayer(p, frame(i, 100, 0), env(g));
    expect(p.x).toBeLessThanOrEqual(w.x0);
  });
  it('角色进不了敌方出生点', () => {
    const g = new PaintGrid();
    const p = newSim(SPAWNS[1].x - 5, SPAWNS[1].z);
    for (let i = 1; i <= 180; i++) stepPlayer(p, frame(i, 100, 0), env(g, 0));
    expect(Math.hypot(p.x - SPAWNS[1].x, p.z - SPAWNS[1].z)).toBeGreaterThan(2.6);
  });
  it('子弹在墙前停下', () => {
    const w = WALLS[0];
    const path = traceShot(w.x0 - 3, (w.z0 + w.z1) / 2, 0, 0);
    expect(path.hitWall).toBe(true);
    expect(path.len).toBeLessThan(3.1);
  });
});

describe('涂色网格', () => {
  it('增量可以在客户端重建出相同地面', () => {
    const s = new PaintGrid();
    s.paintCircle(10, 10, 2, 0, 1);
    s.paintCircle(11, 10, 2, 1, 2);
    const c = new PaintGrid();
    c.applyDeltas(s.flushDeltas());
    expect(Array.from(c.cells)).toEqual(Array.from(s.cells));
    expect(c.counts).toEqual(s.counts);
  });
  it('障碍格不可涂', () => {
    const s = new PaintGrid();
    const w = WALLS[0];
    s.paintCircle((w.x0 + w.x1) / 2, (w.z0 + w.z1) / 2, 0.5, 0, 1);
    expect(s.counts[0]).toBe(0);
  });
});

describe('协议校验', () => {
  it('拒绝越界或畸形输入', () => {
    expect(parseInputs({ t: 'in', s: [[1, 0, 0, 0, 0, 0]] })).toHaveLength(1);
    expect(parseInputs({ t: 'in', s: [[1, 500, 0, 0, 0, 0]] })).toBeNull();
    expect(parseInputs({ t: 'in', s: [[1, 0, 0, 0, 0]] })).toBeNull();
    expect(parseInputs({ t: 'in', s: [[1.5, 0, 0, 0, 0, 0]] })).toBeNull();
    expect(parseInputs({ t: 'in', s: [], x: 1 })).toBeNull();
    expect(parseInputs({ t: 'in', s: [[1, 0, 0, 0, 0, 99]] })).toBeNull();
  });
  it('昵称会被清洗并截断', () => {
    expect(sanitizeName('  小橙\u0000\u202e  ')).toBe('小橙');
    expect(sanitizeName('一二三四五六七八九十十一十二十三')).toHaveLength(12);
    expect(sanitizeName('   ')).toBe('无名小墨');
  });
});
