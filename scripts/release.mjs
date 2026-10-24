// 生成可直接运行的发布包：release/splash-arena/ 以及 release/splash-arena.zip
// 用法：npm run release
// 产物只包含构建后的网页、打包成单文件的服务器、启动脚本和说明，不包含源代码；
// 运行时只需要 Node.js 20+，不需要 npm install。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'splash-arena';
const OUT_ROOT = path.join(ROOT, 'release');
const OUT = path.join(OUT_ROOT, NAME);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const step = (s) => console.log(`\n== ${s}`);
fs.rmSync(OUT_ROOT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1. 前端
step('构建前端');
execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: ROOT, stdio: 'inherit' });
fs.cpSync(path.join(ROOT, 'dist', 'client'), path.join(OUT, 'dist', 'client'), { recursive: true });

// 2. 服务器：连同 ws、zod 打包成一个文件
step('打包服务器');
await build({
  entryPoints: [path.join(ROOT, 'server', 'index.ts')],
  outfile: path.join(OUT, 'server', 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: true,
  // vite 只在开发模式下动态加载；bufferutil/utf-8-validate 是 ws 的可选加速模块
  external: ['vite', 'bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'info',
});

// 3. 运行说明与启动脚本
step('写入启动脚本与说明');
const write = (rel, text, mode) => {
  const f = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  if (mode) fs.chmodSync(f, mode);
};

write('package.json', JSON.stringify({
  name: NAME,
  version: pkg.version,
  private: true,
  description: pkg.description,
  author: pkg.author,
  license: pkg.license,
  type: 'module',
  engines: { node: '>=20' },
  scripts: { start: 'node server/index.mjs' },
}, null, 2) + '\n');

write('start-mac.command', `#!/bin/bash
# 双击运行：启动泼色竞技场服务器并打开浏览器
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先从 https://nodejs.org 安装 Node.js 20 或更高版本，然后重新双击本文件。"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi
PORT="\${PORT:-8080}"
(sleep 1.5 && open "http://localhost:$PORT") &
PORT="$PORT" node server/index.mjs
`, 0o755);

write('start-linux.sh', `#!/bin/bash
# 启动泼色竞技场服务器并打开浏览器
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 20 或更高版本：https://nodejs.org"
  exit 1
fi
PORT="\${PORT:-8080}"
(sleep 1.5 && xdg-open "http://localhost:$PORT" >/dev/null 2>&1) &
PORT="$PORT" node server/index.mjs
`, 0o755);

write('start-windows.bat', [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  'where node >nul 2>nul',
  'if errorlevel 1 (',
  '  echo Node.js not found. Please install Node.js 20+ from https://nodejs.org and try again.',
  '  pause',
  '  exit /b 1',
  ')',
  'if "%PORT%"=="" set PORT=8080',
  'start "" /b cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%"',
  'node server\\index.mjs',
  'pause',
  '',
].join('\r\n'));

write('README.txt', `泼色竞技场 v${pkg.version} —— 局域网实时联机团队涂地对战
源代码：https://github.com/dogeheng/local-splatoon

【运行前提】
只有开服务器的那台电脑需要安装 Node.js 20 或更高版本（https://nodejs.org）。
其他玩家只需要一台装有现代浏览器（Chrome / Edge / Firefox / Safari）的电脑，不需要安装任何东西。

【启动】
  macOS   ：双击 start-mac.command
             （如果从网上下载后提示"无法打开"，请右键点击该文件 → 打开 → 再次确认打开）
  Windows ：双击 start-windows.bat
  Linux   ：在终端运行 ./start-linux.sh
  命令行  ：node server/index.mjs        （换端口：PORT=9000 node server/index.mjs）

启动后会自动打开浏览器。终端窗口里会显示"局域网访问"地址（例如 http://192.168.1.10:8080），
同一 Wi-Fi / 路由器下的其他电脑用浏览器打开这个地址即可加入。
第一次运行时，如果系统询问是否允许 node 接受传入网络连接，请选择"允许"。
关闭终端窗口（或按 Ctrl+C）即停止服务器。

【开一局】
1. 点"创建房间"；可以先在场地里热身。
2. 点"复制邀请"把链接发给朋友，或让他扫二维码，或在首页输入 5 位房间码。
3. 其他人点"准备"，房主点"开始对战"。3 分钟后涂地面积大的一队获胜。
4. 结算后所有人点"再来一局"立即开下一局。
每局 2～4 名玩家（1v1、1v2、2v2），另外最多 4 名观战者。

【操作】
  WASD 移动    鼠标 瞄准    左键 喷墨    Shift 潜游（己方墨水中加速、补墨、隐身）
  右键 按住瞄准、松开投掷炸弹    E 能量满时释放大招    Tab 查看队伍    M 静音    F3 网络调试面板

【刷新与掉线】
刷新页面或短暂断网会自动回到原座位；掉线 60 秒内座位保留，期间角色免伤；
对局中一队全部离线超过 10 秒判对方获胜。

【目录】
  server/index.mjs   游戏服务器（已打包为单文件，无需 npm install）
  dist/client/       游戏网页、贴图与音乐
  LICENSE            MIT 许可证
  THIRD_PARTY_LICENSES.txt  所用开源库的许可证
`);

fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE'));

// 4. 第三方许可证（打包进前端与服务器的库）
const thirdParty = [
  ['three', 'LICENSE'],
  ['qrcode', 'license'],
  ['dijkstrajs', 'LICENSE.md'],
  ['ws', 'LICENSE'],
  ['zod', 'LICENSE'],
];
let tp = '本软件打包包含以下开源库，其许可证全文如下。\n';
for (const [name, file] of thirdParty) {
  const dir = path.join(ROOT, 'node_modules', name);
  const ver = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  tp += `\n${'='.repeat(72)}\n${name} ${ver}\n${'='.repeat(72)}\n\n${fs.readFileSync(path.join(dir, file), 'utf8').trim()}\n`;
}
write('THIRD_PARTY_LICENSES.txt', tp);

// 5. 压缩
step('压缩');
const zip = path.join(OUT_ROOT, `${NAME}.zip`);
execFileSync('zip', ['-r', '-X', '-q', zip, NAME, '-x', '*.DS_Store'], { cwd: OUT_ROOT, stdio: 'inherit' });
const size = (fs.statSync(zip).size / 1024 / 1024).toFixed(2);
console.log(`\n完成：${zip}（${size} MB）`);
