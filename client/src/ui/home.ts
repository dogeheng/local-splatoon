import { NAME_MAX, ROOM_CODE_LEN } from '../../../shared/constants';
import type { RoomListing } from '../../../shared/protocol';
import { h } from './dom';

const NAMES = ['橙子汽水', '薄荷泡泡', '乌贼小队长', '墨水旋风', '涂地达人', '青柠炸弹', '果冻枪手', '泼色小将', '颜料猎手', '彩虹鱿鱼'];

export function defaultName(): string {
  const saved = localStorage.getItem('sa.name');
  if (saved) return saved;
  return NAMES[Math.floor(Math.random() * NAMES.length)];
}

export interface HomeHandlers {
  onCreate: (name: string) => void;
  onJoin: (code: string, name: string) => void;
}

const PHASE_TEXT: Record<string, string> = { lobby: '等待中', countdown: '即将开始', playing: '对战中', results: '结算中' };

export class HomeView {
  readonly el: HTMLDivElement;
  private nameInput: HTMLInputElement;
  private codeInput: HTMLInputElement;
  private list: HTMLDivElement;
  private lanText: HTMLDivElement;
  private timer = 0;
  private busy = false;

  constructor(private handlers: HomeHandlers, presetCode = '', notice = '') {
    this.nameInput = h('input', { class: 'field', attrs: { maxlength: String(NAME_MAX), placeholder: '你的昵称', spellcheck: 'false' } });
    this.nameInput.value = defaultName();
    this.codeInput = h('input', {
      class: 'field code-input',
      attrs: { maxlength: String(ROOM_CODE_LEN), placeholder: '房间码', spellcheck: 'false', autocomplete: 'off' },
    });
    this.codeInput.value = presetCode;
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
    });
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.join();
    });
    this.list = h('div', { class: 'room-list' });
    this.lanText = h('div');

    const createBtn = h('button', { class: 'btn orange big', text: '创建房间', on: { click: () => this.create() } });
    const joinBtn = h('button', { class: 'btn cyan', text: '加入', on: { click: () => this.join() } });

    this.el = h('div', { class: 'home' }, [
      h('div', { class: 'panel home-card' }, [
        h('h1', { class: 'title' }, [h('span', { class: 't1', text: '泼色' }), h('span', { class: 't2', text: '竞技场' })]),
        h('div', { class: 'subtitle', text: '局域网 · 团队涂地对战 · 最多 2 对 2' }),
        notice ? h('div', { class: 'hint', text: notice, style: { color: 'var(--lime)', marginBottom: '10px' } }) : null,
        h('div', { class: 'label', text: '昵称' }),
        this.nameInput,
        h('div', { class: 'home-row' }, [
          h('div', { class: 'grow' }, [createBtn]),
        ]),
        h('div', { class: 'home-row' }, [
          h('div', { class: 'grow' }, [h('div', { class: 'label', text: '已有房间码？' }), this.codeInput]),
          joinBtn,
        ]),
        h('div', { class: 'rooms' }, [
          h('div', { class: 'rooms-title' }, [h('span', { text: '局域网中的房间' }), h('span', { text: '每 2 秒刷新' })]),
          this.list,
        ]),
        h('div', { class: 'home-foot' }, [this.lanText, h('div', { text: 'WASD 移动 · 鼠标瞄准 · 左键喷墨 · Shift 潜游 · 右键炸弹 · E 大招 · M 静音' })]),
      ]),
    ]);
    (createBtn.parentElement as HTMLElement).style.display = 'flex';
    createBtn.style.width = '100%';
    if (presetCode) setTimeout(() => joinBtn.focus(), 50);

    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), 2000);
    void this.loadInfo();
  }

  private name(): string {
    const n = this.nameInput.value.trim() || defaultName();
    localStorage.setItem('sa.name', n);
    return n;
  }

  private create(): void {
    if (this.busy) return;
    this.busy = true;
    this.handlers.onCreate(this.name());
    setTimeout(() => (this.busy = false), 1500);
  }

  private join(code = this.codeInput.value): void {
    const c = code.trim().toUpperCase();
    if (c.length !== ROOM_CODE_LEN) {
      this.codeInput.focus();
      this.codeInput.style.borderColor = 'var(--danger)';
      setTimeout(() => (this.codeInput.style.borderColor = ''), 800);
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.handlers.onJoin(c, this.name());
    setTimeout(() => (this.busy = false), 1500);
  }

  private async refresh(): Promise<void> {
    let rooms: RoomListing[] = [];
    try {
      const res = await fetch('/api/rooms', { cache: 'no-store' });
      rooms = await res.json();
    } catch {
      return;
    }
    this.list.replaceChildren();
    if (!rooms.length) {
      this.list.append(h('div', { class: 'empty', text: '还没有房间，创建一个吧。' }));
      return;
    }
    for (const r of rooms) {
      const canPlay = r.phase === 'lobby' && r.players < 4;
      this.list.append(h('div', { class: 'room-item' }, [
        h('span', { class: 'code', text: r.code }),
        h('span', { class: 'meta', text: `${r.host || '—'} 的房间 · ${r.players}/4 人${r.spectators ? ` · ${r.spectators} 观战` : ''} · ${PHASE_TEXT[r.phase] ?? ''}` }),
        h('button', {
          class: `btn small ${canPlay ? 'cyan' : 'ghost'}`,
          text: canPlay ? '加入' : '观战',
          on: { click: () => this.join(r.code) },
        }),
      ]));
    }
  }

  private async loadInfo(): Promise<void> {
    try {
      const res = await fetch('/api/info', { cache: 'no-store' });
      const info: { lan: string[] } = await res.json();
      if (info.lan.length) this.lanText.textContent = `同一局域网的其他电脑，用浏览器打开：${info.lan.join(' 或 ')}`;
    } catch { /* ignore */ }
  }

  destroy(): void {
    clearInterval(this.timer);
    this.el.remove();
  }
}
