import { FIRE } from '../config.ts';
import type { EventQueue } from './events.ts';

// The camp fire as a fuel store: it burns wood seconds (faster in the rain)
// and goes out when they run out. A log adds FIRE.logBurnS; a dead fire with
// wood on it needs the lighter. `strength` (0–1) scales the flames, the light
// and the crackle, so a fire running low visibly and audibly dies down.

export class Campfire {
  fuelS: number = FIRE.startFuelS;
  lit = true;

  /** 0 (out) … 1 (a full fire). A fire burns bright until it gets low, then fades. */
  get strength(): number {
    return this.lit ? Math.min(1, Math.sqrt(this.fuelS / FIRE.fullFuelS)) : 0;
  }

  step(dt: number, rainRate: number, events: EventQueue): void {
    if (!this.lit) return;
    this.fuelS -= dt * (1 + rainRate * FIRE.rainBurnFactor);
    if (this.fuelS <= 0) {
      this.fuelS = 0;
      this.lit = false;
      events.push({ type: 'fire', what: 'out' });
    }
  }

  /** A log on the fire (or in the dead pit, ready to light). False when the pit is already full. */
  addLog(events: EventQueue): boolean {
    if (this.fuelS > FIRE.maxFuelS - FIRE.logBurnS * 0.5) return false;
    this.fuelS = Math.min(FIRE.maxFuelS, this.fuelS + FIRE.logBurnS);
    events.push({ type: 'fire', what: 'fed' });
    return true;
  }

  /** Light the wood in the pit. False with nothing to burn. */
  light(events: EventQueue): boolean {
    if (this.lit || this.fuelS <= 0) return false;
    this.lit = true;
    events.push({ type: 'fire', what: 'lit' });
    return true;
  }
}
