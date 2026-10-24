import { describe, expect, it } from 'vitest';
import { BTN_BOMB, BTN_FIRE, BTN_SPECIAL, SPECIAL_COST, TICK_HZ } from '../shared/constants';
import { radToAim } from '../shared/math';
import type { InputFrame } from '../shared/sim';
import { World } from '../server/world';

/** 在 z≈9.2 的无遮挡通道上放置两名对手，A 面向 B。 */
function duel(gap = 5) {
  const w = new World();
  const a = w.addActor(1, 0, 0);
  const b = w.addActor(2, 1, 0);
  a.sim.x = 15; a.sim.z = 9.2;
  b.sim.x = 15 + gap; b.sim.z = 9.2;
  a.protectUntil = 0;
  b.protectUntil = 0;
  return { w, a, b };
}

function feed(w: World, actorId: number, ticks: number, btn: (i: number) => number, aimRad = 0, dist = 50) {
  const a = w.actors.get(actorId)!;
  for (let i = 0; i < ticks; i++) {
    const f: InputFrame = { seq: a.lastSeq + 1 + a.inputQ.length, mx: 0, mz: 0, aim: radToAim(aimRad), dist, btn: btn(i) };
    w.pushInputs(a, [f]);
    w.step();
  }
}

describe('世界模拟：战斗', () => {
  it('持续命中会击倒对手，并在 3 秒后复活回出生点', () => {
    const { w, a, b } = duel();
    feed(w, a.id, TICK_HZ * 1.5, () => BTN_FIRE);
    expect(b.dead || b.stats.deaths > 0).toBe(true);
    expect(a.stats.splats).toBe(1);
    expect(w.events.some((e) => e.e === 'splat') || b.dead).toBe(true);
    // 等待复活
    for (let i = 0; i < TICK_HZ * 3.2; i++) w.step();
    expect(b.dead).toBe(false);
    expect(b.sim.x).toBeGreaterThan(30);
  });

  it('离线（等待重连）的玩家免伤，子弹直接穿过', () => {
    const { w, a, b } = duel();
    b.online = false;
    feed(w, a.id, TICK_HZ * 1.5, () => BTN_FIRE);
    expect(b.dead).toBe(false);
    expect(b.hp).toBe(100);
    expect(a.stats.splats).toBe(0);
  });

  it('能量满时释放大招：开启无限墨水并对近身敌人造成范围伤害', () => {
    const { w, a, b } = duel(1.5);
    a.gauge = SPECIAL_COST;
    feed(w, a.id, 1, () => BTN_SPECIAL);
    expect(a.specialUntil).toBeGreaterThan(w.tick);
    expect(a.gauge).toBe(0);
    expect(b.hp).toBeLessThan(100);
    // 大招期间墨水不会减少
    feed(w, a.id, TICK_HZ, () => BTN_FIRE);
    expect(a.sim.ink).toBeGreaterThanOrEqual(99);
  });

  it('能量不足时按大招无效', () => {
    const { w, a } = duel();
    a.gauge = SPECIAL_COST - 1;
    feed(w, a.id, 1, () => BTN_SPECIAL);
    expect(a.specialUntil).toBe(0);
  });

  it('炸弹落地后爆炸，涂色并伤害范围内敌人', () => {
    const { w, a, b } = duel(5);
    const before = w.grid.counts[0];
    feed(w, a.id, 1, () => BTN_BOMB, 0, 50);
    for (let i = 0; i < TICK_HZ * 2; i++) w.step();
    expect(w.grid.counts[0] - before).toBeGreaterThan(100);
    expect(b.hp < 100 || b.dead).toBe(true);
  });
});
