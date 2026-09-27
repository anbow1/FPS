import type { SurfaceKind } from './terrain.ts';

// Everything logic tells render, audio and HUD about, once per step. The
// consumers never reach back into logic to find out what happened.

export interface P3 {
  x: number;
  y: number;
  z: number;
}

export type EquipSlot = 'hands' | 'rifle' | 'knife' | 'stone';

export type LagoonEvent =
  | { type: 'footstep'; surface: SurfaceKind; pos: P3; running: boolean; wadingDepthM: number }
  | { type: 'jump'; surface: SurfaceKind }
  | { type: 'land'; surface: SurfaceKind; impactSpeedMs: number }
  | { type: 'stoneWindup' }
  | { type: 'stoneThrown'; pos: P3; speedMs: number }
  | { type: 'splash'; pos: P3; speedMs: number; massKg: number; skip: boolean }
  | { type: 'bodyHit'; pos: P3; surface: SurfaceKind; speedMs: number; body: 'stone' | 'can' | 'coconut' | 'shell' }
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
  | { type: 'message'; text: string };

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
