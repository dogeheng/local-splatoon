// 端到端：两名玩家沿无遮挡通道走到中场对射，检查击倒播报与复活。
// 先启动服务器：npm start ；再运行：node scripts/e2e/kill.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT = process.env.PROJECT ?? process.cwd();
const OUT = process.env.OUT ?? path.join(PROJECT, 'e2e-shots');
const BASE = process.env.BASE ?? 'http://localhost:8080';
const require = createRequire(path.join(PROJECT, 'package.json'));
const { chromium } = require('playwright-core');
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const vp = { width: 1440, height: 900 };
const A = await (await browser.newContext({ viewport: vp })).newPage();
const B = await (await browser.newContext({ viewport: vp })).newPage();
const errors = [];
for (const [n, p] of [['A', A], ['B', B]]) p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
const shot = (p, n) => p.screenshot({ path: path.join(OUT, `${n}.png`) });

await A.goto(BASE);
await A.fill('.home-card input.field:not(.code-input)', '阿橙');
await A.click('text=创建房间');
await A.waitForSelector('.room-code');
const code = (await A.textContent('.room-code')).trim();
await B.goto(`${BASE}/?room=${code}`);
await B.fill('.home-card input.field:not(.code-input)', '阿青');
await B.click('button:has-text("加入")');
await B.waitForSelector('.room-code');
await sleep(600);

const pos = (p) => p.evaluate(() => {
  const g = window.__game;
  return g.pred ? { x: g.pred.x, z: g.pred.z } : null;
});
const keysFor = (dx, dz) => {
  const k = [];
  if (dx > 0.25) k.push('KeyD');
  if (dx < -0.25) k.push('KeyA');
  if (dz > 0.25) k.push('KeyS');
  if (dz < -0.25) k.push('KeyW');
  return k;
};
async function steer(p, tx, tz, maxMs = 6000) {
  const t0 = Date.now();
  let held = [];
  while (Date.now() - t0 < maxMs) {
    const q = await pos(p);
    if (!q) { await sleep(50); continue; }
    const dx = tx - q.x, dz = tz - q.z;
    if (Math.hypot(dx, dz) < 0.35) break;
    const want = keysFor(dx, dz);
    for (const k of held) if (!want.includes(k)) await p.keyboard.up(k);
    for (const k of want) if (!held.includes(k)) await p.keyboard.down(k);
    held = want;
    await sleep(40);
  }
  for (const k of held) await p.keyboard.up(k);
  return pos(p);
}
await Promise.all([
  (async () => { await steer(A, 3.6, 9.2); return steer(A, 16.5, 9.2); })(),
  (async () => { await steer(B, 36.4, 9.2); return steer(B, 23.5, 9.2); })(),
]);
log('A at', JSON.stringify(await pos(A)), 'B at', JSON.stringify(await pos(B)));

const idA = await A.evaluate(() => window.__game.me);
const idB = await B.evaluate(() => window.__game.me);
const screenOf = (p, id) => p.evaluate((id) => {
  const g = window.__game;
  const s = g.players.get(id);
  if (!s) return null;
  const V = g.aimPoint.constructor;
  return g.scene.worldToScreen(new V(s.rx, 0, s.rz));
}, id);

let killed = null;
let shotTaken = false;
const t0 = Date.now();
await A.mouse.down();
// B 只在前 0.6 秒还击，让 A 更可能先击倒 B，便于观察
await B.mouse.down();
while (Date.now() - t0 < 6000 && !killed) {
  const tb = await screenOf(A, idB);
  const ta = await screenOf(B, idA);
  if (tb) await A.mouse.move(tb.x, tb.y);
  if (ta) await B.mouse.move(ta.x, ta.y);
  if (Date.now() - t0 > 600) await B.mouse.up();
  const st = await A.evaluate(() => [...window.__game.players.values()].map((s) => ({ id: s.id, hp: s.hp, dead: (s.flags & 2) !== 0 })));
  if (!shotTaken && st.some((s) => s.hp < 100)) {
    shotTaken = true;
    await shot(A, 'k01-hit');
    log('first damage', JSON.stringify(st));
  }
  const d = st.find((s) => s.dead);
  if (d) killed = d.id;
  await sleep(30);
}
await A.mouse.up();
await B.mouse.up();
log('killed id', killed, 'A', idA, 'B', idB);
await sleep(150);
await shot(A, 'k02-splat-A');
await shot(B, 'k03-splat-B');
const respawnText = await B.evaluate(() => document.querySelector('.respawn-msg')?.textContent ?? '');
const feed = await A.evaluate(() => [...document.querySelectorAll('.kf')].map((e) => e.textContent));
log('respawn text on B', respawnText, ' killfeed on A', JSON.stringify(feed));
await sleep(3400);
const after = await A.evaluate(() => [...window.__game.players.values()].map((s) => ({ id: s.id, hp: s.hp, dead: (s.flags & 2) !== 0, x: s.x.toFixed(1), z: s.z.toFixed(1) })));
log('after respawn', JSON.stringify(after));
await shot(B, 'k04-respawned-B');
log('errors', errors.length ? errors : 'none');
await browser.close();
