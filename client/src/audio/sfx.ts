type SfxName =
  | 'shot' | 'shotOther' | 'hit' | 'hurt' | 'throw' | 'land' | 'boom' | 'splat' | 'respawn' | 'special'
  | 'beep' | 'go' | 'whistle' | 'click' | 'tick' | 'win' | 'lose' | 'join' | 'ready' | 'lastMinute';

/** 全部音效用 Web Audio 实时合成，无需音频文件；背景音乐可选加载。 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private noise!: AudioBuffer;
  private musicBuffers = new Map<string, AudioBuffer>();
  private musicSrc: AudioBufferSourceNode | null = null;
  private musicGain: GainNode | null = null;
  private playingTrack = '';
  private wantedTrack = '';
  private wantedRate = 1;
  private lastPlay = new Map<string, number>();
  muted = localStorage.getItem('sa.muted') === '1';

  constructor() {
    const unlock = () => {
      this.ensure();
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new AudioContext();
    } catch {
      return null;
    }
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(c.destination);
    this.sfxBus = c.createGain();
    this.sfxBus.gain.value = 0.9;
    this.sfxBus.connect(this.master);
    this.musicBus = c.createGain();
    this.musicBus.gain.value = 0.32;
    this.musicBus.connect(this.master);
    const len = c.sampleRate;
    this.noise = c.createBuffer(1, len, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    void this.loadMusic();
    return c;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    localStorage.setItem('sa.muted', this.muted ? '1' : '0');
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  // ---------------- 背景音乐 ----------------
  private async loadMusic(): Promise<void> {
    for (const name of ['lobby', 'battle']) {
      try {
        const res = await fetch(`/audio/bgm-${name}.mp3`);
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        this.musicBuffers.set(name, await this.ctx!.decodeAudioData(buf));
        this.applyMusic();
      } catch { /* 没有音乐文件时静默 */ }
    }
  }

  /** 切换背景音乐（'' 表示停止），带淡入淡出。 */
  music(name: string, rate = 1): void {
    this.wantedTrack = name;
    this.wantedRate = rate;
    this.applyMusic();
  }

  private applyMusic(): void {
    const c = this.ctx;
    if (!c) return;
    const name = this.wantedTrack;
    const buf = this.musicBuffers.get(name);
    const target = buf ? name : '';
    if (target === this.playingTrack) {
      if (this.musicSrc) this.musicSrc.playbackRate.setTargetAtTime(this.wantedRate, c.currentTime, 0.3);
      return;
    }
    if (this.musicSrc && this.musicGain) {
      const g = this.musicGain;
      const s = this.musicSrc;
      g.gain.setTargetAtTime(0, c.currentTime, 0.25);
      setTimeout(() => {
        try { s.stop(); } catch { /* ignore */ }
      }, 1200);
    }
    this.musicSrc = null;
    this.musicGain = null;
    this.playingTrack = target;
    if (!buf) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = this.wantedRate;
    const g = c.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(1, c.currentTime, 0.4);
    src.connect(g).connect(this.musicBus);
    src.start();
    this.musicSrc = src;
    this.musicGain = g;
  }

  // ---------------- 音效 ----------------
  private env(g: GainNode, t: number, a: number, peak: number, d: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  private osc(type: OscillatorType, f0: number, f1: number, t: number, dur: number, vol: number, out: AudioNode): void {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    this.env(g, t, 0.005, vol, dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noiseBurst(t: number, dur: number, vol: number, type: BiquadFilterType, f0: number, f1: number, q: number, out: AudioNode): void {
    const c = this.ctx!;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = c.createGain();
    this.env(g, t, 0.004, vol, dur);
    s.connect(f).connect(g).connect(out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }

  /** pan：-1（左）~ 1（右）；vol：音量倍率。 */
  play(name: SfxName, opts: { pan?: number; vol?: number } = {}): void {
    const c = this.ensure();
    if (!c || c.state !== 'running' || this.muted) return;
    // 同一音效的最小间隔，防止叠音爆音
    const now = performance.now();
    const minGap = name === 'shotOther' ? 30 : name === 'land' ? 40 : 10;
    if (now - (this.lastPlay.get(name) ?? 0) < minGap) return;
    this.lastPlay.set(name, now);

    const t = c.currentTime + 0.005;
    const v = opts.vol ?? 1;
    const p = c.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, opts.pan ?? 0));
    p.connect(this.sfxBus);
    const r = () => 0.92 + Math.random() * 0.16;

    switch (name) {
      case 'shot':
        this.noiseBurst(t, 0.07, 0.22 * v, 'bandpass', 2600 * r(), 900, 1.4, p);
        this.osc('sine', 760 * r(), 260, t, 0.06, 0.12 * v, p);
        break;
      case 'shotOther':
        this.noiseBurst(t, 0.06, 0.09 * v, 'bandpass', 2200 * r(), 800, 1.4, p);
        break;
      case 'land':
        this.noiseBurst(t, 0.08, 0.05 * v, 'lowpass', 1400, 300, 0.7, p);
        break;
      case 'hit':
        this.osc('triangle', 1300, 1900, t, 0.05, 0.22 * v, p);
        this.osc('square', 2600, 2600, t + 0.02, 0.03, 0.05 * v, p);
        break;
      case 'hurt':
        this.osc('square', 260, 110, t, 0.12, 0.13 * v, p);
        this.noiseBurst(t, 0.1, 0.12 * v, 'lowpass', 1200, 300, 0.8, p);
        break;
      case 'throw':
        this.noiseBurst(t, 0.22, 0.14 * v, 'bandpass', 500, 2200, 2, p);
        break;
      case 'boom':
        this.noiseBurst(t, 0.55, 0.55 * v, 'lowpass', 2400, 160, 0.9, p);
        this.osc('sine', 150, 38, t, 0.45, 0.55 * v, p);
        this.osc('triangle', 90, 45, t + 0.02, 0.3, 0.2 * v, p);
        break;
      case 'splat':
        this.noiseBurst(t, 0.35, 0.35 * v, 'lowpass', 1800, 200, 1, p);
        for (let i = 0; i < 5; i++) this.osc('sine', 400 + Math.random() * 500, 1200 + Math.random() * 600, t + i * 0.04, 0.07, 0.12 * v, p);
        this.osc('sine', 220, 60, t, 0.3, 0.3 * v, p);
        break;
      case 'respawn':
        [523, 659, 784].forEach((f, i) => this.osc('triangle', f, f, t + i * 0.07, 0.12, 0.16 * v, p));
        break;
      case 'special':
        this.osc('sawtooth', 180, 1400, t, 0.45, 0.12 * v, p);
        this.noiseBurst(t + 0.1, 0.45, 0.25 * v, 'bandpass', 600, 4000, 1.2, p);
        this.osc('sine', 120, 50, t + 0.3, 0.4, 0.35 * v, p);
        break;
      case 'beep':
        this.osc('square', 660, 660, t, 0.14, 0.12 * v, p);
        break;
      case 'go':
        this.osc('square', 990, 990, t, 0.32, 0.13 * v, p);
        this.osc('square', 1320, 1320, t, 0.32, 0.07 * v, p);
        break;
      case 'whistle': {
        const o = c.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(2100, t);
        const lfo = c.createOscillator();
        lfo.frequency.value = 28;
        const lg = c.createGain();
        lg.gain.value = 90;
        lfo.connect(lg).connect(o.frequency);
        const g = c.createGain();
        this.env(g, t, 0.01, 0.2 * v, 0.7);
        o.connect(g).connect(p);
        o.start(t);
        lfo.start(t);
        o.stop(t + 0.8);
        lfo.stop(t + 0.8);
        break;
      }
      case 'click':
        this.osc('triangle', 900, 700, t, 0.04, 0.12 * v, p);
        break;
      case 'tick':
        this.osc('square', 1500 + Math.random() * 300, 1500, t, 0.02, 0.05 * v, p);
        break;
      case 'win':
        [523, 659, 784, 1047, 1319].forEach((f, i) => this.osc('triangle', f, f, t + i * 0.09, i === 4 ? 0.6 : 0.16, 0.18 * v, p));
        break;
      case 'lose':
        [523, 466, 392, 330].forEach((f, i) => this.osc('triangle', f, f * 0.98, t + i * 0.13, 0.2, 0.15 * v, p));
        break;
      case 'join':
        this.osc('triangle', 660, 660, t, 0.08, 0.12 * v, p);
        this.osc('triangle', 990, 990, t + 0.08, 0.12, 0.12 * v, p);
        break;
      case 'ready':
        this.osc('triangle', 784, 1175, t, 0.12, 0.14 * v, p);
        break;
      case 'lastMinute':
        [880, 880, 1175].forEach((f, i) => this.osc('square', f, f, t + i * 0.12, 0.09, 0.1 * v, p));
        break;
    }
  }
}
