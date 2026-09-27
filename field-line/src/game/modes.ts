import { MODES } from '../config.ts';
import { Vec3 } from '../core/vec.ts';
import type { MapData } from '../maps/types.ts';

// Skirmish, Extraction and Range rules. The mode owns the objective line and
// the objective bearing on the compass; the game asks it for reinforcements.

export type ModeId = 'skirmish' | 'extraction' | 'range';

export interface ModeView {
  objectiveText: string;
  objectivePos: Vec3 | null;
  finished: boolean;
  won: boolean;
  resultText: string;
}

export interface ModeInputs {
  playerPos: Vec3;
  playerAlive: boolean;
  enemiesAlive: number;
  dt: number;
}

export class Mode {
  readonly view: ModeView = { objectiveText: '', objectivePos: null, finished: false, won: false, resultText: '' };
  private phase: 'reach' | 'hold' | 'leave' = 'reach';
  holdSeconds = 0;
  private waveTimer = 0;
  wavesRequested = 0;
  lastRangeHit: { distanceM: number; ageSeconds: number } | null = null;
  rangeHits = 0;

  constructor(
    readonly id: ModeId,
    private readonly map: MapData,
  ) {
    this.update({ playerPos: map.playerSpawn.pos, playerAlive: true, enemiesAlive: 1, dt: 0 });
  }

  /** Initial number of squads to spawn from the map's squad spawns. */
  initialSquadCount(): number {
    if (this.id === 'range') return 0;
    if (this.id === 'extraction') return Math.max(1, Math.ceil(this.map.squadSpawns.length / 2));
    return this.map.squadSpawns.length;
  }

  /** Returns true when a reinforcement wave should spawn this step. */
  update(inputs: ModeInputs): boolean {
    const v = this.view;
    if (this.lastRangeHit) this.lastRangeHit.ageSeconds += inputs.dt;
    if (v.finished) return false;
    if (!inputs.playerAlive) {
      this.finish(false, 'You were killed.');
      return false;
    }
    switch (this.id) {
      case 'skirmish':
        v.objectiveText = `Clear all enemy squads · ${inputs.enemiesAlive} hostiles left`;
        v.objectivePos = null;
        if (inputs.enemiesAlive === 0 && inputs.dt > 0) this.finish(true, 'Area clear. All enemy squads neutralised.');
        return false;
      case 'range':
        v.objectiveText = 'Range · zero at 300 m, then work out to 800 m';
        v.objectivePos = null;
        return false;
      case 'extraction':
        return this.updateExtraction(inputs);
    }
  }

  registerRangeHit(distanceM: number): void {
    this.lastRangeHit = { distanceM, ageSeconds: 0 };
    this.rangeHits++;
  }

  private updateExtraction(inputs: ModeInputs): boolean {
    const v = this.view;
    const hold = this.map.extraction.hold;
    const inside = inputs.playerPos.distanceToXZ(hold) < MODES.extractionRadiusM;
    if (this.phase === 'reach') {
      v.objectiveText = 'Reach the extraction point';
      v.objectivePos = hold;
      if (inside) this.phase = 'hold';
      return false;
    }
    if (this.phase === 'hold') {
      if (inside) this.holdSeconds += inputs.dt;
      const left = Math.max(0, MODES.extractionHoldSeconds - this.holdSeconds);
      v.objectiveText = inside ? `Hold the point · ${Math.ceil(left)} s` : `Return to the point · ${Math.ceil(left)} s left`;
      v.objectivePos = hold;
      this.waveTimer += inputs.dt;
      let wave = false;
      if (this.waveTimer >= MODES.extractionWaveSeconds || (this.wavesRequested === 0 && this.holdSeconds > 2)) {
        this.waveTimer = 0;
        this.wavesRequested++;
        wave = true;
      }
      if (left <= 0) this.phase = 'leave';
      return wave;
    }
    v.objectiveText = 'Exfil · get to the exit';
    v.objectivePos = this.map.extraction.exit;
    if (inputs.playerPos.distanceToXZ(this.map.extraction.exit) < MODES.extractionRadiusM) this.finish(true, 'Extracted.');
    return false;
  }

  private finish(won: boolean, text: string): void {
    this.view.finished = true;
    this.view.won = won;
    this.view.resultText = text;
  }
}

export const MODE_LABELS: Record<ModeId, string> = {
  range: 'Range',
  skirmish: 'Skirmish',
  extraction: 'Extraction',
};

export function defaultRangeFocus(): Vec3 {
  return new Vec3(0, 0, -300);
}
