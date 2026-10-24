import { CELL, GRID_H, GRID_W, PAINT_BLOCKED, PAINT_NONE, teamPaint } from './constants';
import { BASE_GRID } from './arena';
import { hash01 } from './math';

/**
 * 地面涂色网格。服务器拥有权威副本；客户端持有只读镜像，通过增量更新。
 * 增量编码：正数 n 表示格子 n-1 变为队伍 0，负数 -n 表示格子 n-1 变为队伍 1。
 */
export class PaintGrid {
  readonly cells: Uint8Array;
  readonly counts = [0, 0];
  private dirtyFlag: Uint8Array;
  private dirtyList: number[] = [];

  constructor() {
    this.cells = new Uint8Array(BASE_GRID);
    this.dirtyFlag = new Uint8Array(GRID_W * GRID_H);
  }

  reset(): void {
    this.cells.set(BASE_GRID);
    this.counts[0] = 0;
    this.counts[1] = 0;
    this.dirtyFlag.fill(0);
    this.dirtyList.length = 0;
  }

  /** 设置一个格子，返回是否为该队新增的格子。 */
  setCell(idx: number, team: number): boolean {
    const v = this.cells[idx];
    const nv = teamPaint(team);
    if (v === PAINT_BLOCKED || v === nv) return false;
    if (v !== PAINT_NONE) this.counts[v - 1]--;
    this.cells[idx] = nv;
    this.counts[team]++;
    if (!this.dirtyFlag[idx]) {
      this.dirtyFlag[idx] = 1;
      this.dirtyList.push(idx);
    }
    return true;
  }

  /**
   * 以 (cx, cz) 为圆心、r 为半径涂色，边缘用确定性噪声做出不规则的颜料形状。
   * 返回该队新增的格子数（用于大招充能）。
   */
  paintCircle(cx: number, cz: number, r: number, team: number, salt: number, rough = true): number {
    const ix0 = Math.max(0, Math.floor((cx - r) / CELL));
    const ix1 = Math.min(GRID_W - 1, Math.floor((cx + r) / CELL));
    const iz0 = Math.max(0, Math.floor((cz - r) / CELL));
    const iz1 = Math.min(GRID_H - 1, Math.floor((cz + r) / CELL));
    let gained = 0;
    for (let iz = iz0; iz <= iz1; iz++) {
      const pz = (iz + 0.5) * CELL - cz;
      for (let ix = ix0; ix <= ix1; ix++) {
        const px = (ix + 0.5) * CELL - cx;
        const d2 = px * px + pz * pz;
        if (d2 > r * r) continue;
        const idx = iz * GRID_W + ix;
        if (rough && d2 > r * r * 0.55) {
          const k = 0.8 + 0.2 * hash01(idx, salt);
          if (d2 > r * r * k * k) continue;
        }
        if (this.setCell(idx, team)) gained++;
      }
    }
    return gained;
  }

  /** 取出自上次以来变化过的格子（编码为增量），并清空脏标记。 */
  flushDeltas(): number[] {
    const out: number[] = new Array(this.dirtyList.length);
    for (let i = 0; i < this.dirtyList.length; i++) {
      const idx = this.dirtyList[i];
      this.dirtyFlag[idx] = 0;
      out[i] = this.cells[idx] === 1 ? idx + 1 : -(idx + 1);
    }
    this.dirtyList.length = 0;
    return out;
  }

  hasDirty(): boolean {
    return this.dirtyList.length > 0;
  }

  /** 客户端应用增量，返回被修改的格子编号。 */
  applyDeltas(d: number[]): void {
    for (const code of d) {
      const idx = Math.abs(code) - 1;
      if (idx < 0 || idx >= this.cells.length) continue;
      const team = code > 0 ? 0 : 1;
      this.setCell(idx, team);
    }
    // 客户端不需要转发增量
    for (const idx of this.dirtyList) this.dirtyFlag[idx] = 0;
    this.dirtyList.length = 0;
  }

  loadFull(cells: Uint8Array): void {
    this.cells.set(cells);
    this.counts[0] = 0;
    this.counts[1] = 0;
    for (const v of this.cells) {
      if (v === 1) this.counts[0]++;
      else if (v === 2) this.counts[1]++;
    }
    this.dirtyFlag.fill(0);
    this.dirtyList.length = 0;
  }
}
