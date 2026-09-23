import * as THREE from 'three';

/**
 * Procedural WebAudio: no sample files. Distant shots arrive late (343 m/s) and duller
 * (air absorption low-pass), so range can be judged by ear as well as by the rangefinder.
 */
const SPEED_OF_SOUND = 343;

export interface EngineVoice {
  osc1: OscillatorNode;
  osc2: OscillatorNode;
  noise: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode | null;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private reverb!: ConvolverNode;
  private noiseBuf!: AudioBuffer;
  private listenerPos = new THREE.Vector3();
  private turretVoice: { osc: OscillatorNode; gain: GainNode } | null = null;
  private wind: GainNode | null = null;
  volume = 0.8;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // outdoor reverb: long, sparse, low-passed tail (terrain echoes)
    this.reverb = ctx.createConvolver();
    const len = ctx.sampleRate * 3.5;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = ir.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        const echo = Math.random() < 0.002 ? 3 : 1;
        ch[i] = (Math.random() * 2 - 1) * Math.exp(-t * 1.6) * 0.35 * echo;
      }
    }
    this.reverb.buffer = ir;
    const revLp = ctx.createBiquadFilter();
    revLp.type = 'lowpass';
    revLp.frequency.value = 1800;
    const revGain = ctx.createGain();
    revGain.gain.value = 0.55;
    this.reverb.connect(revLp).connect(revGain).connect(this.master);
    this.startWind();
    this.startTurret();
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setListener(pos: THREE.Vector3, fwd: THREE.Vector3, up: THREE.Vector3): void {
    this.listenerPos.copy(pos);
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    const t = ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos.x, t, 0.02);
      l.positionY.setTargetAtTime(pos.y, t, 0.02);
      l.positionZ.setTargetAtTime(pos.z, t, 0.02);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      l.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      l.upX.setTargetAtTime(up.x, t, 0.02);
      l.upY.setTargetAtTime(up.y, t, 0.02);
      l.upZ.setTargetAtTime(up.z, t, 0.02);
    }
  }

  private panner(pos: THREE.Vector3): PannerNode {
    const ctx = this.ctx!;
    const p = ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 12;
    p.rolloffFactor = 1;
    p.maxDistance = 5000;
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
    return p;
  }

  private noiseSrc(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.loopStart = Math.random();
    return s;
  }

  /** Delay and air-absorption for a one-shot at `pos`. */
  private route(pos: THREE.Vector3, local: boolean): { input: AudioNode; start: number; dist: number } {
    const ctx = this.ctx!;
    const dist = local ? 0 : pos.distanceTo(this.listenerPos);
    const start = ctx.currentTime + dist / SPEED_OF_SOUND;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(350, 16000 / (1 + dist / 150));
    const out = local ? lp : lp.connect(this.panner(pos));
    out.connect(this.sfx);
    const send = ctx.createGain();
    send.gain.value = Math.min(1, 0.25 + dist / 1200);
    out.connect(send).connect(this.reverb);
    return { input: lp, start, dist };
  }

  cannon(pos: THREE.Vector3, local: boolean): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const { input, start } = this.route(pos, local);
    // crack
    const n = this.noiseSrc();
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(local ? 1.4 : 2.2, start);
    ng.gain.exponentialRampToValueAtTime(0.001, start + 0.6);
    n.connect(ng).connect(input);
    n.start(start);
    n.stop(start + 0.7);
    // body
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, start);
    o.frequency.exponentialRampToValueAtTime(28, start + 0.5);
    const og = ctx.createGain();
    og.gain.setValueAtTime(local ? 1.6 : 2.4, start);
    og.gain.exponentialRampToValueAtTime(0.001, start + 0.9);
    o.connect(og).connect(input);
    o.start(start);
    o.stop(start + 1);
  }

  explosion(pos: THREE.Vector3, size: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const { input, start } = this.route(pos, false);
    const n = this.noiseSrc();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, start);
    lp.frequency.exponentialRampToValueAtTime(200, start + 1.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1.5 * size, start);
    g.gain.exponentialRampToValueAtTime(0.001, start + 1.6 + size * 0.4);
    n.connect(lp).connect(g).connect(input);
    n.start(start);
    n.stop(start + 2.5);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(60, start);
    o.frequency.exponentialRampToValueAtTime(22, start + 0.8);
    const og = ctx.createGain();
    og.gain.setValueAtTime(1.8 * size, start);
    og.gain.exponentialRampToValueAtTime(0.001, start + 1.2);
    o.connect(og).connect(input);
    o.start(start);
    o.stop(start + 1.3);
  }

  /** Metallic hit: inharmonic partials. `ricochet` adds the whine. */
  clang(pos: THREE.Vector3, loud: number, ricochet: boolean, local: boolean): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const { input, start } = this.route(pos, local);
    for (const f of [180, 413, 697, 1130, 1780]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f * (0.95 + Math.random() * 0.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.25 * loud, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.4 + 400 / f);
      o.connect(g).connect(input);
      o.start(start);
      o.stop(start + 1.5);
    }
    if (ricochet) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(3200, start);
      o.frequency.exponentialRampToValueAtTime(700, start + 0.45);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.18 * loud, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.5);
      o.connect(g).connect(input);
      o.start(start);
      o.stop(start + 0.55);
    }
  }

  /** Shell passing close by: a supersonic crack. */
  crack(pos: THREE.Vector3): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const n = this.noiseSrc();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1500;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    n.connect(hp).connect(g).connect(this.panner(pos)).connect(this.sfx);
    n.start(t);
    n.stop(t + 0.15);
  }

  reloadClunk(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const [dt, f] of [[0, 140], [0.12, 90]] as const) {
      const n = this.noiseSrc();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f * 8;
      bp.Q.value = 2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, t + dt);
      g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.12);
      n.connect(bp).connect(g).connect(this.sfx);
      n.start(t + dt);
      n.stop(t + dt + 0.15);
    }
  }

  uiBeep(freq: number, dur = 0.06): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  createEngine(local: boolean, pos: THREE.Vector3): EngineVoice | null {
    if (!this.ctx) return null;
    const ctx = this.ctx;
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    const noise = this.noiseSrc();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    filter.Q.value = 3;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const g1 = ctx.createGain();
    g1.gain.value = 0.35;
    const g2 = ctx.createGain();
    g2.gain.value = 0.2;
    const gn = ctx.createGain();
    gn.gain.value = 0.25;
    osc1.connect(g1).connect(filter);
    osc2.connect(g2).connect(filter);
    noise.connect(gn).connect(filter);
    filter.connect(gain);
    let panner: PannerNode | null = null;
    if (local) gain.connect(this.sfx);
    else {
      panner = this.panner(pos);
      panner.refDistance = 20;
      gain.connect(panner).connect(this.sfx);
    }
    osc1.start();
    osc2.start();
    noise.start();
    return { osc1, osc2, noise, filter, gain, panner };
  }

  /** rpm 0..1, load 0..1 */
  updateEngine(v: EngineVoice, rpm: number, load: number, pos: THREE.Vector3, level: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const f = 28 + rpm * 55;
    v.osc1.frequency.setTargetAtTime(f, t, 0.08);
    v.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.08);
    v.filter.frequency.setTargetAtTime(220 + rpm * 700 + load * 500, t, 0.1);
    v.gain.gain.setTargetAtTime(level * (0.12 + rpm * 0.18 + load * 0.12), t, 0.1);
    if (v.panner) {
      v.panner.positionX.setTargetAtTime(pos.x, t, 0.05);
      v.panner.positionY.setTargetAtTime(pos.y, t, 0.05);
      v.panner.positionZ.setTargetAtTime(pos.z, t, 0.05);
    }
  }

  stopEngine(v: EngineVoice | null): void {
    if (!v || !this.ctx) return;
    const t = this.ctx.currentTime;
    v.gain.gain.setTargetAtTime(0, t, 0.3);
    v.osc1.stop(t + 1.5);
    v.osc2.stop(t + 1.5);
    v.noise.stop(t + 1.5);
  }

  private startTurret(): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 180;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 4;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(bp).connect(gain).connect(this.sfx);
    osc.start();
    this.turretVoice = { osc, gain };
  }

  /** Hydraulic traverse whine, 0..1 */
  setTurretSpeed(s: number): void {
    if (!this.turretVoice || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.turretVoice.gain.gain.setTargetAtTime(Math.min(1, s) * 0.05, t, 0.05);
    this.turretVoice.osc.frequency.setTargetAtTime(140 + s * 120, t, 0.05);
  }

  private startWind(): void {
    const ctx = this.ctx!;
    const n = this.noiseSrc();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    n.connect(lp).connect(g).connect(this.master);
    n.start();
    this.wind = g;
  }

  setWind(level: number): void {
    if (this.wind && this.ctx) this.wind.gain.setTargetAtTime(0.02 + level * 0.06, this.ctx.currentTime, 0.5);
  }
}
