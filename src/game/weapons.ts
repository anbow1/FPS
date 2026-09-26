import { SCOPE, WEAPONS, type WeaponId, type WeaponSpec } from '../config.ts';
import type { Rng } from '../core/rng.ts';
import { directionFromYawPitch, Vec3 } from '../core/vec.ts';
import { muzzleEnergyJ, zeroElevationRad } from './ballistics.ts';
import type { EventQueue } from './events.ts';
import type { Player } from './player.ts';
import type { Projectiles } from './projectiles.ts';

export interface WeaponIntent {
  fireHeld: boolean;
  firePressed: boolean;
  aimHeld: boolean;
  reloadPressed: boolean;
  fireModePressed: boolean;
  select: WeaponId | null;
  zoomPressed: boolean;
  suppressorPressed: boolean;
}

export interface WeaponState {
  spec: WeaponSpec;
  magRounds: number;
  chambered: boolean;
  spareMags: number[]; // rounds in each carried magazine
  autoMode: boolean;
  suppressed: boolean;
}

export type WeaponActionKind = 'idle' | 'reload' | 'bolt' | 'switch' | 'suppressor' | 'busy';

export interface WeaponAction {
  kind: WeaponActionKind;
  elapsedSeconds: number;
  durationSeconds: number;
  empty: boolean; // empty reload (bolt release) vs tactical
  phaseEvents: number; // bitmask of reload phase events already sent
  nextWeapon: WeaponId | null;
}

const SWITCH_SECONDS = 0.7;
const SUPPRESSOR_SECONDS = 2.4;
const RECOIL_RECOVERY_DELAY_SECONDS = 0.07;

export class WeaponSystem {
  readonly weapons: Record<WeaponId, WeaponState>;
  current: WeaponId = 'rifle';
  readonly action: WeaponAction = { kind: 'idle', elapsedSeconds: 0, durationSeconds: 0, empty: false, phaseEvents: 0, nextWeapon: null };
  adsBlend = 0; // 0 hip … 1 fully aimed
  recoilPitchRad = 0; // aim offset, recovers toward the original point of aim
  recoilYawRad = 0;
  visualKickM = 0; // viewmodel slide-back, separate from aim kick (render reads it)
  visualKickRollRad = 0;
  bloomRad = 0; // hip-fire cone growth from sustained fire
  swayPitchRad = 0;
  swayYawRad = 0;
  scopeMagIndex = 0;
  secondsSinceShot = 99;
  shotCounter = 0;
  private cooldownSeconds = 0;
  private swayTimeSeconds = 0;
  private boltPending = false;

  constructor(private readonly rng: Rng) {
    this.weapons = {
      rifle: makeState(WEAPONS.rifle, 5),
      sniper: makeState(WEAPONS.sniper, 4),
      pistol: makeState(WEAPONS.pistol, 2),
    };
  }

  get state(): WeaponState {
    return this.weapons[this.current];
  }

  get scopeMagnification(): number {
    return SCOPE.magnifications[this.scopeMagIndex] ?? 4;
  }

  /** The player cannot shoot or aim while busy with an item or a grenade. */
  isReady(): boolean {
    return this.action.kind === 'idle';
  }

  update(intent: WeaponIntent, player: Player, projectiles: Projectiles, events: EventQueue, dt: number): void {
    this.secondsSinceShot += dt;
    this.cooldownSeconds = Math.max(0, this.cooldownSeconds - dt);
    const st = this.state;
    const blocked = !player.alive || player.itemInUse !== null;

    if (!blocked && this.action.kind === 'idle') {
      if (intent.select && intent.select !== this.current) this.startAction('switch', SWITCH_SECONDS, false, intent.select);
      else if (intent.fireModePressed && st.spec.autoCapable) {
        st.autoMode = !st.autoMode;
        events.push({ type: 'fireMode', auto: st.autoMode });
      } else if (intent.reloadPressed) this.tryReload();
      else if (intent.suppressorPressed && this.current !== 'pistol') this.startAction('suppressor', SUPPRESSOR_SECONDS, false, null);
      if (intent.zoomPressed && this.current === 'sniper') this.scopeMagIndex = (this.scopeMagIndex + 1) % SCOPE.magnifications.length;
    }

    this.advanceAction(dt, events);

    const canAim = !blocked && !player.isSprinting && (this.action.kind === 'idle' || this.action.kind === 'bolt');
    const adsTarget = intent.aimHeld && canAim ? 1 : 0;
    const adsRate = dt / st.spec.adsSeconds;
    // Compare with the target, not the current blend: at 1 a '>' test would start lowering the sights.
    this.adsBlend = adsTarget === 1 ? Math.min(1, this.adsBlend + adsRate) : Math.max(0, this.adsBlend - adsRate * 1.3);

    const triggerWants = st.autoMode ? intent.fireHeld : intent.firePressed;
    if (!blocked && this.action.kind === 'idle' && !player.isSprinting && triggerWants && this.cooldownSeconds <= 0) {
      if (st.chambered) this.fire(player, projectiles, events);
      else if (intent.firePressed) {
        events.push({ type: 'dryFire', weapon: this.current });
        if (st.spec.boltAction && st.magRounds > 0) this.boltPending = true;
      }
    }
    // Bolt action: work the bolt once the trigger is released.
    if (this.boltPending && !intent.fireHeld && this.action.kind === 'idle' && !blocked) {
      this.boltPending = false;
      if (st.magRounds > 0) {
        this.startAction('bolt', st.spec.boltCycleSeconds, false, null);
        events.push({ type: 'boltCycle', weapon: this.current });
      }
    }

    this.updateRecoil(player, dt);
    this.updateSway(player, dt);
  }

  private tryReload(): void {
    const st = this.state;
    if (st.magRounds >= st.spec.magazineSize) return;
    if (!st.spareMags.some((n) => n > 0)) return;
    const empty = !st.chambered;
    this.startAction('reload', empty ? st.spec.emptyReloadSeconds : st.spec.tacticalReloadSeconds, empty, null);
  }

  private startAction(kind: WeaponActionKind, seconds: number, empty: boolean, nextWeapon: WeaponId | null): void {
    this.action.kind = kind;
    this.action.elapsedSeconds = 0;
    this.action.durationSeconds = seconds;
    this.action.empty = empty;
    this.action.phaseEvents = 0;
    this.action.nextWeapon = nextWeapon;
  }

  /** Occupies the hands for an item or grenade (no shooting, no aiming). */
  startBusy(seconds: number): void {
    this.startAction('busy', seconds, false, null);
  }

  private advanceAction(dt: number, events: EventQueue): void {
    const a = this.action;
    if (a.kind === 'idle') return;
    a.elapsedSeconds += dt;
    const t = a.elapsedSeconds / a.durationSeconds;
    const st = this.state;
    if (a.kind === 'reload') {
      this.reloadPhase(t, 0.25, 1, 'magOut', events);
      this.reloadPhase(t, 0.6, 2, 'magIn', events);
      if (a.empty) this.reloadPhase(t, 0.85, 4, 'boltRelease', events);
    }
    if (a.kind === 'switch' && t >= 0.5 && a.nextWeapon) {
      this.current = a.nextWeapon;
      a.nextWeapon = null;
      events.push({ type: 'weaponSwitch', weapon: this.current });
    }
    if (a.kind === 'bolt' && t >= 0.55 && !st.chambered && st.magRounds > 0) {
      st.magRounds--;
      st.chambered = true;
    }
    if (t < 1) return;
    if (a.kind === 'reload') {
      this.completeReload(a.empty);
      events.push({ type: 'reload', weapon: this.current, phase: 'done', empty: a.empty });
    }
    if (a.kind === 'suppressor') {
      st.suppressed = !st.suppressed;
      events.push({ type: 'suppressor', attached: st.suppressed });
    }
    a.kind = 'idle';
  }

  private reloadPhase(t: number, at: number, bit: number, phase: 'magOut' | 'magIn' | 'boltRelease', events: EventQueue): void {
    if (t >= at && (this.action.phaseEvents & bit) === 0) {
      this.action.phaseEvents |= bit;
      events.push({ type: 'reload', weapon: this.current, phase, empty: this.action.empty });
    }
  }

  private completeReload(empty: boolean): void {
    const st = this.state;
    // Take the fullest spare; the one coming out goes back in the pouch if not empty.
    let best = 0;
    for (let i = 1; i < st.spareMags.length; i++) if ((st.spareMags[i] as number) > (st.spareMags[best] as number)) best = i;
    const incoming = st.spareMags[best] ?? 0;
    if (incoming <= 0) return;
    st.spareMags.splice(best, 1);
    if (st.magRounds > 0) st.spareMags.push(st.magRounds);
    st.magRounds = incoming;
    if (empty) {
      // Bolt release strips the first round into the chamber.
      st.magRounds--;
      st.chambered = true;
    }
  }

  /** Ammo pack: refill every magazine of both primaries. */
  refillPrimaries(): void {
    for (const id of ['rifle', 'sniper'] as const) {
      const st = this.weapons[id];
      st.spareMags = new Array<number>(st.spec.magazinesCarriedMax - 1).fill(st.spec.magazineSize);
      if (st.magRounds === 0 && !st.chambered) {
        st.magRounds = st.spec.magazineSize - 1;
        st.chambered = true;
      }
    }
  }

  addLooseMagazines(count: number): void {
    const st = this.weapons.rifle;
    for (let i = 0; i < count && st.spareMags.length < st.spec.magazinesCarriedMax; i++) st.spareMags.push(st.spec.magazineSize);
  }

  /** Aim direction including recoil and sway; the camera and the bullet share it. */
  viewYaw(player: Player): number {
    return player.yawRad + this.recoilYawRad + this.swayYawRad * this.adsBlend;
  }

  viewPitch(player: Player): number {
    return player.pitchRad + this.recoilPitchRad + this.swayPitchRad * this.adsBlend;
  }

  currentSpreadRad(player: Player): number {
    const spec = this.state.spec;
    const speed = Math.hypot(player.body.velocity.x, player.body.velocity.z);
    const hip = spec.hipSpreadRad + spec.hipSpreadMoveRad * Math.min(1, speed / 6) + this.bloomRad + (player.body.grounded ? 0 : 0.05);
    const stanceScale = player.stance === 'prone' ? 0.5 : player.stance === 'crouch' ? 0.75 : 1;
    return hip * stanceScale * (1 - this.adsBlend) + spec.adsSpreadRad * this.adsBlend;
  }

  private fire(player: Player, projectiles: Projectiles, events: EventQueue): void {
    const st = this.state;
    const spec = st.spec;
    st.chambered = false;
    if (!spec.boltAction && st.magRounds > 0) {
      st.magRounds--;
      st.chambered = true;
    }
    if (spec.boltAction) this.boltPending = true;
    this.cooldownSeconds = 60 / spec.roundsPerMinute;
    this.secondsSinceShot = 0;
    this.shotCounter++;

    const yaw = this.viewYaw(player);
    const pitch = this.viewPitch(player);
    player.eyePosition(_origin);
    // The bore sits sightHeight below the line of sight; zero elevation makes
    // the two cross at the zero range, exactly as on the ballistics sheet.
    _origin.y -= spec.round.sightHeightM * Math.cos(pitch);
    const spread = this.currentSpreadRad(player);
    const r = spread * Math.sqrt(this.rng.next());
    const a = this.rng.next() * Math.PI * 2;
    directionFromYawPitch(yaw + Math.cos(a) * r, pitch + zeroElevationRad(spec.round) + Math.sin(a) * r, _dir);
    projectiles.spawn(player.id, _origin, _dir, spec.round, muzzleEnergyJ(spec.round), true);
    events.push({ type: 'shot', shooterId: player.id, weapon: this.current, origin: _origin.clone(), dir: _dir.clone(), suppressed: st.suppressed });

    // Aim kick with a seeded horizontal component; visual kick is separate.
    const stanceKick = player.stance === 'prone' ? 0.55 : player.stance === 'crouch' ? 0.8 : 1;
    this.recoilPitchRad += spec.recoilPitchRad * stanceKick * (0.85 + 0.3 * this.rng.next());
    this.recoilYawRad += spec.recoilYawRad * stanceKick * (this.rng.next() * 2 - 0.8);
    this.visualKickM += spec.visualKickM;
    this.visualKickRollRad += (this.rng.next() - 0.5) * 0.05;
    this.bloomRad = Math.min(0.06, this.bloomRad + spec.hipSpreadPerShotRad);
  }

  private updateRecoil(player: Player, dt: number): void {
    if (this.secondsSinceShot > RECOIL_RECOVERY_DELAY_SECONDS) {
      const k = this.state.spec.recoilRecoverRadS * player.recoilRecoveryMultiplier();
      // Recovery curve: fast when far off the original aim, easing in at the end.
      this.recoilPitchRad = approachZero(this.recoilPitchRad, (k + 7 * Math.abs(this.recoilPitchRad)) * dt);
      this.recoilYawRad = approachZero(this.recoilYawRad, (k * 0.6 + 7 * Math.abs(this.recoilYawRad)) * dt);
    }
    this.bloomRad = approachZero(this.bloomRad, 0.08 * dt);
    this.visualKickM *= Math.exp(-dt * 14);
    this.visualKickRollRad *= Math.exp(-dt * 10);
  }

  private updateSway(player: Player, dt: number): void {
    this.swayTimeSeconds += dt;
    const t = this.swayTimeSeconds;
    const amp = this.state.spec.swayRad * player.swayMultiplier();
    // Breathing Lissajous: ~0.25 Hz vertical, slower figure-eight horizontally.
    this.swayPitchRad = amp * (Math.sin(t * 1.6) * 0.8 + Math.sin(t * 0.7 + 1.3) * 0.3);
    this.swayYawRad = amp * (Math.sin(t * 0.8 + 0.4) * 0.7 + Math.sin(t * 1.9) * 0.2);
  }
}

const _origin = new Vec3();
const _dir = new Vec3();

function approachZero(v: number, step: number): number {
  if (v > 0) return Math.max(0, v - step);
  return Math.min(0, v + step);
}

function makeState(spec: WeaponSpec, spare: number): WeaponState {
  return {
    spec,
    magRounds: spec.magazineSize - 1,
    chambered: true,
    spareMags: new Array<number>(spare).fill(spec.magazineSize),
    autoMode: false,
    suppressed: false,
  };
}
