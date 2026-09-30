import type { LagoonEvent } from '../game/events.ts';
import type { LagoonGame } from '../game/game.ts';
import { FURNITURE, OUTPOST, outpostToWorld } from '../game/outpost.ts';
import type { SurfaceKind } from '../game/terrain.ts';
import { type Pos, Synth } from './synth.ts';

// The lagoon's sound. Beds: surf along the shoreline (positional), wind and
// palm rustle following the gusts, rain in layers — a hiss, a patter on
// leaves, and drumming on the tarp when you stand under it — cicadas by day,
// crickets and frogs by night, a camp fire's crackle. Sparse events on top:
// bird calls from the canopy, a distant howler, thunder that arrives after its
// flash. Every gameplay action has its own sound, placed in the world and
// delayed by its distance at 343 m/s.

const SURF_POINTS: readonly Pos[] = [
  { x: -30, y: 0.3, z: -6 },
  { x: -6, y: 0.3, z: -3 },
  { x: 18, y: 0.3, z: -4 },
  { x: 40, y: 0.3, z: -40 },
  { x: -48, y: 0.3, z: -60 },
  { x: 25, y: 0.3, z: -170 }, // the lagoon mouth, where the swell breaks
];

interface Surf {
  gain: GainNode;
  pos: Pos;
  phase: number;
}

export class LagoonAudio {
  private readonly s = new Synth();
  private readonly surf: Surf[] = [];
  private readonly wind;
  private readonly leaves;
  private readonly rainHiss;
  private readonly rainLeaves;
  private readonly tarpDrum;
  private readonly cicadas;
  private readonly crickets;
  private readonly fireBed;
  private readonly cicadaLfo: OscillatorNode;
  private birdTimer = 2;
  private frogTimer = 3;
  private howlTimer = 25;
  private patterAcc = 0;
  private crackleTimer = 0;
  private t = 0;
  private underTarp = 0;
  private readonly listener: Pos = { x: 0, y: 0, z: 0 };

  constructor() {
    const s = this.s;
    for (const [i, p] of SURF_POINTS.entries()) {
      const panner = s.ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = i === SURF_POINTS.length - 1 ? 40 : 6;
      panner.positionX.value = p.x;
      panner.positionY.value = p.y;
      panner.positionZ.value = p.z;
      panner.connect(s.world);
      const bed = s.bed(s.pink, 'lowpass', 700, 0.5, panner);
      this.surf.push({ gain: bed.gain, pos: p, phase: i * 1.7 });
    }
    this.wind = s.bed(s.brown, 'bandpass', 380, 0.6);
    this.leaves = s.bed(s.white, 'highpass', 3200, 0.5);
    this.rainHiss = s.bed(s.pink, 'highpass', 1800, 0.4);
    this.rainLeaves = s.bed(s.white, 'bandpass', 5200, 0.9);
    this.tarpDrum = s.bed(s.brown, 'lowpass', 900, 0.8);
    this.fireBed = s.bed(s.brown, 'lowpass', 300, 0.5);
    // Cicadas: a high noise band chopped at ~40 Hz by a square LFO, swelling in waves.
    this.cicadas = s.bed(s.white, 'bandpass', 4700, 6);
    this.cicadaLfo = s.ctx.createOscillator();
    this.cicadaLfo.type = 'square';
    this.cicadaLfo.frequency.value = 42;
    const lfoDepth = s.ctx.createGain();
    lfoDepth.gain.value = 0.4;
    this.cicadaLfo.connect(lfoDepth).connect(this.cicadas.gain.gain);
    this.cicadaLfo.start();
    this.crickets = s.bed(s.white, 'bandpass', 4300, 12);
  }

  resume(): void {
    this.s.resume();
  }

  setVolume(v: number): void {
    this.s.master.gain.value = v;
  }

  /** Once per display frame. */
  update(game: LagoonGame, eye: Pos, forward: Pos, dt: number): void {
    const s = this.s;
    this.t += dt;
    this.listener.x = eye.x;
    this.listener.y = eye.y;
    this.listener.z = eye.z;
    s.setListener(eye, forward);
    s.muffle(game.player.underwater);
    const now = s.now;
    const env = game.env;
    const w = env.weather;
    const night = env.daylight.night;
    const wind = w.windMs;
    const gust = 0.5 + 0.5 * Math.sin(this.t * 0.37) * Math.sin(this.t * 0.11 + 1);
    // Surf: each stretch of shore breathes with its own wave period; storms are louder.
    for (const sp of this.surf) {
      const swell = 0.55 + 0.45 * Math.max(0, Math.sin(this.t * 0.9 + sp.phase)) ** 2;
      sp.gain.gain.setTargetAtTime(0.18 * swell * (1 + w.rainRate * 0.8 + (wind - 3) * 0.05), now, 0.2);
    }
    this.wind.gain.gain.setTargetAtTime(Math.min(0.5, 0.02 + wind * 0.018 * (0.6 + gust * 0.8)), now, 0.3);
    this.wind.filter.frequency.setTargetAtTime(250 + gust * 300 + wind * 15, now, 0.4);
    this.leaves.gain.gain.setTargetAtTime(Math.min(0.12, wind * 0.006 * (0.4 + gust)), now, 0.3);
    // Rain: hiss everywhere, patter on leaves outside, drumming on canvas when sheltered.
    const tarp = Math.hypot(eye.x - OUTPOST.x, eye.z - OUTPOST.z) < 2.6 ? 1 : 0;
    this.underTarp += (tarp - this.underTarp) * Math.min(1, dt * 4);
    this.rainHiss.gain.gain.setTargetAtTime(w.rainRate * 0.22 * (1 - this.underTarp * 0.4), now, 0.3);
    this.rainLeaves.gain.gain.setTargetAtTime(w.rainRate * 0.07 * (1 - this.underTarp * 0.6), now, 0.3);
    this.tarpDrum.gain.gain.setTargetAtTime(w.rainRate * 0.5 * this.underTarp, now, 0.2);
    if (w.rainRate > 0.05) {
      // Individual drops on top of the hiss; kept sparse, each one is three new audio nodes.
      this.patterAcc += dt * w.rainRate * 18;
      while (this.patterAcc > 1) {
        this.patterAcc -= 1;
        const { out, when } = s.voice(null, 0.05);
        s.noiseBurst(out, when + Math.random() * 0.02, { type: 'bandpass', freq: 2500 + Math.random() * 4000, q: 2, gain: 0.02 + Math.random() * 0.03, attack: 0.001, decay: 0.02 });
        if (this.underTarp > 0.5) s.noiseBurst(out, when, { type: 'lowpass', freq: 500 + Math.random() * 400, gain: 0.08, attack: 0.001, decay: 0.05 });
      }
    }
    // Insects: cicadas in the heat of the day, crickets after dark; rain silences both.
    const quiet = 1 - Math.min(1, w.rainRate * 1.5);
    const cicadaSwell = 0.5 + 0.5 * Math.sin(this.t * 0.21);
    this.cicadas.gain.gain.setTargetAtTime((1 - night) * quiet * 0.018 * cicadaSwell * (env.hour > 9 && env.hour < 17.5 ? 1 : 0.25), now, 0.5);
    const chirp = Math.sin(this.t * 2 * Math.PI * 2.6) > 0.3 ? 1 : 0; // cricket chirp rate ~2.6 Hz at 27 °C
    this.crickets.gain.gain.setTargetAtTime(night * quiet * 0.02 * chirp, now, 0.01);
    // Fire: a low roar near the pit, plus crackles.
    const fireD = s.distanceTo(firePos());
    this.fireBed.gain.gain.setTargetAtTime(Math.min(0.12, 0.6 / Math.max(1, fireD * fireD)) * (1 - w.rainRate * 0.5), now, 0.2);
    this.crackleTimer -= dt;
    if (this.crackleTimer <= 0 && fireD < 25) {
      this.crackleTimer = 0.05 + Math.random() * 0.4;
      const { out, when } = s.voice(firePos(), 0.05, 1);
      s.noiseBurst(out, when, { type: 'highpass', freq: 1500 + Math.random() * 3000, gain: 0.05 + Math.random() * 0.12, attack: 0.001, decay: 0.012 + Math.random() * 0.03 });
    }
    // Wildlife.
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = (night > 0.5 ? 8 : 1.2) + Math.random() * (night > 0.5 ? 20 : 4) + w.rainRate * 6;
      if (w.rainRate < 0.7 && night < 0.6) this.bird(this.randomCanopyPoint());
      else if (night >= 0.6 && w.rainRate < 0.7) this.owl(this.randomCanopyPoint());
    }
    this.frogTimer -= dt;
    if (this.frogTimer <= 0) {
      this.frogTimer = 0.6 + Math.random() * 3;
      if (night > 0.4 || w.rainRate > 0.4) this.frog(this.randomCanopyPoint(0.4));
    }
    this.howlTimer -= dt;
    if (this.howlTimer <= 0) {
      this.howlTimer = 40 + Math.random() * 70;
      if (night < 0.5) this.howler({ x: -120 + Math.random() * 240, y: 30, z: 80 + Math.random() * 60 });
    }
  }

  private randomCanopyPoint(heightK = 1): Pos {
    const a = Math.random() * Math.PI * 2;
    const r = 15 + Math.random() * 45;
    const x = this.listener.x + Math.cos(a) * r;
    const z = this.listener.z + Math.abs(Math.sin(a)) * r + 5; // the jungle lies inland, to the south
    return { x, y: 2 + Math.random() * 14 * heightK, z };
  }

  private bird(p: Pos): void {
    const s = this.s;
    const { out, when } = s.voice(p, 0.25, 6);
    const kind = Math.random();
    if (kind < 0.45) {
      // A tropical whistle: two or three rising-falling notes.
      const base = 1800 + Math.random() * 1600;
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) s.tone(out, when + i * 0.16, { type: 'sine', freq: base * (1 + i * 0.12), to: base * (1.25 + i * 0.1), gain: 0.05, attack: 0.02, decay: 0.12 });
    } else if (kind < 0.75) {
      // Parrot squawk: a harsh, buzzy formant burst.
      for (let i = 0; i < 2; i++) s.tone(out, when + i * 0.22, { type: 'sawtooth', freq: 900 + Math.random() * 300, to: 600, gain: 0.03, attack: 0.01, decay: 0.16 });
      s.noiseBurst(out, when, { type: 'bandpass', freq: 2200, q: 3, gain: 0.03, attack: 0.01, decay: 0.3 });
    } else {
      // Dove-like coo.
      for (let i = 0; i < 3; i++) s.tone(out, when + i * 0.45, { type: 'sine', freq: 520, to: 430, gain: 0.04, attack: 0.05, decay: 0.3 });
    }
  }

  private owl(p: Pos): void {
    const s = this.s;
    const { out, when } = s.voice(p, 0.4, 8);
    s.tone(out, when, { type: 'sine', freq: 380, to: 340, gain: 0.05, attack: 0.08, decay: 0.4 });
    s.tone(out, when + 0.7, { type: 'sine', freq: 360, to: 320, gain: 0.04, attack: 0.08, decay: 0.5 });
  }

  private frog(p: Pos): void {
    const s = this.s;
    const { out, when } = s.voice(p, 0.2, 3);
    const f = 250 + Math.random() * 300;
    for (let i = 0; i < 3; i++) s.tone(out, when + i * 0.07, { type: 'square', freq: f, to: f * 0.8, gain: 0.012, attack: 0.005, decay: 0.05 });
  }

  private howler(p: Pos): void {
    const s = this.s;
    const { out, when } = s.voice(p, 0.6, 40);
    for (let i = 0; i < 4; i++) {
      s.tone(out, when + i * 0.6, { type: 'sawtooth', freq: 140, to: 190, gain: 0.05, attack: 0.15, decay: 0.45, glide: 0.3 });
      s.noiseBurst(out, when + i * 0.6, { type: 'bandpass', freq: 500, q: 4, gain: 0.04, attack: 0.15, decay: 0.4 });
    }
  }

  handle(e: LagoonEvent, game: LagoonGame): void {
    const s = this.s;
    switch (e.type) {
      case 'footstep': {
        const { out, when } = s.voice(null, 0.03);
        this.step(out, when, e.surface, e.running ? 1.3 : 1, e.wadingDepthM);
        break;
      }
      case 'jump':
        this.step(s.voice(null, 0.03).out, s.now, e.surface, 0.8, 0);
        break;
      case 'land': {
        const { out, when } = s.voice(null, 0.05);
        this.step(out, when, e.surface, 1 + Math.min(1.5, e.impactSpeedMs * 0.25), 0);
        break;
      }
      case 'stoneWindup': {
        const { out, when } = s.voice(null, 0);
        s.noiseBurst(out, when, { type: 'bandpass', freq: 900, q: 1, gain: 0.04, attack: 0.1, decay: 0.15, buffer: s.pink });
        break;
      }
      case 'stoneThrown': {
        const { out, when } = s.voice(null, 0.05);
        s.noiseBurst(out, when, { type: 'bandpass', freq: 600, sweepTo: 2200, q: 1.5, gain: 0.07 + e.speedMs * 0.004, attack: 0.04, decay: 0.2 });
        break;
      }
      case 'lamp': {
        // The wick: a lighter's flick and the flame catching, or a breath blowing it out.
        const { out, when } = this.s.voice(null, 0.05);
        if (e.lit) {
          this.s.noiseBurst(out, when, { type: 'bandpass', freq: 3800, q: 2, gain: 0.08, attack: 0.001, decay: 0.03 });
          this.s.noiseBurst(out, when + 0.08, { type: 'lowpass', freq: 700, gain: 0.07, attack: 0.04, decay: 0.3, buffer: this.s.brown });
        } else this.s.noiseBurst(out, when, { type: 'bandpass', freq: 1100, q: 0.7, gain: 0.05, attack: 0.03, decay: 0.25 });
        break;
      }
      case 'swimStroke':
        this.stroke(e.pos, e.underwater, e.fast);
        break;
      case 'swim':
        if (e.what === 'start' || e.what === 'under') this.splash(game.player.pos, 1.2, 1, false);
        else if (e.what === 'surface' && (e.airFraction ?? 1) < 0.6) this.gasp(1 - (e.airFraction ?? 1));
        break;
      case 'splash':
        this.splash(e.pos, e.speedMs, e.massKg, e.skip);
        break;
      case 'bodyHit':
        this.clink(e.pos, e.surface, e.speedMs, e.body);
        break;
      case 'shot':
        this.gunshot();
        break;
      case 'dryFire': {
        const { out, when } = s.voice(null, 0);
        s.noiseBurst(out, when, { type: 'highpass', freq: 3000, gain: 0.15, attack: 0.001, decay: 0.03 });
        break;
      }
      case 'reloadStart': {
        const { out, when } = s.voice(null, 0.05);
        s.noiseBurst(out, when, { type: 'bandpass', freq: 800, gain: 0.05, attack: 0.05, decay: 0.2, buffer: s.pink });
        break;
      }
      case 'reloadStage': {
        const { out, when } = s.voice(null, 0.08);
        const heavy = e.stage === 'magIn' ? 1.4 : 1;
        s.noiseBurst(out, when, { type: 'bandpass', freq: e.stage === 'charge' ? 2500 : 1600, q: 3, gain: 0.18 * heavy, attack: 0.001, decay: 0.05 });
        s.tone(out, when, { type: 'triangle', freq: e.stage === 'charge' ? 900 : 520, gain: 0.07 * heavy, attack: 0.001, decay: 0.08 });
        if (e.stage === 'charge') s.noiseBurst(out, when + 0.12, { type: 'bandpass', freq: 3000, q: 3, gain: 0.2, attack: 0.001, decay: 0.05 });
        break;
      }
      case 'knifeSwing': {
        const { out, when } = s.voice(null, 0.03);
        s.noiseBurst(out, when + 0.06, { type: 'bandpass', freq: 1200, sweepTo: 4000, q: 2, gain: 0.09, attack: 0.05, decay: 0.12 });
        break;
      }
      case 'knifeHit':
        this.impact(e.pos, e.surface, 0.6);
        break;
      case 'bulletImpact':
        this.impact(e.pos, e.surface, 1);
        break;
      case 'bulletLeaves': {
        const { out, when } = s.voice(e.pos, 0.1);
        s.noiseBurst(out, when, { type: 'highpass', freq: 2500, gain: 0.1, attack: 0.005, decay: 0.25 });
        break;
      }
      case 'equip': {
        const { out, when } = s.voice(null, 0.04);
        if (e.slot === 'rifle') {
          s.noiseBurst(out, when, { type: 'bandpass', freq: 700, gain: 0.05, attack: 0.05, decay: 0.2, buffer: s.pink });
          s.noiseBurst(out, when + 0.25, { type: 'bandpass', freq: 2200, q: 3, gain: 0.1, attack: 0.001, decay: 0.05 });
        } else if (e.slot === 'knife') s.noiseBurst(out, when, { type: 'highpass', freq: 3500, sweepTo: 7000, gain: 0.08, attack: 0.02, decay: 0.25 });
        break;
      }
      case 'actionStart': {
        const { out, when } = s.voice(null, 0.05);
        if (e.kind === 'harvest') {
          s.noiseBurst(out, when + 0.2, { type: 'highpass', freq: 2000, gain: 0.1, attack: 0.05, decay: 0.35 });
          s.noiseBurst(out, when + 0.55, { type: 'bandpass', freq: 1500, q: 2, gain: 0.12, attack: 0.001, decay: 0.04 }); // stem snap
        } else if (e.kind === 'openCrate') {
          // Creak: a slow, wobbling saw through a resonant band, then the lid drops back on its hinges.
          const o = s.ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(85, when);
          o.frequency.linearRampToValueAtTime(140, when + 0.5);
          o.frequency.linearRampToValueAtTime(95, when + 0.9);
          const f = s.ctx.createBiquadFilter();
          f.type = 'bandpass';
          f.frequency.value = 1100;
          f.Q.value = 6;
          const g = s.ctx.createGain();
          g.gain.setValueAtTime(0.0001, when);
          g.gain.linearRampToValueAtTime(0.09, when + 0.1);
          g.gain.linearRampToValueAtTime(0.0001, when + 0.95);
          o.connect(f).connect(g).connect(out);
          o.start(when);
          o.stop(when + 1);
          s.noiseBurst(out, when + 1.0, { type: 'lowpass', freq: 400, gain: 0.3, attack: 0.002, decay: 0.12 });
        } else s.noiseBurst(out, when, { type: 'bandpass', freq: 900, gain: 0.05, attack: 0.03, decay: 0.2, buffer: s.pink });
        break;
      }
      case 'itemGained': {
        const { out, when } = s.voice(null, 0);
        s.tone(out, when, { type: 'sine', freq: 880, gain: 0.025, attack: 0.005, decay: 0.12 });
        s.tone(out, when + 0.06, { type: 'sine', freq: 1320, gain: 0.02, attack: 0.005, decay: 0.15 });
        break;
      }
      case 'canHit': {
        const can = game.world.cans.find((c) => c.id === e.id);
        if (can) this.clink(can.pos, 'metal', 6, 'can');
        break;
      }
      case 'lightning':
        this.thunder(e.strength, e.thunderDelaySeconds);
        break;
      default:
        break;
    }
  }

  private step(out: AudioNode, when: number, surface: SurfaceKind, k: number, wading: number): void {
    const s = this.s;
    if (surface === 'water' || wading > 0.05) {
      s.noiseBurst(out, when, { type: 'lowpass', freq: 900 + wading * 600, gain: 0.08 * k, attack: 0.02, decay: 0.25, buffer: s.pink });
      for (let i = 0; i < 3; i++) s.tone(out, when + 0.05 + i * 0.04, { type: 'sine', freq: 500 + Math.random() * 600, to: 900 + Math.random() * 800, gain: 0.012, attack: 0.002, decay: 0.05 });
      return;
    }
    if (surface === 'wood') {
      s.tone(out, when, { type: 'triangle', freq: 150 + Math.random() * 40, to: 110, gain: 0.12 * k, attack: 0.002, decay: 0.09 });
      s.noiseBurst(out, when, { type: 'bandpass', freq: 1200, q: 1.2, gain: 0.05 * k, attack: 0.001, decay: 0.05 });
      return;
    }
    if (surface === 'sand' || surface === 'wetSand') {
      s.noiseBurst(out, when, { type: 'bandpass', freq: surface === 'wetSand' ? 700 : 1600 + Math.random() * 600, q: 0.7, gain: 0.07 * k, attack: 0.015, decay: 0.12 });
      return;
    }
    if (surface === 'rock') {
      s.noiseBurst(out, when, { type: 'bandpass', freq: 2400, q: 1, gain: 0.06 * k, attack: 0.002, decay: 0.06 });
      return;
    }
    // Turf and leaf litter: a dry rustle.
    s.noiseBurst(out, when, { type: 'highpass', freq: 1800, gain: 0.05 * k, attack: 0.01, decay: 0.14 });
    s.noiseBurst(out, when, { type: 'lowpass', freq: 300, gain: 0.06 * k, attack: 0.005, decay: 0.07, buffer: this.s.brown });
  }

  private splash(p: Pos, speed: number, mass: number, skip: boolean): void {
    const s = this.s;
    const { out, when } = s.voice(p, 0.25, 3);
    const k = Math.min(1.5, speed * mass * 0.8 + 0.2);
    if (skip) {
      s.noiseBurst(out, when, { type: 'bandpass', freq: 2500, q: 1.5, gain: 0.18 * k, attack: 0.002, decay: 0.08 });
      return;
    }
    s.noiseBurst(out, when, { type: 'lowpass', freq: 500, gain: 0.35 * k, attack: 0.002, decay: 0.12, buffer: s.brown }); // plunge
    s.noiseBurst(out, when + 0.01, { type: 'bandpass', freq: 3200, q: 0.8, gain: 0.22 * k, attack: 0.005, decay: 0.5 }); // spray
    for (let i = 0; i < 5; i++) {
      // Bubbles ringing as they rise: short upward glides (Minnaert resonance, a few hundred Hz to kHz).
      const f = 500 + Math.random() * 900;
      s.tone(out, when + 0.05 + Math.random() * 0.25, { type: 'sine', freq: f, to: f * 1.6, gain: 0.03 * k, attack: 0.002, decay: 0.06 });
    }
  }

  /** One stroke: a soft slosh at the surface, a muffled push and a few bubbles under it. */
  private stroke(p: Pos, under: boolean, fast: boolean): void {
    const s = this.s;
    const { out, when } = s.voice(p, 0.2, 1.5);
    const k = fast ? 1.3 : 1;
    if (under) {
      s.noiseBurst(out, when, { type: 'lowpass', freq: 300, gain: 0.2 * k, attack: 0.05, decay: 0.35, buffer: s.brown });
      for (let i = 0; i < 3; i++) {
        const f = 300 + Math.random() * 500;
        s.tone(out, when + 0.1 + Math.random() * 0.3, { type: 'sine', freq: f, to: f * 1.5, gain: 0.03, attack: 0.002, decay: 0.07 });
      }
      return;
    }
    s.noiseBurst(out, when, { type: 'bandpass', freq: 900, q: 0.9, gain: 0.12 * k, attack: 0.04, decay: 0.3 });
    s.noiseBurst(out, when + 0.12, { type: 'bandpass', freq: 2400, q: 1.1, gain: 0.06 * k, attack: 0.01, decay: 0.2 });
  }

  /** Breaking the surface after a long dive: a sharp breath in, harder the emptier the lungs. */
  private gasp(need: number): void {
    const s = this.s;
    const { out, when } = s.voice(null, 0.05);
    s.noiseBurst(out, when, { type: 'bandpass', freq: 1400, q: 1.2, gain: 0.08 + 0.12 * need, attack: 0.03, decay: 0.35, sweepTo: 2200 });
  }

  private clink(p: Pos, surface: SurfaceKind, speed: number, body: 'stone' | 'can' | 'coconut' | 'shell'): void {
    const s = this.s;
    const { out, when } = s.voice(p, 0.15, 1.5);
    const k = Math.min(1, speed / 8);
    if (body === 'shell') {
      if (surface === 'sand' || surface === 'wetSand' || surface === 'grass') return;
      for (const f of [3900, 5700, 7900]) s.tone(out, when, { type: 'sine', freq: f * (0.95 + Math.random() * 0.1), gain: 0.03, attack: 0.001, decay: 0.15 });
      return;
    }
    if (body === 'can' || surface === 'metal') {
      for (const f of [1150, 2320, 3710]) s.tone(out, when, { type: 'sine', freq: f * (0.95 + Math.random() * 0.1), gain: 0.07 * (0.5 + k), attack: 0.001, decay: 0.25 });
      return;
    }
    if (surface === 'rock') s.tone(out, when, { type: 'triangle', freq: 2600 + Math.random() * 800, gain: 0.08 * k, attack: 0.001, decay: 0.05 });
    else s.noiseBurst(out, when, { type: 'lowpass', freq: 600, gain: 0.12 * k, attack: 0.002, decay: 0.07 });
  }

  /** Layered: supersonic crack, muzzle blast, body thump, action, then the lagoon answering. */
  private gunshot(): void {
    const s = this.s;
    const { out, when } = s.voice(null, 0.9);
    s.noiseBurst(out, when, { type: 'highpass', freq: 2500, gain: 0.9, attack: 0.0005, decay: 0.02 }); // crack
    s.noiseBurst(out, when, { type: 'lowpass', freq: 1200, sweepTo: 200, gain: 1.0, attack: 0.001, decay: 0.18, buffer: s.brown }); // blast
    s.tone(out, when, { type: 'sine', freq: 95, to: 38, gain: 0.8, attack: 0.001, decay: 0.2 }); // body thump
    s.noiseBurst(out, when + 0.02, { type: 'bandpass', freq: 2800, q: 4, gain: 0.08, attack: 0.001, decay: 0.03 }); // action
    // Slapback off the cliffs across the lagoon, darker with each return.
    for (const [delay, g] of [
      [0.32, 0.22],
      [0.61, 0.14],
      [1.05, 0.08],
    ] as const) {
      s.noiseBurst(out, when + delay, { type: 'lowpass', freq: 700, gain: g, attack: 0.01, decay: 0.35, buffer: s.brown });
    }
  }

  private impact(p: Pos, surface: SurfaceKind, k: number): void {
    const s = this.s;
    const { out, when } = s.voice(p, 0.15, 2);
    switch (surface) {
      case 'water':
        s.noiseBurst(out, when, { type: 'bandpass', freq: 1800, gain: 0.2 * k, attack: 0.001, decay: 0.15 });
        break;
      case 'wood':
        s.tone(out, when, { type: 'triangle', freq: 320, to: 180, gain: 0.25 * k, attack: 0.001, decay: 0.08 });
        s.noiseBurst(out, when, { type: 'bandpass', freq: 1500, gain: 0.15 * k, attack: 0.001, decay: 0.08 });
        break;
      case 'rock':
        s.noiseBurst(out, when, { type: 'highpass', freq: 2500, gain: 0.25 * k, attack: 0.001, decay: 0.06 });
        if (k > 0.8 && Math.random() < 0.35) s.tone(out, when + 0.01, { type: 'sine', freq: 3200, to: 900, gain: 0.05, attack: 0.005, decay: 0.45, glide: 0.45 }); // ricochet whine
        break;
      case 'metal':
        for (const f of [1400, 2900]) s.tone(out, when, { type: 'sine', freq: f, gain: 0.12 * k, attack: 0.001, decay: 0.3 });
        break;
      case 'leaves':
      case 'fabric':
        s.noiseBurst(out, when, { type: 'highpass', freq: 2000, gain: 0.1 * k, attack: 0.003, decay: 0.12 });
        break;
      default:
        s.noiseBurst(out, when, { type: 'lowpass', freq: 700, gain: 0.3 * k, attack: 0.001, decay: 0.09, buffer: s.brown });
    }
  }

  private thunder(strength: number, delaySeconds: number): void {
    const s = this.s;
    const when = s.now + delaySeconds;
    const out = s.ctx.createGain();
    out.connect(s.world);
    const near = strength > 0.7;
    if (near) s.noiseBurst(out, when, { type: 'highpass', freq: 1500, gain: 0.5 * strength, attack: 0.005, decay: 0.3 }); // the crack of a close strike
    s.noiseBurst(out, when + 0.05, { type: 'lowpass', freq: 180 + strength * 150, gain: 0.8 * strength, attack: 0.25, decay: 3.5, buffer: s.brown, rate: 0.6 });
    s.noiseBurst(out, when + 0.6, { type: 'lowpass', freq: 120, gain: 0.4 * strength, attack: 0.4, decay: 2.5, buffer: s.brown, rate: 0.5 });
  }
}

const FIRE_POS: Pos = outpostToWorld(FURNITURE.firePit.x, 0, FURNITURE.firePit.z, { x: 0, y: 0, z: 0 });

function firePos(): Pos {
  return FIRE_POS;
}
