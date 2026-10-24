import QRCode from 'qrcode';
import { MAX_PLAYERS, ROUND_SEC_OPTIONS, TEAM_MAX, TEAM_NAMES } from '../../../shared/constants';
import type { LobbyMsg, LobbyPlayer } from '../../../shared/protocol';
import { copyText, h, toast } from './dom';

export interface LobbyHandlers {
  onReady: (r: boolean) => void;
  onStart: () => void;
  onTeam: (t: 0 | 1) => void;
  onRoundSec: (s: number) => void;
  onLeave: () => void;
  onClick: () => void;
}

export function inviteUrl(code: string, lan: string[]): string {
  const host = location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const origin = isLocal && lan.length ? lan[0] : location.origin;
  return `${origin}/?room=${code}`;
}

export class LobbyView {
  readonly el: HTMLDivElement;
  readonly warmup: HTMLDivElement;
  readonly controlsCard: HTMLDivElement;
  private qrFor = '';
  private qrImg: HTMLImageElement;

  constructor(private handlers: LobbyHandlers) {
    this.el = h('div', { class: 'panel lobby' });
    this.qrImg = h('img', { class: 'qr', attrs: { alt: '邀请二维码' } });
    this.warmup = h('div', { class: 'warmup-tag', text: '热身中 · 随便喷，不计分' });
    const row = (k: string, v: string) => h('div', {}, [h('kbd', { text: k }), v]);
    this.controlsCard = h('div', { class: 'panel controls-card' }, [
      row('WASD', '移动'),
      row('鼠标', '瞄准'),
      row('左键', '按住喷墨'),
      row('Shift', '潜游（己方墨水中加速、补墨、隐身）'),
      row('右键', '按住瞄准，松开投掷炸弹'),
      row('E', '能量满时释放大招「墨潮」'),
      row('Tab', '查看队伍'),
    ]);
  }

  update(l: LobbyMsg, me: number, lan: string[]): void {
    const mine = l.players.find((p) => p.id === me);
    const isHost = l.host === me;
    const players = l.players.filter((p) => p.role === 'player');
    const specs = l.players.filter((p) => p.role === 'spectator');
    const url = inviteUrl(l.room, lan);
    if (this.qrFor !== url) {
      this.qrFor = url;
      QRCode.toDataURL(url, { margin: 0, width: 180, color: { dark: '#1b1530', light: '#ffffff' } })
        .then((d: string) => (this.qrImg.src = d))
        .catch(() => {});
    }

    const seat = (team: number, slot: number) => {
      const p = players.find((x) => x.team === team && x.slot === slot);
      if (!p) {
        const canMove = mine?.role === 'player' && mine.team !== team && l.phase === 'lobby';
        return h('div', {
          class: 'seat empty-seat',
          text: canMove ? '点击换到这里' : '等待加入…',
          style: canMove ? { cursor: 'pointer' } : {},
          on: canMove ? { click: () => { this.handlers.onClick(); this.handlers.onTeam(team as 0 | 1); } } : {},
        });
      }
      return this.seatEl(p, l, me);
    };

    const teamCol = (t: number) => h('div', { class: `team-col t${t}` }, [
      h('div', { class: 'team-head' }, [
        h('span', { text: TEAM_NAMES[t] }),
        h('span', { text: `${players.filter((p) => p.team === t).length}/${TEAM_MAX}`, style: { fontSize: '13px', opacity: '0.8' } }),
      ]),
      ...Array.from({ length: TEAM_MAX }, (_, s) => seat(t, s)),
    ]);

    // 主按钮
    let primary: HTMLButtonElement;
    let hint = '';
    const online = players.filter((p) => p.online);
    const bothTeams = online.some((p) => p.team === 0) && online.some((p) => p.team === 1);
    if (mine?.role !== 'player') {
      primary = h('button', { class: 'btn ghost big', text: '观战中', attrs: { disabled: '' } });
      hint = players.length >= MAX_PLAYERS ? '玩家已满，有空位时会自动入座' : '下一局开始前会自动入座';
    } else if (isHost) {
      const notReady = online.filter((p) => p.id !== me && !p.ready);
      const ok = bothTeams && notReady.length === 0;
      primary = h('button', {
        class: 'btn big', text: '开始对战',
        on: { click: () => { this.handlers.onClick(); this.handlers.onStart(); } },
      });
      if (!ok) primary.disabled = true;
      hint = !bothTeams ? '两队各至少需要 1 人。把邀请链接发给朋友吧！' : notReady.length ? `等待 ${notReady.map((p) => p.name).join('、')} 准备` : '所有人都准备好了！';
    } else {
      primary = h('button', {
        class: `btn big ${mine.ready ? 'ghost' : ''}`,
        text: mine.ready ? '取消准备' : '准备',
        on: { click: () => { this.handlers.onClick(); this.handlers.onReady(!mine.ready); } },
      });
      hint = mine.ready ? '等待房主开始…' : '准备好后房主就可以开始了';
    }

    const seg = h('div', { class: 'seg' }, ROUND_SEC_OPTIONS.map((s) => {
      const b = h('button', {
        class: l.roundSec === s ? 'on' : '',
        text: `${s / 60} 分钟`,
        on: { click: () => { if (isHost && l.roundSec !== s) { this.handlers.onClick(); this.handlers.onRoundSec(s); } } },
      });
      if (!isHost) b.disabled = true;
      return b;
    }));

    const parts: (HTMLElement | null)[] = [
      h('div', { class: 'room-code-box' }, [
        h('div', {}, [
          h('div', { class: 'label', text: '房间码' }),
          h('div', { class: 'room-code', text: l.room }),
        ]),
        this.qrImg,
      ]),
      h('div', { class: 'invite-row' }, [
        h('div', { class: 'invite-url', text: url, attrs: { title: url } }),
        h('button', {
          class: 'btn small cyan', text: '复制邀请',
          on: { click: async () => { this.handlers.onClick(); toast((await copyText(url)) ? '邀请链接已复制，发给同一局域网的朋友吧' : '复制失败，请手动复制'); } },
        }),
      ]),
      h('div', { class: 'teams' }, [teamCol(0), teamCol(1)]),
      specs.length ? h('div', { class: 'spectators', text: `观战：${specs.map((s) => s.name).join('、')}` }) : null,
      l.wins[0] + l.wins[1] > 0 ? h('div', { class: 'series' }, [
        h('span', { text: '本房间战绩' }),
        h('span', { class: 'o', text: `橙 ${l.wins[0]}` }),
        h('span', { text: ':' }),
        h('span', { class: 'c', text: `${l.wins[1]} 青` }),
      ]) : null,
      h('div', {}, [h('div', { class: 'label', text: isHost ? '对局时长（房主设置）' : '对局时长' }), seg]),
      h('div', { class: 'lobby-actions' }, [
        primary,
        h('div', { class: 'hint', text: hint }),
        h('button', { class: 'btn small ghost', text: '离开房间', on: { click: () => this.handlers.onLeave() } }),
      ]),
    ];
    this.el.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null));
  }

  private seatEl(p: LobbyPlayer, l: LobbyMsg, me: number): HTMLDivElement {
    const isHost = p.id === l.host;
    const status = !p.online ? '连接中断，等待重连…' : isHost ? '房主' : p.ready ? '已准备' : '未准备';
    const cls = !p.online ? 'off' : p.ready || isHost ? 'ok' : '';
    return h('div', { class: `seat${p.id === me ? ' me' : ''}` }, [
      h('div', { class: 'nm' }, [
        isHost ? h('span', { class: 'crown', text: '♛' }) : null,
        h('span', { text: p.name }),
        p.id === me ? h('span', { text: '（我）', style: { color: 'var(--muted)', fontSize: '12px' } }) : null,
      ]),
      h('div', { class: `st ${cls}`, text: status }),
    ]);
  }
}
