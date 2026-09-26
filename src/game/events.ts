import type { GrenadeKind, SurfaceKind, WeaponId } from '../config.ts';
import type { Vec3 } from '../core/vec.ts';
import type { BodyPart } from './actor.ts';

// Logic → presentation. Systems push events; the render, audio and HUD layers
// drain the queue once per frame. Logic never calls into THREE or Web Audio.

export type GameEvent =
  | { type: 'shot'; shooterId: number; weapon: WeaponId; origin: Vec3; dir: Vec3; suppressed: boolean }
  | { type: 'impact'; pos: Vec3; normal: Vec3; surface: SurfaceKind; exit: boolean }
  | { type: 'hit'; targetId: number; part: BodyPart; pos: Vec3; armour: boolean; killed: boolean; byPlayer: boolean }
  | { type: 'playerHit'; fromDir: Vec3; part: BodyPart; armour: boolean; damage: number }
  | { type: 'crack'; pos: Vec3 }
  | { type: 'explosion'; pos: Vec3; kind: GrenadeKind }
  | { type: 'grenadeThrow'; kind: GrenadeKind; byPlayer: boolean }
  | { type: 'grenadeBounce'; pos: Vec3; speedMs: number }
  | { type: 'flashed'; amount: number }
  | { type: 'reload'; weapon: WeaponId; phase: 'magOut' | 'magIn' | 'boltRelease' | 'done'; empty: boolean }
  | { type: 'boltCycle'; weapon: WeaponId }
  | { type: 'dryFire'; weapon: WeaponId }
  | { type: 'fireMode'; auto: boolean }
  | { type: 'weaponSwitch'; weapon: WeaponId }
  | { type: 'suppressor'; attached: boolean }
  | { type: 'footstep'; pos: Vec3; surface: SurfaceKind; loudness: number; isPlayer: boolean }
  | { type: 'land'; impactSpeedMs: number; brokenLeg: boolean }
  | { type: 'glassBreak'; pos: Vec3 }
  | { type: 'plateBreak'; actorId: number; isPlayer: boolean }
  | { type: 'itemStart'; item: 'medKit' | 'ammoPack' }
  | { type: 'itemDone'; item: 'medKit' | 'ammoPack' }
  | { type: 'itemInterrupted'; item: 'medKit' | 'ammoPack' }
  | { type: 'pickup'; item: 'medKit' | 'ammoPack' | 'grenade' }
  | { type: 'callout'; pos: Vec3; text: 'contact' | 'flank' | 'grenade' | 'fallback' | 'reloading' | 'man down' }
  | { type: 'breath'; holding: boolean }
  | { type: 'objective'; text: string }
  | { type: 'gameOver'; won: boolean; reason: string };

export class EventQueue {
  private items: GameEvent[] = [];

  push(e: GameEvent): void {
    this.items.push(e);
  }

  /** Hands the queued events to the caller and starts a fresh queue. */
  drain(): GameEvent[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}
