type Child = Node | string | null | undefined | false;

interface Props {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: any) => void>>;
}

/** 安全的元素构造：用户数据一律走 textContent，不拼接 HTML。 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) el.setAttribute(k, v);
  if (props.style) Object.assign(el.style, props.style);
  if (props.on) for (const [k, fn] of Object.entries(props.on)) el.addEventListener(k, fn as EventListener);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

let toastWrap: HTMLDivElement | null = null;

export function toast(msg: string, ms = 2600): void {
  if (!toastWrap) {
    toastWrap = h('div', { class: 'toast-wrap' });
    document.getElementById('ui')!.appendChild(toastWrap);
  }
  const t = h('div', { class: 'toast', text: msg });
  toastWrap.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export interface ModalButton { label: string; cls?: string; onClick?: () => void }

export function modal(title: string, body: string, buttons: ModalButton[]): () => void {
  const root = document.getElementById('ui')!;
  const close = () => wrap.remove();
  const wrap = h('div', { class: 'modal' }, [
    h('div', { class: 'panel modal-card' }, [
      h('h3', { text: title }),
      h('p', { text: body }),
      h('div', { class: 'btns' }, buttons.map((b) => h('button', {
        class: `btn ${b.cls ?? ''}`,
        text: b.label,
        on: { click: () => { close(); b.onClick?.(); } },
      }))),
    ]),
  ]);
  root.appendChild(wrap);
  return close;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文（局域网 http）下的兜底方案
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}
