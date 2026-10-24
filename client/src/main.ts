import './styles.css';
import { CLOSE, ROOM_CODE_LEN } from '../../shared/constants';
import type { LobbyMsg, Phase, ServerMsg } from '../../shared/protocol';
import { Sfx } from './audio/sfx';
import { Net, savedToken, type NetState } from './net/connection';
import { GameClient } from './game/game';
import { HomeView, defaultName } from './ui/home';
import { LobbyView } from './ui/lobby';
import { Hud } from './ui/hud';
import { ResultsView } from './ui/results';
import { h, modal, toast } from './ui/dom';

const ui = document.getElementById('ui')!;
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const labels = document.getElementById('labels')!;

const sfx = new Sfx();
let lan: string[] = [];
let home: HomeView | null = null;
let lastLobby: LobbyMsg | null = null;
let welcomed = false;
let resultsDelay = 0;

const net = new Net({ onMessage, onState });
const hud = new Hud();
const results = new ResultsView();
const netBanner = h('div', { class: 'net-banner hidden', text: '连接中断，正在重连…' });

const game = new GameClient(canvas, labels, sfx, net, {
  onKill: (by, victim) => hud.kill(by, victim),
  onBanner: (text, kind) => hud.banner(text, kind),
  onPhase: (ph, prev) => onPhaseChange(ph, prev),
});
game.controls.onDebugToggle = () => (hud.showDebug = !hud.showDebug);
game.controls.onMuteToggle = () => toast(sfx.toggleMute() ? '已静音（按 M 恢复）' : '声音已开启');

const lobbyView = new LobbyView({
  onReady: (r) => {
    net.send({ t: 'ready', r });
    if (r) sfx.play('ready');
  },
  onStart: () => net.send({ t: 'start' }),
  onTeam: (t) => net.send({ t: 'team', team: t }),
  onRoundSec: (s) => net.send({ t: 'set', roundSec: s }),
  onLeave: () => leaveRoom(),
  onClick: () => sfx.play('click'),
});

ui.append(hud.el, lobbyView.warmup, lobbyView.controlsCard, lobbyView.el, results.el, netBanner);

// ---------------------------------------------------------------- 界面切换

function showHome(presetCode = '', notice = ''): void {
  home?.destroy();
  home = new HomeView({
    onCreate: (name) => {
      sfx.play('click');
      net.create(name);
    },
    onJoin: (code, name) => {
      sfx.play('click');
      net.join(code, name);
    },
  }, presetCode, notice);
  ui.appendChild(home.el);
  setRoomUi(false);
  game.scene.setInsets({ left: 0, right: 0, top: 0, bottom: 0 });
}

function setRoomUi(inRoom: boolean): void {
  const ph = game.phase;
  const lobby = inRoom && ph === 'lobby';
  lobbyView.el.classList.toggle('hidden', !lobby);
  lobbyView.warmup.classList.toggle('hidden', !lobby);
  lobbyView.controlsCard.classList.toggle('hidden', !lobby);
  hud.setMode(!inRoom ? 'none' : ph === 'countdown' || ph === 'playing' ? 'match' : ph === 'lobby' ? 'lobby' : 'none');
  if (!inRoom) results.hide();
  if (inRoom) {
    if (lobby) game.scene.setInsets({ left: 0, right: 410, top: 60, bottom: 10 });
    else game.scene.setInsets({ left: 0, right: 0, top: 70, bottom: 120 });
  }
}

function onPhaseChange(ph: Phase, _prev: Phase): void {
  if (!game.inRoom) return;
  clearTimeout(resultsDelay);
  if (ph !== 'results') results.hide();
  setRoomUi(true);
}

function enterUrl(code: string): void {
  const u = new URL(location.href);
  u.searchParams.set('room', code);
  history.replaceState(null, '', u.toString());
}

function clearUrl(): void {
  history.replaceState(null, '', location.pathname);
}

function leaveRoom(): void {
  net.leave();
  welcomed = false;
  game.leaveRoom();
  clearUrl();
  showHome();
}

// ---------------------------------------------------------------- 消息

function onMessage(m: ServerMsg): void {
  switch (m.t) {
    case 'welcome':
      welcomed = true;
      lan = m.lan;
      home?.destroy();
      home = null;
      game.enterRoom(m);
      enterUrl(m.room);
      setRoomUi(true);
      break;
    case 'lobby':
      lastLobby = m;
      game.onLobby(m);
      lobbyView.update(m, game.me, lan);
      results.updateVotes(m);
      setRoomUi(true);
      break;
    case 'cd':
      game.onCountdown(m);
      setRoomUi(true);
      break;
    case 's':
      game.onSnapshot(m);
      break;
    case 'result': {
      game.onResult(m);
      clearTimeout(resultsDelay);
      resultsDelay = window.setTimeout(() => {
        if (game.phase !== 'results') return;
        results.show(m, {
          me: game.me,
          myTeam: game.myTeam,
          isPlayer: game.role === 'player',
          serverNow: () => net.clock.serverNow(),
          onAgain: () => {
            sfx.play('ready');
            net.send({ t: 'again' });
          },
          onLeave: () => leaveRoom(),
          onTick: () => sfx.play('tick'),
          onReveal: (winner) => {
            const good = game.myTeam < 0 || winner === game.myTeam;
            sfx.play(winner < 0 ? 'respawn' : good ? 'win' : 'lose');
            if (winner >= 0) for (let i = 0; i < 14; i++) setTimeout(() => {
              game.fx.splash(4 + Math.random() * 32, 0.5, 3 + Math.random() * 18, winner, 26, 6, 1.3);
            }, i * 70);
          },
        }, lastLobby);
      }, 1300);
      break;
    }
    case 'err':
      toast(m.msg);
      break;
  }
}

const CLOSE_TEXT: Record<number, [string, string]> = {
  [CLOSE.REPLACED]: ['已在别处打开', '你在另一个标签页或窗口进入了这个房间，本页已断开。'],
  [CLOSE.VERSION]: ['版本不一致', '服务器上的游戏已更新，请刷新页面。'],
  [CLOSE.FULL]: ['房间已满', '这个房间已有 4 名玩家和 4 名观战者。'],
  [CLOSE.NO_ROOM]: ['房间不可用', '房间不存在，或者你离开太久，座位已被释放。'],
  [CLOSE.INVALID]: ['连接被关闭', '检测到异常数据，连接已被服务器关闭。'],
  [CLOSE.SHUTDOWN]: ['房间已关闭', '服务器关闭了这个房间。'],
};

function onState(s: NetState, info?: { code?: number; reason?: string }): void {
  netBanner.classList.toggle('hidden', s !== 'reconnecting');
  if (s !== 'closed') return;
  const code = info?.code ?? 0;
  const wasInRoom = welcomed;
  welcomed = false;
  if (game.inRoom) game.leaveRoom();
  clearUrl();
  if (code === CLOSE.NORMAL) {
    showHome();
    return;
  }
  const [title, body] = CLOSE_TEXT[code] ?? ['无法连接', info?.reason === 'gave-up' ? '多次重连失败，请确认服务器仍在运行。' : '与服务器的连接已断开。'];
  if (!wasInRoom) {
    if (!home) showHome();
    toast(`${title}：${body}`, 4000);
    return;
  }
  showHome();
  modal(title, body, [{ label: code === CLOSE.VERSION ? '刷新页面' : '好的', onClick: () => { if (code === CLOSE.VERSION) location.reload(); } }]);
}

// 网络恢复或页面切回时立即尝试重连
window.addEventListener('online', () => net.retryNow());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) net.retryNow();
});

// ---------------------------------------------------------------- 启动

const params = new URLSearchParams(location.search);
const urlRoom = (params.get('room') ?? '').toUpperCase();
if (urlRoom.length === ROOM_CODE_LEN && savedToken(urlRoom)) {
  // 刷新页面：用座位令牌直接回到原来的座位
  net.join(urlRoom, defaultName());
  showHome(urlRoom, '正在回到房间…');
} else if (urlRoom.length === ROOM_CODE_LEN) {
  showHome(urlRoom, `你收到了房间 ${urlRoom} 的邀请，确认昵称后点击“加入”`);
} else {
  showHome();
}

let last = performance.now();
function loop(now: number): void {
  const dt = now - last;
  last = now;
  game.frame(dt);
  hud.update(game);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// 便于自动化测试检查状态
(window as unknown as { __game: GameClient }).__game = game;
