import { KNIFE, RIFLE, STONE } from '../config.ts';
import type { EquipSlot } from './events.ts';

// What the hands are doing. One action at a time: raising or lowering a tool,
// firing, reloading, a knife swing, a stone wind-up and throw, or a hands-on
// interaction (pick-up, harvest, crate). Logic owns the timing; the viewmodel
// only reads `action` and `progress` to pose the arms.

export type ActionKind = 'idle' | 'lower' | 'raise' | 'reload' | 'swing' | 'windup' | 'throw' | 'pickup' | 'harvest' | 'openCrate' | 'examine' | 'sleep';

export interface Action {
  kind: ActionKind;
  elapsedSeconds: number;
  durationSeconds: number; // Infinity for open-ended (wind-up, examine)
  /** Reload: whether the magazine ran dry (adds the charging handle). */
  empty: boolean;
  /** Pick-up, harvest or crate: which interactable. */
  targetId: number;
  /** Knife: which way this swing cuts. */
  side: 1 | -1;
}

export interface Triggers {
  firePressed: boolean;
  fireHeld: boolean;
  fireReleased: boolean;
  aimHeld: boolean;
  reloadPressed: boolean;
  selectSlot: EquipSlot | null;
}

export class Equipment {
  slot: EquipSlot = 'hands';
  private pendingSlot: EquipSlot = 'hands';
  readonly action: Action = { kind: 'idle', elapsedSeconds: 0, durationSeconds: 0, empty: false, targetId: -1, side: 1 };
  magazineRounds: number = RIFLE.magazineRounds;
  adsBlend = 0;
  /** Seconds until the rifle can fire again. */
  cooldownSeconds = 0;
  /** Stone wind-up power 0..1, frozen at release for the throw animation. */
  charge = 0;
  /** Visual recoil for the viewmodel, metres of kick back; decays. */
  kickM = 0;
  /** Accumulated muzzle rise the aim recovers from (rad). */
  recoilPitchRad = 0;
  shotsFired = 0;
  private swingSide: 1 | -1 = 1;

  get progress(): number {
    const a = this.action;
    if (!Number.isFinite(a.durationSeconds) || a.durationSeconds <= 0) return 0;
    return Math.min(1, a.elapsedSeconds / a.durationSeconds);
  }

  get busy(): boolean {
    return this.action.kind !== 'idle';
  }

  /** Hands-on interactions need both hands: allowed from idle or while examining. */
  canInteract(): boolean {
    return this.action.kind === 'idle' || this.action.kind === 'examine';
  }

  start(kind: ActionKind, durationSeconds: number, targetId = -1): void {
    const a = this.action;
    a.kind = kind;
    a.elapsedSeconds = 0;
    a.durationSeconds = durationSeconds;
    a.targetId = targetId;
    a.empty = false;
    if (kind === 'swing') {
      this.swingSide = this.swingSide === 1 ? -1 : 1;
      a.side = this.swingSide;
    }
  }

  finish(): void {
    this.start('idle', 0);
  }

  /** Lower whatever is held, then raise `to`. Selecting the held slot again puts it away. */
  switchTo(to: EquipSlot): void {
    const target = to === this.slot ? 'hands' : to;
    if (target === this.slot && this.action.kind !== 'lower') return;
    this.pendingSlot = target;
    if (this.slot === 'hands') this.raise();
    else this.start('lower', 0.22);
  }

  private raise(): void {
    this.slot = this.pendingSlot;
    const dur = this.slot === 'rifle' ? RIFLE.equipSeconds : this.slot === 'knife' ? KNIFE.equipSeconds : this.slot === 'stone' ? 0.3 : 0;
    if (dur > 0) this.start('raise', dur);
    else this.finish();
  }

  /**
   * Advance the timeline. Returns the action that just completed (so the game
   * can apply its effect), or null.
   */
  tick(dt: number, triggers: Triggers): ActionKind | null {
    const a = this.action;
    this.cooldownSeconds = Math.max(0, this.cooldownSeconds - dt);
    this.kickM *= Math.exp(-dt * 14);
    this.recoilPitchRad *= Math.exp(-dt * RIFLE.recoilRecoverRatePerS);
    const aiming = this.slot === 'rifle' && triggers.aimHeld && (a.kind === 'idle' || a.kind === 'raise');
    this.adsBlend = Math.max(0, Math.min(1, this.adsBlend + (aiming ? dt : -dt) / RIFLE.adsSeconds));
    if (a.kind === 'idle') return null;
    a.elapsedSeconds += dt;
    if (a.kind === 'windup') {
      this.charge = Math.min(1, a.elapsedSeconds / STONE.chargeSeconds);
      return null;
    }
    if (!Number.isFinite(a.durationSeconds) || a.elapsedSeconds < a.durationSeconds) return null;
    const done = a.kind;
    if (done === 'lower') {
      this.raise();
      return done;
    }
    this.finish();
    return done;
  }
}
