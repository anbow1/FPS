import { CAMERA } from '../config.ts';
import type { Input } from '../core/input.ts';
import type { Game, GameIntent } from '../game/game.ts';

// Rebindable actions → one GameIntent per fixed step. Mouse look is read every
// display frame and held as "pending" until the next step consumes it, so the
// camera turns at the display rate while the logic stays at 60 Hz.

export class Controls {
  pendingYawRad = 0;
  pendingPitchRad = 0;
  sensitivity = 1;
  private readonly mouse = { dx: 0, dy: 0 };

  constructor(private readonly input: Input) {}

  /** Once per display frame. Aimed sensitivity scales with the optic's magnification. */
  readMouse(game: Game): void {
    this.input.takeMouseDelta(this.mouse);
    const w = game.weapons;
    const mag = w.current === 'sniper' ? w.scopeMagnification : w.current === 'rifle' ? 1.25 : 1.1;
    const k = CAMERA.mouseRadPerPixel * this.sensitivity / (1 + (mag - 1) * w.adsBlend);
    this.pendingYawRad += this.mouse.dx * k;
    this.pendingPitchRad += this.mouse.dy * k;
  }

  /** Once per fixed step. Edges (pressed/released) live for exactly one step. */
  buildIntent(): GameIntent {
    const i = this.input;
    const intent: GameIntent = {
      player: {
        moveRight: (i.held('right') ? 1 : 0) - (i.held('left') ? 1 : 0),
        moveForward: (i.held('forward') ? 1 : 0) - (i.held('back') ? 1 : 0),
        sprint: i.held('sprint'),
        jump: i.pressed('jump'),
        crouchPressed: i.pressed('crouch'),
        pronePressed: i.pressed('prone'),
        aiming: i.held('aim'),
        holdBreath: i.held('holdBreath'),
      },
      weapon: {
        fireHeld: i.held('fire'),
        firePressed: i.pressed('fire'),
        aimHeld: i.held('aim'),
        reloadPressed: i.pressed('reload'),
        fireModePressed: i.pressed('fireMode'),
        select: i.pressed('weapon1') ? 'rifle' : i.pressed('weapon2') ? 'sniper' : i.pressed('weapon3') ? 'pistol' : null,
        zoomPressed: i.pressed('zoom'),
        suppressorPressed: i.pressed('suppressor'),
      },
      lookYawRad: this.pendingYawRad,
      lookPitchRad: this.pendingPitchRad,
      grenadeHeld: i.held('grenade'),
      grenadePressed: i.pressed('grenade'),
      grenadeReleased: i.released('grenade'),
      grenadeCyclePressed: i.pressed('grenadeCycle'),
      medKitPressed: i.pressed('medKit'),
      ammoPackPressed: i.pressed('ammoPack'),
      rangeFinderPressed: i.pressed('rangeFinder'),
      weaponLightPressed: i.pressed('weaponLight'),
    };
    this.pendingYawRad = 0;
    this.pendingPitchRad = 0;
    return intent;
  }
}
