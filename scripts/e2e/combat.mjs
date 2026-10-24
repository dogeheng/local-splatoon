// 端到端：四人 2v2 + 一名观战者，检查自动分队与各端涂色一致。
// 先启动服务器：npm start ；再运行：node scripts/e2e/combat.mjs
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
const names = ['阿橙', '阿青', '小橘', '小薄荷'];
const pages = [];
const errors = [];
for (let i = 0; i < 4; i++) {
  const ctx = await browser.newContext({ viewport: vp });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${i} pageerror: ${e.message}`));
  pages.push(p);
}
const [A, B, C, D] = pages;
const shot = (p, n) => p.screenshot({ path: path.join(OUT, `${n}.png`) });

await A.goto(BASE);
await A.fill('.home-card input.field:not(.code-input)', names[0]);
await A.click('text=创建房间');
await A.waitForSelector('.room-code');
const code = (await A.textContent('.room-code')).trim();
for (let i = 1; i < 4; i++) {
  const p = pages[i];
  await p.goto(`${BASE}/?room=${code}`);
  await p.fill('.home-card input.field:not(.code-input)', names[i]);
  await p.click('button:has-text("加入")');
  await p.waitForSelector('.room-code');
}
await sleep(800);
const teams = await Promise.all(pages.map((p) => p.evaluate(() => [window.__game.me, window.__game.myTeam, window.__game.role])));
log('id/team/role', JSON.stringify(teams));
await shot(A, 'c01-lobby-2v2');

// 第五个人：应成为观战者
const ctxE = await browser.newContext({ viewport: vp });
const E = await ctxE.newPage();
await E.goto(`${BASE}/?room=${code}`);
await E.fill('.home-card input.field:not(.code-input)', '路人甲');
await E.click('button:has-text("加入")');
await E.waitForSelector('.room-code');
await sleep(500);
log('E role', await E.evaluate(() => window.__game.role));
await shot(E, 'c02-spectator-lobby');

// 热身交火：阿橙 与 阿青 走向中路互射
const screenOf = (p, id) => p.evaluate((id) => {
  const g = window.__game;
  const s = g.players.get(id);
  if (!s) return null;
  const V = g.aimPoint.constructor;
  const v = g.scene.worldToScreen(new V(s.rx, 0.5, s.rz));
  return v;
}, id);
const idA = teams[0][0];
const idB = teams[1][0];
// 先各自朝中路走
await A.mouse.move(1000, 450); await B.mouse.move(400, 450);
await Promise.all([A.keyboard.down('KeyD'), B.keyboard.down('KeyA')]);
await sleep(1900);
await Promise.all([A.keyboard.up('KeyD'), B.keyboard.up('KeyA')]);
let deathSeen = false;
for (let k = 0; k < 30 && !deathSeen; k++) {
  const tb = await screenOf(A, idB);
  const ta = await screenOf(B, idA);
  if (tb) await A.mouse.move(tb.x, tb.y);
  if (ta) await B.mouse.move(ta.x, ta.y);
  if (k === 0) { await A.mouse.down(); await B.mouse.down(); }
  // 稍微靠近
  await Promise.all([A.keyboard.down('KeyD'), B.keyboard.down('KeyA')]);
  await sleep(120);
  await Promise.all([A.keyboard.up('KeyD'), B.keyboard.up('KeyA')]);
  const st = await A.evaluate(() => [...window.__game.players.values()].map((s) => [s.id, s.hp, (s.flags & 1) !== 0]));
  if (k === 3) await shot(A, 'c03-firefight');
  if (st.some((x) => x[2])) {
    deathSeen = true;
    log('death detected at step', k, JSON.stringify(st));
  }
}
await A.mouse.up(); await B.mouse.up();
await sleep(250);
await shot(A, 'c04-after-splat-A');
await shot(B, 'c05-after-splat-B');
await sleep(3300);
const after = await A.evaluate(() => [...window.__game.players.values()].map((s) => [s.id, s.hp, (s.flags & 1) !== 0]));
log('after respawn', JSON.stringify(after));

// 开始 2v2 对局
for (const p of [B, C, D]) await p.click('button:has-text("准备")');
await sleep(500);
await A.click('button:has-text("开始对战")');
await sleep(4200);
await Promise.all(pages.map((p, i) => p.mouse.move(i % 2 === 0 ? 1100 : 300, 300 + i * 100)));
await Promise.all(pages.map((p) => p.mouse.down()));
await Promise.all(pages.map((p, i) => p.keyboard.down(i % 2 === 0 ? 'KeyD' : 'KeyA')));
await sleep(2200);
await Promise.all(pages.map((p, i) => p.keyboard.up(i % 2 === 0 ? 'KeyD' : 'KeyA')));
await Promise.all(pages.map((p) => p.mouse.up()));
await shot(A, 'c06-2v2-match');
await shot(E, 'c07-spectator-match');
const counts = await Promise.all([...pages, E].map((p) => p.evaluate(() => [...window.__game.grid.counts].join('/'))));
log('paint counts on 5 clients', counts.join('  '));

log('errors', errors.length ? errors : 'none');
await browser.close();
