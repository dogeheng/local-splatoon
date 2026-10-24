import { BOMB_COST, INK_MAX, TEAM_COLORS, TEAM_NAMES } from '../../../shared/constants';
import type { GameClient } from '../game/game';
import { h } from './dom';

export type HudMode = 'none' | 'lobby' | 'match';

const fmt = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export class Hud {
  readonly el: HTMLDivElement;
  private top: HTMLDivElement;
  private teamEls: HTMLDivElement[];
  private timer: HTMLDivElement;
  private bottom: HTMLDivElement;
  private inkFill: HTMLDivElement;
  private inkBar: HTMLDivElement;
  private inkLbl: HTMLSpanElement;
  private specEl: HTMLDivElement;
  private specArc: SVGCircleElement;
  private specKey: HTMLSpanElement;
  private respawn: HTMLDivElement;
  private vignette: HTMLDivElement;
  private feed: HTMLDivElement;
  private board: HTMLDivElement;
  private bannerEl: HTMLDivElement;
  private bannerTimer = 0;
  private netDot: HTMLDivElement;
  private debug: HTMLDivElement;
  private mode: HudMode = 'none';
  private rosterKey = '';
  showDebug = false;

  constructor() {
    this.teamEls = [h('div', { class: 'hud-team t0' }), h('div', { class: 'hud-team t1' })];
    this.timer = h('div', { class: 'timer', text: '3:00' });
    this.top = h('div', { class: 'hud-top' }, [this.teamEls[0], this.timer, this.teamEls[1]]);

    this.inkFill = h('div', { class: 'fill' });
    this.inkBar = h('div', { class: 'bar' }, [this.inkFill, h('div', { class: 'mark', style: { left: `${(BOMB_COST / INK_MAX) * 100}%` } })]);
    this.inkLbl = h('span', { text: '100%' });
    const gauge = h('div', { class: 'panel gauge' }, [
      h('div', { class: 'lbl' }, [h('span', { text: '墨水  ·  白线 = 炸弹所需' }), this.inkLbl]),
      this.inkBar,
    ]);
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 86 86');
    const bg = document.createElementNS(svgNS, 'circle');
    bg.setAttribute('cx', '43'); bg.setAttribute('cy', '43'); bg.setAttribute('r', '36');
    bg.setAttribute('fill', 'none'); bg.setAttribute('stroke', '#3b3060'); bg.setAttribute('stroke-width', '9');
    this.specArc = document.createElementNS(svgNS, 'circle');
    this.specArc.setAttribute('cx', '43'); this.specArc.setAttribute('cy', '43'); this.specArc.setAttribute('r', '36');
    this.specArc.setAttribute('fill', 'none'); this.specArc.setAttribute('stroke', '#c6f432'); this.specArc.setAttribute('stroke-width', '9');
    this.specArc.setAttribute('stroke-linecap', 'round');
    this.specArc.setAttribute('stroke-dasharray', `${2 * Math.PI * 36}`);
    svg.append(bg, this.specArc);
    this.specKey = h('span', { class: 'k', text: 'E' });
    this.specEl = h('div', { class: 'special' }, [svg as unknown as HTMLElement, this.specKey]);
    this.bottom = h('div', { class: 'hud-bottom' }, [gauge, this.specEl]);

    this.respawn = h('div', { class: 'respawn-msg hidden' });
    this.vignette = h('div', { class: 'vignette' });
    this.feed = h('div', { class: 'killfeed' });
    this.board = h('div', { class: 'panel scoreboard hidden' });
    this.bannerEl = h('div', { class: 'banner hidden' });
    this.netDot = h('div', { class: 'net-dot', attrs: { title: '网络状态' } });
    this.debug = h('div', { class: 'debug hidden' });
    this.el = h('div', { style: { position: 'absolute', inset: '0', pointerEvents: 'none' } }, [
      this.vignette, this.top, this.bottom, this.respawn, this.feed, this.board, this.bannerEl, this.netDot, this.debug,
    ]);
    this.setMode('none');
  }

  setMode(m: HudMode): void {
    this.mode = m;
    this.el.className = `hud-root mode-${m}`;
    this.el.style.display = m === 'none' ? 'none' : '';
    this.top.style.display = m === 'match' ? '' : 'none';
  }

  banner(text: string, kind: 'big' | 'small' = 'big'): void {
    clearTimeout(this.bannerTimer);
    const b = this.bannerEl;
    b.textContent = text;
    b.className = `banner pop${kind === 'small' ? ' small' : ''}`;
    // 重新触发动画
    void b.offsetWidth;
    this.bannerTimer = window.setTimeout(() => b.classList.add('hidden'), kind === 'small' ? 1600 : 900);
  }

  kill(by: { name: string; team: number } | null, victim: { name: string; team: number }): void {
    const row = h('div', { class: 'kf' }, by
      ? [h('span', { class: `a${by.team}`, text: by.name }), ' 击倒了 ', h('span', { class: `a${victim.team}`, text: victim.name })]
      : [h('span', { class: `a${victim.team}`, text: victim.name }), ' 被击倒了']);
    this.feed.prepend(row);
    while (this.feed.children.length > 5) this.feed.lastChild?.remove();
    setTimeout(() => row.remove(), 4500);
  }

  update(g: GameClient): void {
    if (this.mode === 'none') return;
    // 计时
    if (this.mode === 'match') {
      const left = g.timeLeftMs();
      this.timer.textContent = left === null ? '' : fmt(left);
      this.timer.classList.toggle('hurry', g.phase === 'playing' && left !== null && left <= 60000);
      // 队伍图标
      const rosters = [g.roster(0), g.roster(1)];
      const key = JSON.stringify(rosters.map((r) => r.map((p) => [p.id, p.dead, Math.ceil(p.respawnS), p.special, p.offline])));
      if (key !== this.rosterKey) {
        this.rosterKey = key;
        for (let t = 0; t < 2; t++) {
          this.teamEls[t].replaceChildren(...rosters[t].map((p) => h('div', {
            class: `hud-icon t${t}${p.dead ? ' dead' : ''}${p.offline ? ' off' : ''}${p.special ? ' sp' : ''}`,
            attrs: { title: p.name },
          }, [
            p.dead ? null : h('span', { text: Array.from(p.name).slice(0, 2).join('') || '?', style: { fontSize: Array.from(p.name).length > 1 ? '13px' : '16px' } }),
            p.dead ? h('span', { class: 'rt', text: `${Math.ceil(p.respawnS)}` }) : null,
          ])));
        }
      }
    }
    // 自己的状态
    const me = g.meInfo();
    this.bottom.style.display = me ? '' : 'none';
    if (me) {
      const team = g.myTeam;
      const ink = Math.max(0, Math.min(100, me.ink));
      this.inkFill.style.width = `${ink}%`;
      this.inkFill.style.background = TEAM_COLORS[team] ?? '#fff';
      this.inkLbl.textContent = me.special ? '无限墨水！' : `${Math.floor(ink)}%`;
      this.inkBar.classList.toggle('low', ink < 12 && !me.special);
      const full = me.gauge >= 100;
      const c = 2 * Math.PI * 36;
      this.specArc.setAttribute('stroke-dashoffset', `${c * (1 - Math.min(1, me.special ? me.specialS / 6 : me.gauge / 100))}`);
      this.specEl.classList.toggle('full', full && !me.special);
      this.specEl.style.background = full && !me.special ? '#c6f432' : '';
      this.specKey.textContent = me.special ? `${Math.ceil(me.specialS)}` : full ? 'E!' : 'E';
      this.respawn.classList.toggle('hidden', !me.dead);
      if (me.dead) this.respawn.textContent = `被击倒了… ${Math.max(0, me.respawnS).toFixed(1)} 秒后复活`;
      const danger = me.dead ? 0 : Math.max(0, (60 - me.hp) / 60);
      const enemy = TEAM_COLORS[1 - team] ?? '#ff4d6d';
      this.vignette.style.opacity = `${danger * 0.9}`;
      this.vignette.style.background = `radial-gradient(ellipse at center, transparent 55%, ${enemy}cc 100%)`;
    } else {
      this.respawn.classList.add('hidden');
      this.vignette.style.opacity = '0';
    }
    // 计分板
    const showBoard = g.controls.tabHeld && g.lobby;
    this.board.classList.toggle('hidden', !showBoard);
    if (showBoard && g.lobby) {
      const rows = g.lobby.players.map((p) => h('tr', {}, [
        h('td', { text: p.role === 'player' ? TEAM_NAMES[p.team] : '观战', style: { color: p.role === 'player' ? TEAM_COLORS[p.team] : 'var(--muted)' } }),
        h('td', { text: p.name + (p.id === g.me ? '（我）' : '') }),
        h('td', { text: p.online ? '在线' : '离线', style: { color: p.online ? 'var(--lime)' : 'var(--danger)' } }),
      ]));
      this.board.replaceChildren(h('table', {}, [
        h('tr', {}, [h('th', { text: '队伍' }), h('th', { text: '玩家' }), h('th', { text: '状态' })]),
        ...rows,
      ]));
    }
    // 网络
    const rtt = g.net.clock.rtt;
    this.netDot.className = `net-dot${rtt > 120 ? ' bad' : rtt > 50 ? ' warn' : ''}`;
    this.netDot.title = `延迟 ${rtt.toFixed(0)} ms`;
    this.debug.classList.toggle('hidden', !this.showDebug);
    if (this.showDebug) this.debug.textContent = g.debugText();
  }
}
