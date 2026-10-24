# 开发进度（内部工作记录）

## 已完成
- shared/: constants.ts（全部参数）、math.ts（hash/Rng/segmentCircle/base64）、arena.ts（WALLS 点对称、SPAWNS、spawnPoint、BASE_GRID、PAINTABLE_COUNT、cellAt、resolveCircle、raycastWalls）、paint.ts（PaintGrid：paintCircle/flushDeltas/applyDeltas/loadFull，增量 +idx+1=橙，-(idx+1)=青）、sim.ts（PlayerSim/InputFrame/stepPlayer/shotAngle/traceShot/newSim/copySim/emptyInput）、protocol.ts（zod hello/control，parseInputs，sanitizeName，消息类型）。
- server/: world.ts（World：actors、shots、bombs、damage、splat、special、snapshotPlayers、updateHandicap、frozen）、room.ts（Room：join/seat/resume/disconnected/remove/electHost/fillSeats/handleControl/beginCountdown/finish/checkRematch/backToLobby/update 循环/broadcastSnapshot/listing）、index.ts（startServer：/healthz /api/rooms /api/info，静态或 Vite 中间件，/ws 升级 + Origin 同源校验 + 每 IP 连接上限 + 令牌桶 + 违规计数 + 心跳）、log.ts。
- tests/: shared.test.ts（13）、server.test.ts（11），全部通过。
- client/: index.html、src/styles.css、src/net/connection.ts（Clock、Net：create/join/resume、退避重连、token 存 sessionStorage `sa.tok.<room>`）、src/game/scene.ts（Scene3D：涂色着色器、writePaint、setInsets 镜头自适应、screenToGround、worldToScreen、addShake、render）、src/game/characters.ts（CharacterView.update(CharState)、onShoot、hiddenFromViewer）、src/game/fx.ts（Effects：shot/killShot/splash/ring/bomb/boom/showBombPreview/reticle/update/clear）。

## 快照约定
- `s.p` 每项：[id, x, z, vx, vz, flags, hp, ink, gauge%, aim(0..4095), fireCd, sinceShot, extraTicks]，extraTicks = 死亡时剩余复活步数，否则大招剩余步数。
- flags：F_SWIM 1, F_DEAD 2, F_PROTECT 4, F_SPECIAL 8, F_FIRING 16, F_OFFLINE 32, F_INKED 64, F_HANDICAP 128。
- 事件：shot{id,o,x,z,a,sp,k,seq} hit{id,v,o} bomb{id,o,x,z,tx,tz,k,land,boom,seq} boom{id,o,x,z} splat{v,by,x,z} special{o,x,z} respawn{v,x,z}。
- 事件 tick → 服务器时间：st + (tick - k) * 1000/60。

## 已完成（续）
- 客户端全部模块：game/input.ts、audio/sfx.ts（程序化音效，背景音乐从 /audio/bgm-lobby.mp3、/audio/bgm-battle.mp3 加载，缺失则静默）、game/game.ts、ui/dom.ts、ui/home.ts、ui/lobby.ts、ui/hud.ts、ui/results.ts、main.ts。
- 倒计时消息 cd 携带完整地面 grid（Base64）。
- 端到端验证（scripts/e2e/flow.mjs，Chrome 无头 + Metal）：两端位置差 < 0.01，涂色格数一致，最大校正 0.001，刷新 1 秒内恢复原座位，再来一局正常。
- 服务器 CLI 支持 SA_ROUND_SEC 环境变量缩短对局（仅测试）。

## 待完成（旧列表）
1. client/src/game/input.ts（WASD、鼠标瞄准、左键射击、右键按住预览松开投掷、Shift 潜游、E 大招、Tab 计分板、F3 调试）。
2. client/src/audio/sfx.ts（Web Audio 程序化音效 + 背景音乐加载）。
3. client/src/game/game.ts（GameClient：预测/校正、他人投影、事件→特效/音效、涂色贴图同步、标签）。
4. client/src/ui/*.ts + main.ts（首页、大厅、HUD、结算、提示、断线横幅、弹窗）。
5. 构建、Playwright 双浏览器截图验证、调参、背景音乐、README。

## 收尾（已完成）
- 背景音乐 client/public/audio/bgm-lobby.mp3（92 秒）、bgm-battle.mp3（122 秒），循环播放，最后 1 分钟对战音乐 1.1 倍速。
- README.md 中文启动与玩法说明。
- 2v2 + 观战（scripts/e2e/combat.mjs）：自动分队、5 个客户端涂色格数一致。
- 击倒（scripts/e2e/kill.mjs）：命中、击倒播报、复活倒计时、回出生点。
- 离线玩家免伤且不阻挡子弹；两队都全员离线时按涂地面积结算。
- 出生点预涂改为规则圆，双方格数完全相同。
- 测试 29 项全部通过（tests/world.test.ts 新增 5 项）。
