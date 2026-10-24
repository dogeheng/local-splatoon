// 端到端：两个独立浏览器会话完成 创建 → 邀请加入 → 准备 → 开始 → 对战 → 刷新恢复 → 结算 → 再来一局。
// 先用短对局启动服务器：SA_ROUND_SEC=25 npm start ；再运行：npm run e2e
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
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const vp = { width: 1440, height: 900 };
const ctxA = await browser.newContext({ viewport: vp });
const ctxB = await browser.newContext({ viewport: vp });
const A = await ctxA.newPage();
const B = await ctxB.newPage();
const errors = [];
for (const [n, p] of [['A', A], ['B', B]]) {
  p.on('pageerror', (e) => errors.push(`${n} pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${n} console: ${m.text()}`); });
}
const shot = (p, name) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
const state = (p) => p.evaluate(() => {
  const g = window.__game;
  const ps = [...g.players.values()].map((s) => ({ id: s.id, team: s.team, rx: s.rx, rz: s.rz, flags: s.flags, hp: s.hp }));
  return { me: g.me, role: g.role, team: g.myTeam, phase: g.phase, players: ps, counts: [...g.grid.counts], debug: g.debugText() };
});

// 1. 首页
await A.goto(BASE);
await sleep(1500);
await shot(A, '01-home');
await A.fill('.home-card input.field:not(.code-input)', '小橙');
await A.click('text=创建房间');
await A.waitForSelector('.room-code');
const code = (await A.textContent('.room-code')).trim();
log('room code', code);
await sleep(800);
await shot(A, '02-lobby-alone');

// 2. B 通过邀请链接加入
await B.goto(`${BASE}/?room=${code}`);
await sleep(800);
await shot(B, '03-invite-landing');
await B.fill('.home-card input.field:not(.code-input)', '小青');
await B.click('button:has-text("加入")');
await B.waitForSelector('.room-code');
await sleep(600);
await B.click('button:has-text("准备")');
await sleep(600);
await shot(A, '04-lobby-two');

// 热身：B 在大厅里走动开火
await B.mouse.move(400, 450);
await B.keyboard.down('KeyA');
await B.mouse.down();
await sleep(1200);
await B.mouse.up();
await B.keyboard.up('KeyA');
await sleep(300);
await shot(A, '05-warmup');

// 3. 开始
await A.click('button:has-text("开始对战")');
await sleep(1200);
await shot(A, '06-countdown');
await sleep(2600);
let sa = await state(A);
log('phase after countdown', sa.phase);

// 4. 对战：两人对冲、开火、潜游、扔炸弹
async function play(p, dirKey, aimX, aimY, ms) {
  await p.mouse.move(aimX, aimY);
  await p.keyboard.down(dirKey);
  await p.mouse.down();
  await sleep(ms);
  await p.mouse.up();
  await p.keyboard.up(dirKey);
}
await Promise.all([play(A, 'KeyD', 1100, 450, 2500), play(B, 'KeyA', 300, 450, 2500)]);
await Promise.all([play(A, 'KeyS', 1000, 700, 1200), play(B, 'KeyW', 400, 200, 1200)]);
// 炸弹
await A.mouse.move(900, 450);
await A.mouse.down({ button: 'right' });
await sleep(400);
await shot(A, '07-bomb-aim');
await A.mouse.up({ button: 'right' });
await sleep(700);
await shot(A, '08-bomb-land');
// 潜游
await A.keyboard.down('ShiftLeft');
await A.keyboard.down('KeyA');
await sleep(800);
await shot(A, '09-swim');
await A.keyboard.up('KeyA');
await A.keyboard.up('ShiftLeft');
await Promise.all([play(A, 'KeyD', 1200, 400, 1500), play(B, 'KeyA', 200, 500, 1500)]);
await shot(A, '10-battle-A');
await shot(B, '11-battle-B');

// 一致性：A 看到的 B 与 B 自己的位置
sa = await state(A);
let sb = await state(B);
const bOnA = sa.players.find((p) => p.id === sb.me);
const bOnB = sb.players.find((p) => p.id === sb.me);
log('B on A', bOnA && [bOnA.rx.toFixed(2), bOnA.rz.toFixed(2)], 'B on B', bOnB && [bOnB.rx.toFixed(2), bOnB.rz.toFixed(2)]);
log('paint counts A', sa.counts, 'B', sb.counts);
log('debug A\n' + sa.debug);

// 5. 刷新恢复（对局中刷新 B）
const idBefore = sb.me;
await B.reload();
await B.waitForFunction(() => window.__game && window.__game.inRoom && window.__game.phase !== 'lobby', null, { timeout: 8000 });
await sleep(800);
sb = await state(B);
log('B after reload: id', sb.me, 'before', idBefore, 'role', sb.role, 'phase', sb.phase, 'counts', sb.counts);
await shot(B, '12-after-reload');

// 6. 等待结算
await A.waitForFunction(() => window.__game.phase === 'results', null, { timeout: 60000 });
await sleep(1400);
await shot(A, '13-results-judging');
await sleep(4200);
await shot(A, '14-results-final');
await shot(B, '15-results-B');

// 7. 再来一局
await A.click('button:has-text("再来一局")');
await sleep(300);
await B.click('button:has-text("再来一局")');
await A.waitForFunction(() => window.__game.phase === 'countdown' || window.__game.phase === 'playing', null, { timeout: 5000 });
await sleep(500);
await shot(A, '16-rematch');
sa = await state(A);
log('rematch phase', sa.phase, 'counts', sa.counts);

log('music buffers A', await A.evaluate(() => window.__game.sfx.musicBuffers.size));
log('errors', errors.length ? errors : 'none');
await browser.close();
