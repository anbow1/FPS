import { PHYSICS, type SurfaceKind } from '../config.ts';
import type { Vec3 } from '../core/vec.ts';
import type { GameEvent } from '../game/events.ts';
import type { Game } from '../game/game.ts';

// Positional audio, synthesised with Web Audio so it ships without samples.
// Distance falloff and a real speed of sound: a shot 340 m away is heard a
// second after its muzzle flash, and a supersonic round's crack arrives before
// the bang (rules §8). Every shot is layered — mechanism, blast, tail, and a
// distant version chosen by range. Explosions duck the mix instead of making
// everything louder; a flashbang muffles it and leaves a ringing tone.

const DISTANT_M = 180; // beyond this the shot is the low, rolling distant version
const MAX_AUDIBLE_M = 1600;

export interface Listener {
  position: { x: number; y: number; z: number };
  forward: { x: number; y: number; z: number };
}

export class Audio {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly mix: GainNode; // ducked by explosions
  private readonly muffle: BiquadFilterNode; // closed by a flashbang
  private readonly noise: AudioBuffer;
  private readonly ringing: OscillatorNode;
  private readonly ringGain: GainNode;
  private readonly wind: GainNode;
  private outdoorTail = 1;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    this.muffle = this.ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.mix = this.ctx.createGain();
    this.mix.connect(this.muffle).connect(this.master);
    this.noise = this.makeNoise(2);
    this.ringGain = this.ctx.createGain();
    this.ringGain.gain.value = 0;
    this.ringing = this.ctx.createOscillator();
    this.ringing.frequency.value = 3600;
    this.ringing.connect(this.ringGain).connect(this.master);
    this.ringing.start();
    // Wind bed: brown-ish noise, level set per map.
    this.wind = this.ctx.createGain();
    this.wind.gain.value = 0;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    src.connect(lp).connect(this.wind).connect(this.mix);
    src.start();
  }

  /** Browsers start audio suspended until a user gesture. */
  resume(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  setAmbience(mapId: string, windMs: number): void {
    this.wind.gain.value = Math.min(0.12, windMs * (mapId === 'forest' ? 0.02 : 0.01));
    this.outdoorTail = mapId === 'city' || mapId === 'boulevard' ? 1.6 : mapId === 'forest' ? 0.9 : 1.1;
  }

  private makeNoise(seconds: number): AudioBuffer {
    const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * seconds), this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < d.length; i++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.02 * white) / 1.02;
      d[i] = white * 0.6 + brown * 2.5;
    }
    return buf;
  }

  updateListener(l: Listener, flashAmount: number): void {
    const a = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (a.positionX) {
      a.positionX.setTargetAtTime(l.position.x, t, 0.01);
      a.positionY.setTargetAtTime(l.position.y, t, 0.01);
      a.positionZ.setTargetAtTime(l.position.z, t, 0.01);
      a.forwardX.setTargetAtTime(l.forward.x, t, 0.01);
      a.forwardY.setTargetAtTime(l.forward.y, t, 0.01);
      a.forwardZ.setTargetAtTime(l.forward.z, t, 0.01);
      a.upX.value = 0;
      a.upY.value = 1;
      a.upZ.value = 0;
    }
    this.muffle.frequency.setTargetAtTime(20000 * (1 - flashAmount) + 350 * flashAmount, t, 0.05);
    this.ringGain.gain.setTargetAtTime(flashAmount * 0.05, t, 0.1);
  }

  /** A sound source at a world position (or at the listener when null), started `delay` seconds from now. */
  private voice(pos: Vec3 | null, delay: number): { out: AudioNode; when: number } {
    const when = this.ctx.currentTime + delay;
    if (!pos) return { out: this.mix, when };
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 2;
    p.rolloffFactor = 1;
    p.maxDistance = MAX_AUDIBLE_M;
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
    p.connect(this.mix);
    return { out: p, when };
  }

  private burst(out: AudioNode, when: number, gain: number, attack: number, decay: number, type: BiquadFilterType, freq: number, q = 0.7): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + attack);
    g.gain.exponentialRampToValueAtTime(1e-4, when + attack + decay);
    src.connect(f).connect(g).connect(out);
    src.start(when, Math.random() * 1.5, attack + decay + 0.05);
  }

  private tone(out: AudioNode, when: number, gain: number, freq: number, endFreq: number, decay: number, type: OscillatorType = 'sine'): void {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, when);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), when + decay);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(1e-4, when + decay);
    o.connect(g).connect(out);
    o.start(when);
    o.stop(when + decay + 0.02);
  }

  private distanceTo(pos: Vec3, l: Listener): number {
    return Math.hypot(pos.x - l.position.x, pos.y - l.position.y, pos.z - l.position.z);
  }

  handle(e: GameEvent, game: Game, l: Listener): void {
    const playerId = game.player.id;
    switch (e.type) {
      case 'shot': {
        const own = e.shooterId === playerId;
        const d = own ? 0 : this.distanceTo(e.origin, l);
        if (d > MAX_AUDIBLE_M) return;
        const { out, when } = this.voice(own ? null : e.origin, d / PHYSICS.speedOfSoundMs);
        this.gunshot(out, when, e.weapon, e.suppressed, d, own);
        break;
      }
      case 'crack': {
        // The crack is heard where the round passed, right now: it outruns the muzzle report.
        const { out, when } = this.voice(e.pos, 0);
        this.burst(out, when, 0.9, 0.001, 0.012, 'highpass', 2500);
        this.burst(out, when + 0.004, 0.3, 0.001, 0.08, 'bandpass', 1800, 1.5);
        break;
      }
      case 'impact': {
        const d = this.distanceTo(e.pos, l);
        if (d > 120) return;
        const { out, when } = this.voice(e.pos, d / PHYSICS.speedOfSoundMs);
        this.impact(out, when, e.surface);
        break;
      }
      case 'hit':
        if (e.byPlayer) {
          // Confirmation tick, distinct for armour, flesh and a kill.
          this.tone(this.mix, this.ctx.currentTime + 0.02, 0.12, e.killed ? 900 : e.armour ? 2200 : 1400, e.killed ? 500 : 1800, e.killed ? 0.18 : 0.06, 'triangle');
        }
        break;
      case 'playerHit':
        if (e.armour) {
          this.tone(this.mix, this.ctx.currentTime, 0.35, 700, 300, 0.25, 'square');
          this.burst(this.mix, this.ctx.currentTime, 0.5, 0.001, 0.12, 'bandpass', 2400, 3);
        } else {
          this.burst(this.mix, this.ctx.currentTime, 0.8, 0.002, 0.15, 'lowpass', 300);
          this.tone(this.mix, this.ctx.currentTime, 0.4, 110, 60, 0.2);
        }
        break;
      case 'explosion': {
        const d = this.distanceTo(e.pos, l);
        const { out, when } = this.voice(e.pos, d / PHYSICS.speedOfSoundMs);
        if (e.kind === 'smoke') {
          this.burst(out, when, 0.5, 0.01, 1.5, 'bandpass', 1200, 0.6);
          return;
        }
        this.burst(out, when, 3, 0.002, 0.4, 'lowpass', 900);
        this.tone(out, when, 1.6, 90, 30, 0.9);
        this.burst(out, when + 0.05, 1.2, 0.02, 1.8 * this.outdoorTail, 'lowpass', 400);
        // Duck the mix for a moment rather than turning the boom up.
        const t = when;
        this.mix.gain.cancelScheduledValues(t);
        this.mix.gain.setValueAtTime(this.mix.gain.value, t);
        this.mix.gain.linearRampToValueAtTime(0.45, t + 0.03);
        this.mix.gain.linearRampToValueAtTime(1, t + 1.4);
        break;
      }
      case 'grenadeBounce': {
        const { out, when } = this.voice(e.pos, 0);
        this.tone(out, when, Math.min(0.5, e.speedMs * 0.08), 1900, 1600, 0.08, 'triangle');
        break;
      }
      case 'grenadeThrow':
        if (e.byPlayer) this.burst(this.mix, this.ctx.currentTime, 0.25, 0.05, 0.2, 'bandpass', 700, 0.8);
        break;
      case 'glassBreak': {
        const { out, when } = this.voice(e.pos, 0);
        for (let i = 0; i < 7; i++) this.tone(out, when + i * 0.018, 0.15, 3000 + Math.random() * 3000, 2500, 0.12, 'triangle');
        this.burst(out, when, 0.6, 0.001, 0.4, 'highpass', 3000);
        break;
      }
      case 'reload': {
        const t = this.ctx.currentTime;
        if (e.phase === 'magOut') this.mech(t, 900, 0.25);
        else if (e.phase === 'magIn') this.mech(t, 700, 0.4);
        else if (e.phase === 'boltRelease') this.mech(t, 1300, 0.5);
        break;
      }
      case 'boltCycle': {
        const t = this.ctx.currentTime;
        this.mech(t + 0.1, 1100, 0.3);
        this.mech(t + 0.45, 800, 0.35);
        this.mech(t + 0.8, 1200, 0.3);
        break;
      }
      case 'dryFire':
        this.mech(this.ctx.currentTime, 2400, 0.2);
        break;
      case 'fireMode':
      case 'suppressor':
      case 'weaponSwitch':
        this.mech(this.ctx.currentTime, 1600, 0.15);
        break;
      case 'footstep': {
        const d = e.isPlayer ? 0 : this.distanceTo(e.pos, l);
        if (d > 40) return;
        const { out, when } = this.voice(e.isPlayer ? null : e.pos, 0);
        const bright = e.surface === 'wood' || e.surface === 'sheetMetal' ? 1800 : e.surface === 'soil' || e.surface === 'foliage' ? 500 : 900;
        this.burst(out, when, 0.12 * e.loudness, 0.004, 0.09, 'bandpass', bright, 1.2);
        break;
      }
      case 'land':
        this.burst(this.mix, this.ctx.currentTime, Math.min(1, e.impactSpeedMs * 0.1), 0.003, 0.18, 'lowpass', 250);
        if (e.brokenLeg) this.burst(this.mix, this.ctx.currentTime + 0.02, 0.6, 0.001, 0.05, 'highpass', 1500);
        break;
      case 'itemStart':
      case 'pickup':
        this.burst(this.mix, this.ctx.currentTime, 0.2, 0.02, 0.3, 'bandpass', 1500, 0.8);
        break;
      case 'breath':
        this.burst(this.mix, this.ctx.currentTime, 0.12, e.holding ? 0.2 : 0.05, e.holding ? 0.3 : 0.6, 'bandpass', e.holding ? 900 : 600, 0.7);
        break;
      case 'callout': {
        // No voice samples: a short shouted formant buzz marks where the call came from.
        const d = this.distanceTo(e.pos, l);
        if (d > 90) return;
        const { out, when } = this.voice(e.pos, d / PHYSICS.speedOfSoundMs);
        const f = this.ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 900;
        f.Q.value = 3;
        f.connect(out);
        this.tone(f, when, 0.5, 170, 140, 0.35, 'sawtooth');
        break;
      }
      default:
        break;
    }
  }

  private mech(when: number, freq: number, gain: number): void {
    this.burst(this.mix, when, gain, 0.001, 0.035, 'bandpass', freq, 4);
    this.tone(this.mix, when, gain * 0.3, freq * 1.7, freq * 1.5, 0.05, 'square');
  }

  private gunshot(out: AudioNode, when: number, weapon: string, suppressed: boolean, distanceM: number, own: boolean): void {
    const big = weapon === 'sniper' ? 1.5 : weapon === 'pistol' ? 0.6 : 1;
    const s = suppressed ? 0.25 : 1;
    if (own) this.mech(when, weapon === 'pistol' ? 2000 : 1500, 0.25); // mechanism, only audible up close
    if (distanceM < DISTANT_M) {
      // Blast: a hard broadband crack with body; the tail rings off the surroundings.
      this.burst(out, when, 2.2 * big * s, 0.0008, 0.07, suppressed ? 'lowpass' : 'highpass', suppressed ? 1400 : 180);
      this.tone(out, when, 1.0 * big * s, 140, 50, 0.12);
      this.burst(out, when + 0.02, 0.5 * big * s, 0.02, 0.9 * this.outdoorTail, 'lowpass', 1600);
    } else {
      // Distant: the highs are gone, a low thump rolls on.
      this.burst(out, when, 1.4 * big * s, 0.01, 0.5 * this.outdoorTail, 'lowpass', 500);
      this.tone(out, when, 0.6 * big * s, 80, 40, 0.5);
    }
  }

  private impact(out: AudioNode, when: number, surface: SurfaceKind): void {
    switch (surface) {
      case 'sheetMetal':
      case 'armourPlate':
        this.tone(out, when, 0.35, 2600, 2300, 0.25, 'triangle');
        this.burst(out, when, 0.4, 0.001, 0.05, 'highpass', 2000);
        break;
      case 'wood':
        this.tone(out, when, 0.3, 420, 300, 0.08, 'triangle');
        this.burst(out, when, 0.3, 0.001, 0.06, 'bandpass', 900, 1.5);
        break;
      case 'soil':
      case 'foliage':
        this.burst(out, when, 0.35, 0.002, 0.12, 'lowpass', 500);
        break;
      case 'glass':
        this.burst(out, when, 0.4, 0.001, 0.2, 'highpass', 3500);
        break;
      case 'flesh':
      case 'fabric':
        this.burst(out, when, 0.3, 0.002, 0.08, 'lowpass', 350);
        break;
      default:
        this.burst(out, when, 0.45, 0.001, 0.07, 'bandpass', 1600, 1.2);
        this.burst(out, when + 0.01, 0.15, 0.01, 0.2, 'highpass', 4000);
    }
  }
}
