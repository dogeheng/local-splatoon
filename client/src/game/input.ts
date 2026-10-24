/** 键盘 + 鼠标输入。移动用物理键位（e.code），与输入法和键盘布局无关。 */
export class Controls {
  private keys = new Set<string>();
  mouseX = window.innerWidth / 2;
  mouseY = window.innerHeight / 2;
  fireHeld = false;
  bombHeld = false;
  private bombRelease = false;
  private specialPress = false;
  tabHeld = false;
  enabled = true;
  onDebugToggle: (() => void) | null = null;
  onMuteToggle: (() => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (this.isTyping(e)) return;
      if (e.code === 'Tab') {
        e.preventDefault();
        this.tabHeld = true;
      }
      if (e.code === 'F3') {
        e.preventDefault();
        this.onDebugToggle?.();
      }
      if (e.code === 'KeyM' && !e.repeat) this.onMuteToggle?.();
      if (e.code === 'KeyE' && !e.repeat) this.specialPress = true;
      if (e.code === 'Space') e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') this.tabHeld = false;
      this.keys.delete(e.code);
    });
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.fireHeld = true;
      if (e.button === 2) this.bombHeld = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
      if (e.button === 2 && this.bombHeld) {
        this.bombHeld = false;
        this.bombRelease = true;
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => this.clear());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clear();
    });
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
  }

  clear(): void {
    this.keys.clear();
    this.fireHeld = false;
    this.bombHeld = false;
    this.bombRelease = false;
    this.specialPress = false;
    this.tabHeld = false;
  }

  /** 移动方向，-100..100 的整数。 */
  move(): { mx: number; mz: number } {
    if (!this.enabled) return { mx: 0, mz: 0 };
    let x = 0;
    let z = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;
    const l = Math.hypot(x, z) || 1;
    return { mx: Math.round((x / l) * 100), mz: Math.round((z / l) * 100) };
  }

  swimHeld(): boolean {
    return this.enabled && (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.keys.has('Space'));
  }

  firing(): boolean {
    return this.enabled && this.fireHeld && !this.bombHeld;
  }

  consumeBomb(): boolean {
    const v = this.bombRelease;
    this.bombRelease = false;
    return this.enabled && v;
  }

  consumeSpecial(): boolean {
    const v = this.specialPress;
    this.specialPress = false;
    return this.enabled && v;
  }
}
