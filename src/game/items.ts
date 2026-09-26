import { GRENADES, HEALTH } from '../config.ts';
import type { Rng } from '../core/rng.ts';
import { Vec3 } from '../core/vec.ts';
import type { EventQueue } from './events.ts';
import type { Player } from './player.ts';
import type { WeaponSystem } from './weapons.ts';

// Med kits, ammo packs and pickups (found at fixed map points or dropped by dead AI).

export interface PickupState {
  kind: 'medKit' | 'ammoPack' | 'grenade';
  pos: Vec3;
  taken: boolean;
  dropped: boolean;
}

const PICKUP_RADIUS_M = 1.4;

export class Items {
  readonly pickups: PickupState[] = [];

  addPickup(kind: PickupState['kind'], pos: Vec3, dropped: boolean): void {
    this.pickups.push({ kind, pos: pos.clone(), taken: false, dropped });
  }

  /** Dead AI drop kit: ammo is common, med kits less so. */
  dropFromSoldier(pos: Vec3, rng: Rng): void {
    const roll = rng.next();
    if (roll < 0.5) this.addPickup('ammoPack', pos.clone().add(new Vec3(0.4, 0, 0.2)), true);
    else if (roll < 0.8) this.addPickup('medKit', pos.clone().add(new Vec3(-0.3, 0, 0.3)), true);
    else this.addPickup('grenade', pos.clone().add(new Vec3(0.2, 0, -0.4)), true);
  }

  startMedKit(player: Player, weapons: WeaponSystem, events: EventQueue): void {
    if (player.itemInUse || player.medKits <= 0 || !weapons.isReady()) return;
    if (player.permanentHp >= HEALTH.permanentMax && !player.bleeding) return;
    player.itemInUse = { kind: 'medKit', secondsLeft: HEALTH.medKitSeconds };
    weapons.adsBlend = 0;
    events.push({ type: 'itemStart', item: 'medKit' });
  }

  startAmmoPack(player: Player, weapons: WeaponSystem, events: EventQueue): void {
    if (player.itemInUse || player.ammoPacks <= 0 || !weapons.isReady()) return;
    player.itemInUse = { kind: 'ammoPack', secondsLeft: HEALTH.ammoPackSeconds };
    weapons.adsBlend = 0;
    events.push({ type: 'itemStart', item: 'ammoPack' });
  }

  update(player: Player, weapons: WeaponSystem, events: EventQueue, dt: number): void {
    const use = player.itemInUse;
    if (use && player.alive) {
      use.secondsLeft -= dt;
      if (use.secondsLeft <= 0) {
        if (use.kind === 'medKit') {
          player.medKits--;
          player.heal();
        } else {
          player.ammoPacks--;
          weapons.refillPrimaries();
        }
        events.push({ type: 'itemDone', item: use.kind });
        player.itemInUse = null;
      }
    }
    for (const p of this.pickups) {
      if (p.taken || !player.alive) continue;
      if (p.pos.distanceToXZ(player.body.position) > PICKUP_RADIUS_M || Math.abs(p.pos.y - player.body.position.y) > 1.5) continue;
      if (p.kind === 'medKit' && player.medKits < HEALTH.medKitCarriedMax) player.medKits++;
      else if (p.kind === 'ammoPack' && player.ammoPacks < HEALTH.ammoPackCarriedMax) player.ammoPacks++;
      else if (p.kind === 'ammoPack') weapons.addLooseMagazines(2);
      else if (p.kind === 'grenade' && player.grenades.frag < GRENADES.startCount.frag + 2) player.grenades.frag++;
      else continue;
      p.taken = true;
      events.push({ type: 'pickup', item: p.kind });
    }
  }
}
