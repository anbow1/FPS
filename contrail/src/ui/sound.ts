// The sound of flight, synthesised with Web Audio (no samples, like the rest of
// the game): every voice is shaped noise or an oscillator driven by the
// simulation, so it follows the aircraft rather than looping a recording.
//
//   engine    the fan's whine rises with core speed; a broadband rumble under it;
//             the afterburner adds a deep roar with a slow flutter;
//   air       wind noise whose loudness follows dynamic pressure and whose pitch
//             follows airspeed; low buffet at high angle of attack;
//   gun       a buzz at the cannon's rate of fire over a noise crack;
//   others    each other jet as a rumble and a whine, quieter with distance and
//             Doppler-shifted by the closing speed;
//   events    missile launches and explosions as one-shots, explosions delayed
//             by the speed of sound — a far kill flashes first, then thuds.
//
// In the cockpit everything passes a low-pass "canopy and helmet" filter; the
// outside views hear the full band.

const SPEED_OF_SOUND_MS = 340;

type P3 = { readonly x: number; readonly y: number; readonly z: number };
const NOISE_S = 2;

export interface SoundFrame {
  /** Player engine: core 0.05…1 and burner 0…1 (EngineState). */
  core: number;
  burner: number;
  dynamicPressurePa: number;
  speedMs: number;
  alphaRad: number;
  gunFiring: boolean;
  gunRoundsPerS: number;
  cockpit: boolean;
  /** The camera, and the velocity the listener moves with (the player's). */
  listener: P3;
  listenerVelocity: P3;
  others: { position: P3; velocity: P3; core: number; burner: number; alive: boolean }[];
}

interface JetVoice {
  rumble: GainNode;
  rumbleFilter: BiquadFilterNode;
  whine: OscillatorNode;
  whineGain: GainNode;
  roar: GainNode;
}

export class FlightSound {
  private readonly noise: AudioBuffer;
  private readonly master: GainNode;
  private readonly canopy: BiquadFilterNode;
  private readonly own: JetVoice;
  private readonly flutter: OscillatorNode;
  private readonly wind: GainNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly buffet: GainNode;
  private readonly gunBuzz: OscillatorNode;
  private readonly gunGain: GainNode;
  private readonly others: JetVoice[] = [];
  muted = false;

  constructor(private readonly ctx: AudioContext) {
    // One shared buffer of white noise; each voice starts it at its own offset so voices do not correlate.
    this.noise = ctx.createBuffer(1, ctx.sampleRate * NOISE_S, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.canopy = ctx.createBiquadFilter();
    this.canopy.type = 'lowpass';
    this.canopy.frequency.value = 16000;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    // A gentle compressor keeps a near explosion over a full-burner roar from clipping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.canopy.connect(this.master).connect(comp).connect(ctx.destination);

    this.own = this.jetVoice(1);
    // The burner's flutter: a slow, uneven amplitude wobble (two LFOs beating) on the roar.
    this.flutter = ctx.createOscillator();
    this.flutter.frequency.value = 7.3;
    const flutterDepth = ctx.createGain();
    flutterDepth.gain.value = 0.18;
    // Modulates a gain after the roar, so the wobble scales with the burner and is silent with it off.
    const flutterGain = ctx.createGain();
    this.own.roar.disconnect();
    this.own.roar.connect(flutterGain).connect(this.canopy);
    this.flutter.connect(flutterDepth).connect(flutterGain.gain);
    this.flutter.start();

    [this.wind, this.windFilter] = this.noiseVoice('bandpass', 600, 0.6);
    const [buffet] = this.noiseVoice('lowpass', 70, 1.2);
    this.buffet = buffet;

    this.gunBuzz = ctx.createOscillator();
    this.gunBuzz.type = 'sawtooth';
    this.gunGain = ctx.createGain();
    this.gunGain.gain.value = 0;
    const gunTone = ctx.createBiquadFilter();
    gunTone.type = 'lowpass';
    gunTone.frequency.value = 900;
    this.gunBuzz.connect(gunTone).connect(this.gunGain).connect(this.canopy);
    this.gunBuzz.start();

    document.addEventListener('visibilitychange', () => {
      // A phone in the pocket should not keep roaring (and burning battery).
      if (document.hidden) void ctx.suspend();
      else void ctx.resume();
    });
  }

  private noiseSource(): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(0, Math.random() * NOISE_S);
    return s;
  }

  private noiseVoice(type: BiquadFilterType, hz: number, q: number): [GainNode, BiquadFilterNode] {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    this.noiseSource().connect(f).connect(g).connect(this.canopy);
    return [g, f];
  }

  private jetVoice(level: number): JetVoice {
    const [rumble, rumbleFilter] = this.noiseVoice('lowpass', 300, 0.7);
    const whine = this.ctx.createOscillator();
    whine.type = 'triangle';
    const whineGain = this.ctx.createGain();
    whineGain.gain.value = 0;
    whine.connect(whineGain).connect(this.canopy);
    whine.start();
    const [roar, roarFilter] = this.noiseVoice('lowpass', 420, 0.9);
    roarFilter.frequency.value = 420 * level;
    return { rumble, rumbleFilter, whine, whineGain, roar };
  }

  /** Per rendered frame. */
  update(f: SoundFrame): void {
    const t = this.ctx.currentTime;
    const set = (p: AudioParam, v: number, tc = 0.06): void => void p.setTargetAtTime(v, t, tc);
    set(this.master.gain, this.muted ? 0 : 0.8, 0.1);
    set(this.canopy.frequency, f.cockpit ? 1600 : 16000, 0.15);

    // Own engine. Inside, the whine is what the pilot hears most of the engine; outside, the roar from behind.
    const inside = f.cockpit ? 1 : 0;
    this.applyJet(this.own, f.core, f.burner, 1, 1, inside ? 0.6 : 1);

    // Wind: loudness ~ dynamic pressure (sound power of a turbulent boundary layer), pitch ~ airspeed.
    const q = Math.min(1, f.dynamicPressurePa / 60_000);
    set(this.wind.gain, 0.22 * Math.sqrt(q));
    set(this.windFilter.frequency, 250 + f.speedMs * 5);
    const alphaDeg = (f.alphaRad * 180) / Math.PI;
    set(this.buffet.gain, Math.min(0.5, Math.max(0, alphaDeg - 14) * 0.04) * Math.sqrt(q + 0.05));

    set(this.gunBuzz.frequency, f.gunRoundsPerS, 0.01);
    set(this.gunGain.gain, f.gunFiring ? 0.16 : 0, 0.01);

    // Other jets: inverse-distance loudness and the Doppler factor from the line-of-sight speeds.
    while (this.others.length < f.others.length) this.others.push(this.jetVoice(0.8));
    f.others.forEach((o, i) => {
      const v = this.others[i]!;
      const dx = o.position.x - f.listener.x;
      const dy = o.position.y - f.listener.y;
      const dz = o.position.z - f.listener.z;
      const r = Math.max(30, Math.hypot(dx, dy, dz));
      const ux = dx / r;
      const uy = dy / r;
      const uz = dz / r;
      // Positive when closing: the listener moving towards the source, the source towards the listener.
      const vl = f.listenerVelocity.x * ux + f.listenerVelocity.y * uy + f.listenerVelocity.z * uz;
      const vs = -(o.velocity.x * ux + o.velocity.y * uy + o.velocity.z * uz);
      const doppler = Math.min(3, Math.max(0.3, (SPEED_OF_SOUND_MS + vl) / Math.max(40, SPEED_OF_SOUND_MS - vs)));
      const gain = o.alive ? Math.min(1, 150 / r) : 0;
      this.applyJet(v, o.core, o.burner, gain, doppler, 1);
    });
  }

  private applyJet(v: JetVoice, core: number, burner: number, gain: number, pitch: number, roarLevel: number): void {
    const t = this.ctx.currentTime;
    const set = (p: AudioParam, x: number): void => void p.setTargetAtTime(x, t, 0.08);
    set(v.whine.frequency, (900 + core * 2600) * pitch);
    // An idling turbofan is still loud (the whine above all); a dead one (core 0) is silent.
    const running = core > 0.01 ? 1 : 0;
    set(v.whineGain.gain, 0.03 * (0.45 + 0.55 * core) * running * gain);
    set(v.rumbleFilter.frequency, (180 + core * 700) * pitch);
    set(v.rumble.gain, 0.32 * (0.12 + 0.88 * core) * running * gain);
    set(v.roar.gain, 0.9 * burner * gain * roarLevel);
  }

  /** A missile leaving the rail: a short hiss that falls in pitch as the motor pulls away. */
  launch(distanceM: number): void {
    const t = this.ctx.currentTime;
    const src = this.noiseSource();
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 0.8;
    f.frequency.setValueAtTime(2400, t);
    f.frequency.exponentialRampToValueAtTime(500, t + 1.4);
    const g = this.ctx.createGain();
    const level = Math.min(0.6, 60 / Math.max(60, distanceM));
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
    src.connect(f).connect(g).connect(this.canopy);
    src.stop(t + 1.7);
  }

  /** A blast `distanceM` away: low boom, louder for a bigger `size`, heard after the sound's travel time. */
  explosion(distanceM: number, size: number): void {
    if (distanceM > 20_000) return;
    const t = this.ctx.currentTime + distanceM / SPEED_OF_SOUND_MS;
    const src = this.noiseSource();
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    // Air absorbs the highs first: a far blast is a dull thud.
    f.frequency.setValueAtTime(Math.max(120, 2200 / (1 + distanceM / 600)), t);
    f.frequency.exponentialRampToValueAtTime(60, t + 2);
    const g = this.ctx.createGain();
    const level = Math.min(1, (Math.sqrt(size) * 120) / Math.max(80, distanceM));
    // Silent until the sound arrives: a gain's value before its first scheduled event is its default of 1.
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.5);
    src.connect(f).connect(g).connect(this.canopy);
    src.stop(t + 2.6);
  }

  /** Rounds striking our own airframe: sharp metallic knocks. */
  hit(): void {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(320, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.08);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g).connect(this.canopy);
    o.start(t);
    o.stop(t + 0.13);
  }
}
