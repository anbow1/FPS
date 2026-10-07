import type { ThreatLevel } from '../sim/radar.ts';

// Cockpit tones with Web Audio oscillators (no samples): the warning receiver
// (a blip per search paint, a steady pulse while tracked, a fast warble on a
// launch) and the infrared seeker (a low growl while searching, a high tone
// with a target). Started on the first user gesture, as browsers require.

export class Tones {
  private ctx: AudioContext | null = null;
  private rwrOsc: OscillatorNode | null = null;
  private rwrGain: GainNode | null = null;
  private seekOsc: OscillatorNode | null = null;
  private seekGain: GainNode | null = null;
  private lastBlipS = 0;
  muted = false;

  /** The audio context once started (the flight sounds share it). */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Call from a click or touch handler. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const make = (type: OscillatorType): [OscillatorNode, GainNode] => {
      const o = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      o.type = type;
      g.gain.value = 0;
      o.connect(g).connect(this.ctx!.destination);
      o.start();
      return [o, g];
    };
    [this.rwrOsc, this.rwrGain] = make('square');
    [this.seekOsc, this.seekGain] = make('sawtooth');
  }

  /** Per frame: the warning receiver's worst level, whether a new search paint arrived, the seeker state. */
  update(worst: ThreatLevel | null, newPaint: boolean, seeker: 'off' | 'search' | 'tone'): void {
    const ctx = this.ctx;
    if (!ctx || !this.rwrOsc || !this.rwrGain || !this.seekOsc || !this.seekGain) return;
    const t = ctx.currentTime;
    const vol = this.muted ? 0 : 1;
    // Warning receiver.
    let g = 0;
    let f = 1200;
    if (worst === 'launch') {
      f = Math.floor(t * 8) % 2 === 0 ? 1100 : 1700;
      g = 0.07;
    } else if (worst === 'track') {
      f = 900;
      g = Math.floor(t * 3) % 2 === 0 ? 0.05 : 0;
    } else if (newPaint && t - this.lastBlipS > 0.15) {
      this.lastBlipS = t;
    }
    if (worst !== 'launch' && worst !== 'track' && t - this.lastBlipS < 0.05) {
      f = 2000;
      g = 0.05;
    }
    this.rwrOsc.frequency.setTargetAtTime(f, t, 0.005);
    this.rwrGain.gain.setTargetAtTime(g * vol, t, 0.005);
    // Seeker.
    const sg = seeker === 'off' ? 0 : seeker === 'search' ? 0.025 : 0.05;
    const sf = seeker === 'tone' ? 880 + Math.sin(t * 40) * 30 : 220 + Math.sin(t * 23) * 25;
    this.seekOsc.frequency.setTargetAtTime(sf, t, 0.01);
    this.seekGain.gain.setTargetAtTime(sg * vol, t, 0.02);
  }
}
