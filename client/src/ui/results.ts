import { TEAM_NAMES } from '../../../shared/constants';
import type { LobbyMsg, ResultMsg } from '../../../shared/protocol';
import { h } from './dom';

export interface ResultsCtx {
  me: number;
  myTeam: number;
  isPlayer: boolean;
  serverNow: () => number;
  onAgain: () => void;
  onLeave: () => void;
  onTick: () => void;
  onReveal: (winner: number) => void;
}

export class ResultsView {
  readonly el: HTMLDivElement;
  private timers: number[] = [];
  private raf = 0;
  private voteText: HTMLDivElement | null = null;
  private againBtn: HTMLButtonElement | null = null;
  private countdown: HTMLSpanElement | null = null;
  private until = 0;
  private ctx: ResultsCtx | null = null;
  private clockTimer = 0;

  constructor() {
    this.el = h('div', { class: 'results hidden' });
  }

  show(r: ResultMsg, ctx: ResultsCtx, lobby: LobbyMsg | null): void {
    this.hide();
    this.ctx = ctx;
    this.until = r.until;
    this.el.classList.remove('hidden');

    const pcts = [h('div', { class: 'pc', text: '0.0%' }), h('div', { class: 'pc', text: '0.0%' })];
    const barO = h('div', { class: 'o' });
    const barC = h('div', { class: 'c' });
    const winner = h('div', { class: 'winner' });
    const title = h('div', { class: 'judge-title', text: '评 判 中 …' });
    const lower = h('div', { style: { opacity: '0' } });

    const card = h('div', { class: 'panel results-card' }, [
      title,
      h('div', { class: 'versus' }, [0, 1].map((t) => h('div', { class: `vs-col t${t}` }, [
        h('div', { class: 'tn', text: TEAM_NAMES[t] + (ctx.myTeam === t ? '（我方）' : '') }),
        pcts[t],
      ]))),
      h('div', { class: 'result-bar' }, [barO, h('div', { class: 'gap' }), barC]),
      winner,
      lower,
    ]);
    this.el.replaceChildren(card);

    // 1. 两条颜料条同时增长
    this.timers.push(window.setTimeout(() => {
      barO.style.width = `${r.pct[0]}%`;
      barC.style.width = `${r.pct[1]}%`;
      const t0 = performance.now();
      let lastTick = 0;
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / 2400);
        const e = 1 - Math.pow(1 - k, 3);
        pcts[0].textContent = `${(r.pct[0] * e).toFixed(1)}%`;
        pcts[1].textContent = `${(r.pct[1] * e).toFixed(1)}%`;
        if (performance.now() - lastTick > 90 && k < 0.95) {
          lastTick = performance.now();
          ctx.onTick();
        }
        if (k < 1) this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    }, 500));

    // 2. 揭晓胜负
    this.timers.push(window.setTimeout(() => {
      title.textContent = r.reason === 'forfeit' ? '对 手 弃 权' : '最 终 结 果';
      if (r.winner < 0) {
        winner.textContent = '平局！';
      } else {
        winner.textContent = `${TEAM_NAMES[r.winner]}胜利！`;
        winner.classList.add(`t${r.winner}`);
      }
      winner.classList.add('show');
      ctx.onReveal(r.winner);
    }, 3100));

    // 3. 数据与操作
    this.timers.push(window.setTimeout(() => {
      const sorted = [...r.stats].sort((a, b) => a.team - b.team || b.paint - a.paint);
      const mvp = r.stats.reduce((a, b) => (b.paint > (a?.paint ?? -1) ? b : a), r.stats[0]);
      const table = h('table', { class: 'stats' }, [
        h('tr', {}, ['玩家', '涂地格数', '击倒', '被击倒'].map((t) => h('th', { text: t }))),
        ...sorted.map((s) => h('tr', {}, [
          h('td', { class: `t${s.team}`, text: `${s.name}${s.id === ctx.me ? '（我）' : ''}${mvp && s.id === mvp.id ? ' ★' : ''}` }),
          h('td', { text: String(s.paint) }),
          h('td', { text: String(s.splats) }),
          h('td', { text: String(s.deaths) }),
        ])),
      ]);
      this.countdown = h('span');
      this.voteText = h('div', { class: 'hint' });
      this.againBtn = ctx.isPlayer
        ? h('button', { class: 'btn big', text: '再来一局', on: { click: () => this.vote() } })
        : null;
      lower.replaceChildren(
        table,
        h('div', { class: 'series', style: { marginTop: '14px' } }, [
          h('span', { text: '本房间战绩' }),
          h('span', { class: 'o', text: `橙 ${r.wins[0]}` }),
          h('span', { text: ':' }),
          h('span', { class: 'c', text: `${r.wins[1]} 青` }),
        ]),
        h('div', { class: 'results-actions' }, [
          this.againBtn,
          h('button', { class: 'btn ghost', text: '离开房间', on: { click: () => ctx.onLeave() } }),
        ]),
        this.voteText,
        h('div', { class: 'hint' }, [this.countdown]),
      );
      lower.style.opacity = '1';
      lower.classList.add('fade-in');
      this.updateVotes(lobby);
      this.tickClock();
      this.clockTimer = window.setInterval(() => this.tickClock(), 250);
    }, 3700));
  }

  private vote(): void {
    if (!this.againBtn || this.againBtn.disabled) return;
    this.ctx?.onAgain();
    this.againBtn.disabled = true;
    this.againBtn.textContent = '已准备';
  }

  private tickClock(): void {
    if (!this.countdown || !this.ctx) return;
    const s = Math.max(0, Math.ceil((this.until - this.ctx.serverNow()) / 1000));
    this.countdown.textContent = `${s} 秒后回到房间大厅（所有人都点“再来一局”会立即开始）`;
  }

  updateVotes(l: LobbyMsg | null): void {
    if (!l || !this.voteText) return;
    const ps = l.players.filter((p) => p.role === 'player' && p.online);
    const n = ps.filter((p) => p.again).length;
    this.voteText.textContent = `再来一局：${n}/${ps.length} 人已准备`;
    const mine = l.players.find((p) => p.id === this.ctx?.me);
    if (mine?.again && this.againBtn) {
      this.againBtn.disabled = true;
      this.againBtn.textContent = '已准备';
    }
  }

  hide(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    cancelAnimationFrame(this.raf);
    clearInterval(this.clockTimer);
    this.el.classList.add('hidden');
    this.voteText = null;
    this.againBtn = null;
    this.countdown = null;
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }
}
