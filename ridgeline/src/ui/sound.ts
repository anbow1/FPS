// The helicopter's sound, synthesised with Web Audio (no samples, like the rest
// of the game): each voice is shaped noise or an oscillator driven by the
// simulation.
//
//   rotor    the blade pulse: low noise gated at the blade-passage frequency
//            (blades × rotor speed, ~19 Hz for four blades) — the "wop-wop".
//            It hardens into slap when the blades meet their own vortices: in
//            a descent at low speed, in the vortex ring, under high thrust;
//   tail     the tail rotor's buzz at its own blade passage (~90 Hz);
//   turbine  the engines' whine, rising with the power they deliver, spooling
//            down when cut;
//   air      wind noise growing with airspeed;
//   horn     the low-rotor horn: a steady tone below 92 % rotor speed.
// In the cockpit everything passes a low-pass "helmet and airframe" filter.

const NOISE_S = 2;

export interface SoundFrame {
  /** Rotor speed (rad/s), blades, and the fraction of 100 %. */
  omegaRadS: number;
  blades: number;
  rpmFraction: number;
  /** Thrust over weight, and the slap drivers 0…1: descent at low speed, vortex ring, blade stall. */
  load: number;
  slap: number;
  /** Engines' power fraction 0…1 and whether they run. */
  power: number;
  enginesRunning: boolean;
  airspeedMs: number;
  cockpit: boolean;
  lowRotor: boolean;
}

export class RotorSound {
  private readonly noise: AudioBuffer;
  private readonly master: GainNode;
  private readonly helmet: BiquadFilterNode;
  private readonly pulse: OscillatorNode;
  private readonly pulseDepth: GainNode;
  private readonly thump: GainNode;
  private readonly thumpFilter: BiquadFilterNode;
  private readonly slapGain: GainNode;
  private readonly tail: OscillatorNode;
  private readonly tailGain: GainNode;
  private readonly whine: OscillatorNode;
  private readonly whine2: OscillatorNode;
  private readonly whineGain: GainNode;
  private readonly wind: GainNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly horn: GainNode;
  muted = false;

  constructor(private readonly ctx: AudioContext) {
    this.noise = ctx.createBuffer(1, ctx.sampleRate * NOISE_S, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.helmet = ctx.createBiquadFilter();
    this.helmet.type = 'lowpass';
    this.helmet.frequency.value = 16000;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    this.helmet.connect(this.master).connect(comp).connect(ctx.destination);

    // Blade pulse: a pulse-shaped LFO (a square wave, rounded) opens a gain on low-passed noise.
    this.pulse = ctx.createOscillator();
    this.pulse.type = 'square';
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * 2 - 1;
      // Narrow the "on" half into a short pulse: only the top of the wave passes.
      curve[i] = Math.max(0, x) ** 3;
    }
    shaper.curve = curve;
    const smooth = ctx.createBiquadFilter();
    smooth.type = 'lowpass';
    smooth.frequency.value = 120;
    this.pulseDepth = ctx.createGain();
    this.pulseDepth.gain.value = 0;
    this.pulse.connect(smooth).connect(shaper).connect(this.pulseDepth);
    this.pulse.start();
    [this.thump, this.thumpFilter] = this.noiseVoice('lowpass', 180, 0.9);
    this.thump.gain.value = 0;
    this.pulseDepth.connect(this.thump.gain);
    // Slap: the same pulse on a brighter band of noise.
    const [slap, slapFilter] = this.noiseVoice('bandpass', 900, 1.1);
    slapFilter.Q.value = 0.8;
    this.slapGain = ctx.createGain();
    this.slapGain.gain.value = 0;
    slap.gain.value = 0;
    this.pulseDepth.connect(this.slapGain).connect(slap.gain);

    this.tail = ctx.createOscillator();
    this.tail.type = 'sawtooth';
    this.tailGain = ctx.createGain();
    this.tailGain.gain.value = 0;
    const tailTone = ctx.createBiquadFilter();
    tailTone.type = 'lowpass';
    tailTone.frequency.value = 700;
    this.tail.connect(tailTone).connect(this.tailGain).connect(this.helmet);
    this.tail.start();

    this.whine = ctx.createOscillator();
    this.whine.type = 'triangle';
    this.whine2 = ctx.createOscillator();
    this.whine2.type = 'sine';
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(this.whineGain);
    this.whine2.connect(this.whineGain);
    this.whineGain.connect(this.helmet);
    this.whine.start();
    this.whine2.start();

    [this.wind, this.windFilter] = this.noiseVoice('bandpass', 500, 0.6);

    const hornOsc = ctx.createOscillator();
    hornOsc.type = 'square';
    hornOsc.frequency.value = 610;
    this.horn = ctx.createGain();
    this.horn.gain.value = 0;
    const hornTone = ctx.createBiquadFilter();
    hornTone.type = 'lowpass';
    hornTone.frequency.value = 2000;
    hornOsc.connect(hornTone).connect(this.horn).connect(ctx.destination);
    hornOsc.start();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void ctx.suspend();
      else void ctx.resume();
    });
  }

  private noiseVoice(type: BiquadFilterType, hz: number, q: number): [GainNode, BiquadFilterNode] {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(0, Math.random() * NOISE_S);
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    s.connect(f).connect(g).connect(this.helmet);
    return [g, f];
  }

  update(f: SoundFrame): void {
    const t = this.ctx.currentTime;
    const set = (p: AudioParam, v: number, tc = 0.05): void => void p.setTargetAtTime(v, t, tc);
    set(this.master.gain, this.muted ? 0 : 0.8, 0.1);
    set(this.helmet.frequency, f.cockpit ? 1400 : 16000, 0.15);
    const bladeHz = (f.blades * f.omegaRadS) / (Math.PI * 2);
    set(this.pulse.frequency, Math.max(0.5, bladeHz), 0.02);
    const turning = Math.min(1, f.rpmFraction * 1.2);
    // Rotor loudness with speed and load; the pulse depth is the whole "wop-wop".
    set(this.pulseDepth.gain, 0.55 * turning * (0.6 + 0.4 * Math.min(1.5, f.load)));
    set(this.thumpFilter.frequency, 120 + 140 * f.rpmFraction);
    set(this.slapGain.gain, Math.min(1, 0.12 + f.slap * 0.9));
    set(this.tail.frequency, Math.max(1, bladeHz * 4.7), 0.02);
    set(this.tailGain.gain, 0.05 * turning);
    // Turbine: the gas generator speeds up with power; it winds down when cut.
    const n1 = f.enginesRunning ? 0.75 + 0.25 * f.power : 0;
    set(this.whine.frequency, 2600 + 2400 * n1, f.enginesRunning ? 0.3 : 1.5);
    set(this.whine2.frequency, 1300 + 1200 * n1, f.enginesRunning ? 0.3 : 1.5);
    set(this.whineGain.gain, f.enginesRunning ? 0.02 + 0.02 * f.power : 0, f.enginesRunning ? 0.3 : 2);
    set(this.wind.gain, Math.min(0.25, f.airspeedMs / 300));
    set(this.windFilter.frequency, 300 + f.airspeedMs * 8);
    const beep = f.lowRotor && Math.floor(t * 2) % 2 === 0 ? 0.05 : 0;
    set(this.horn.gain, this.muted ? 0 : beep, 0.01);
  }
}
