import type { SpeciesId, TimeOfDayId } from '../config.ts';
import type { SurfaceKind } from './terrain.ts';

// Everything logic tells render, audio and HUD about, once per step. The
// consumers never reach back into logic to find out what happened.

export interface P3 {
  x: number;
  y: number;
  z: number;
}

export type EquipSlot = 'hands' | 'rifle' | 'knife' | 'stone' | 'log';

export type LagoonEvent =
  | { type: 'footstep'; surface: SurfaceKind; pos: P3; running: boolean; wadingDepthM: number }
  | { type: 'jump'; surface: SurfaceKind }
  | { type: 'land'; surface: SurfaceKind; impactSpeedMs: number }
  | { type: 'swim'; what: 'start' | 'stand' | 'under' | 'surface' | 'outOfAir'; airFraction?: number }
  | { type: 'swimStroke'; pos: P3; underwater: boolean; fast: boolean }
  | { type: 'stoneWindup' }
  | { type: 'stoneThrown'; pos: P3; speedMs: number }
  | { type: 'splash'; pos: P3; speedMs: number; massKg: number; skip: boolean }
  | { type: 'bodyHit'; pos: P3; surface: SurfaceKind; speedMs: number; body: 'stone' | 'can' | 'coconut' | 'shell' | 'log' }
  | { type: 'shot'; origin: P3; dir: P3 }
  | { type: 'shellEject' }
  | { type: 'bulletImpact'; pos: P3; normal: P3; dir: P3; surface: SurfaceKind; distanceM: number }
  | { type: 'bulletLeaves'; pos: P3 }
  | { type: 'dryFire' }
  | { type: 'reloadStart'; empty: boolean }
  | { type: 'reloadStage'; stage: 'magOut' | 'magIn' | 'charge' }
  | { type: 'knifeSwing'; side: 1 | -1 }
  | { type: 'knifeHit'; pos: P3; normal: P3; surface: SurfaceKind }
  | { type: 'equip'; slot: EquipSlot }
  | { type: 'actionStart'; kind: 'pickup' | 'harvest' | 'openCrate' }
  | { type: 'itemGained'; itemId: string; count: number; name: string }
  | { type: 'interactableRemoved'; id: number }
  | { type: 'crateOpened'; id: number }
  | { type: 'examine'; id: number; title: string; text: string }
  | { type: 'canHit'; id: number }
  | { type: 'lightning'; strength: number; thunderDelaySeconds: number }
  | { type: 'message'; text: string }
  | { type: 'sleep'; until: TimeOfDayId }
  | { type: 'lamp'; lit: boolean }
  | { type: 'fire'; what: 'fed' | 'lit' | 'out' }
  | { type: 'boat'; what: 'board' | 'leave' | 'engineStart' | 'bump' | 'ground' }
  | { type: 'jeep'; what: 'enter' | 'exit' | 'start' | 'bump' | 'door' | 'bonnet' | 'lights' }
  // Threats (game/fauna.ts, game/guerrillas.ts) and the player's body.
  | { type: 'hurt'; amount: number; from: P3 | null; cause: ThreatKind | 'fall' }
  | { type: 'blackout'; cause: ThreatKind | 'fall' }
  | { type: 'wake' }
  | { type: 'treat'; item: string; hp: number; text: string }
  | { type: 'threatHit'; pos: P3; dir: P3; kind: ThreatKind; part: HitPart; killed: boolean }
  | { type: 'threatCall'; pos: P3; kind: ThreatKind; call: ThreatCall }
  | { type: 'enemyShot'; origin: P3; dir: P3 }
  | { type: 'whiz'; pos: P3 };

/** Anything that can hurt the player. */
export type ThreatKind = SpeciesId | 'guerrilla';
export type HitPart = 'head' | 'torso' | 'limb';
/** A creature's or a guerrilla's voice and body noises, for audio. */
export type ThreatCall = 'growl' | 'roar' | 'snarl' | 'grunt' | 'squeal' | 'hiss' | 'bite' | 'splash' | 'shout' | 'pain' | 'die' | 'step';

export class EventQueue {
  private items: LagoonEvent[] = [];

  push(e: LagoonEvent): void {
    this.items.push(e);
  }

  drain(): LagoonEvent[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}
