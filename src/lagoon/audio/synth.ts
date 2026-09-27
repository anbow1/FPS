import { PHYSICS } from '../../config.ts';

// Web Audio building blocks for the lagoon: noise beds, one-shot envelopes and
// positional voices with a real speed of sound (rules §8). Every sound is
// synthesised, so the game ships without samples.

export interface Pos {
  x: number;
  y: number;
  z: number;
}

export class Synth {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  /** Everything but the UI goes through here, and a share into the reverb. */
  readonly world: GainNode;
  readonly reverbSend: GainNode;
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;
  private listener: Pos = { x: 0, y: 0, z: 0 };

  constructor() {
    this.ctx = new AudioContext();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 3;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(comp).connect(this.ctx.destination);
    this.world = this.ctx.createGain();
    this.world.connect(this.master);
    // Open-air reverb: a short, bright early field and a long, dark tail off the cliffs.
    const reverb = this.ctx.createConvolver();
    reverb.buffer = this.impulse(2.8);
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0.35;
    this.reverbSend.connect(reverb).connect(this.master);
    this.white = this.noise('white', 2);
    this.pink = this.noise('pink', 3);
    this.brown = this.noise('brown', 3);
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  resume(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  setListener(pos: Pos, forward: Pos): void {
    this.listener = pos;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos.x, t, 0.01);
      l.positionY.setTargetAtTime(pos.y, t, 0.01);
      l.positionZ.setTargetAtTime(pos.z, t, 0.01);
      l.forwardX.setTargetAtTime(forward.x, t, 0.01);
      l.forwardY.setTargetAtTime(forward.y, t, 0.01);
      l.forwardZ.setTargetAtTime(forward.z, t, 0.01);
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    }
  }

  distanceTo(p: Pos): number {
    return Math.hypot(p.x - this.listener.x, p.y - this.listener.y, p.z - this.listener.z);
  }

  /**
   * An output for one sound: a panner at `pos` (or straight to the mix when
   * null), starting after the sound's flight time at 343 m/s. `wet` sends a
   * share into the reverb.
   */
  voice(pos: Pos | null, wet = 0.2, refM = 2): { out: AudioNode; when: number } {
    const delay = pos ? this.distanceTo(pos) / PHYSICS.speedOfSoundMs : 0;
    const when = this.ctx.currentTime + delay + 0.005;
    const g = this.ctx.createGain();
    if (pos) {
      const p = this.ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = refM;
      p.rolloffFactor = 1;
      p.maxDistance = 3000;
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
      g.connect(p).connect(this.world);
      if (wet > 0) {
        const send = this.ctx.createGain();
        send.gain.value = wet;
        p.connect(send).connect(this.reverbSend);
      }
    } else {
      g.connect(this.world);
      if (wet > 0) {
        const send = this.ctx.createGain();
        send.gain.value = wet;
        g.connect(send).connect(this.reverbSend);
      }
    }
    return { out: g, when };
  }

  /** A burst of filtered noise with an attack–decay envelope. */
  noiseBurst(out: AudioNode, when: number, opts: { type: BiquadFilterType; freq: number; q?: number; gain: number; attack: number; decay: number; buffer?: AudioBuffer; sweepTo?: number; rate?: number }): void {
    const src = this.ctx.createBufferSource();
    src.buffer = opts.buffer ?? this.white;
    src.playbackRate.value = opts.rate ?? 1;
    const f = this.ctx.createBiquadFilter();
    f.type = opts.type;
    f.frequency.setValueAtTime(opts.freq, when);
    if (opts.sweepTo) f.frequency.exponentialRampToValueAtTime(opts.sweepTo, when + opts.attack + opts.decay);
    f.Q.value = opts.q ?? 0.8;
    const g = this.ctx.createGain();
    envelope(g.gain, when, opts.gain, opts.attack, opts.decay);
    src.connect(f).connect(g).connect(out);
    const offset = Math.random() * ((src.buffer?.duration ?? 1) - opts.attack - opts.decay - 0.05);
    src.start(when, Math.max(0, offset));
    src.stop(when + opts.attack + opts.decay + 0.05);
  }

  /** A pitched tone with an envelope and an optional glide. */
  tone(out: AudioNode, when: number, opts: { type: OscillatorType; freq: number; to?: number; gain: number; attack: number; decay: number; glide?: number }): void {
    const o = this.ctx.createOscillator();
    o.type = opts.type;
    o.frequency.setValueAtTime(opts.freq, when);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, when + (opts.glide ?? opts.attack + opts.decay));
    const g = this.ctx.createGain();
    envelope(g.gain, when, opts.gain, opts.attack, opts.decay);
    o.connect(g).connect(out);
    o.start(when);
    o.stop(when + opts.attack + opts.decay + 0.05);
  }

  /** A looping noise bed through a filter, with a controllable gain. */
  bed(buffer: AudioBuffer, type: BiquadFilterType, freq: number, q: number, dest: AudioNode = this.world): { gain: GainNode; filter: BiquadFilterNode } {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(dest);
    src.start(0, Math.random() * buffer.duration);
    return { gain, filter };
  }

  private noise(kind: 'white' | 'pink' | 'brown', seconds: number): AudioBuffer {
    const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * seconds), this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let brown = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w * 0.5;
      else if (kind === 'pink') {
        // Paul Kellet's economy pink filter.
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12;
      } else {
        brown = (brown + 0.02 * w) / 1.02;
        d[i] = brown * 3;
      }
    }
    return buf;
  }

  private impulse(seconds: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        // Discrete early reflections from the cliffs, then a darkening diffuse tail.
        const early = [0.09, 0.21, 0.34, 0.52].some((e) => Math.abs(t - e - ch * 0.013) < 0.002) ? 0.5 : 0;
        const w = Math.random() * 2 - 1;
        lp += (w - lp) * Math.max(0.03, 0.5 * Math.exp(-t * 1.2));
        d[i] = (lp * Math.exp(-t * 2.2) + early * w) * 0.5;
      }
    }
    return buf;
  }
}

export function envelope(p: AudioParam, when: number, peak: number, attack: number, decay: number): void {
  p.setValueAtTime(0.0001, when);
  p.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + Math.max(0.001, attack));
  p.exponentialRampToValueAtTime(0.0001, when + attack + decay);
}
