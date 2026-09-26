import type { GameIntent } from '../src/game/game.ts';

/** An intent with nothing pressed: the player stands still and does nothing. */
export function idleIntent(): GameIntent {
  return {
    player: { moveRight: 0, moveForward: 0, sprint: false, jump: false, crouchPressed: false, pronePressed: false, aiming: false, holdBreath: false },
    weapon: { fireHeld: false, firePressed: false, aimHeld: false, reloadPressed: false, fireModePressed: false, select: null, zoomPressed: false, suppressorPressed: false },
    lookYawRad: 0,
    lookPitchRad: 0,
    grenadeHeld: false,
    grenadePressed: false,
    grenadeReleased: false,
    grenadeCyclePressed: false,
    medKitPressed: false,
    ammoPackPressed: false,
    rangeFinderPressed: false,
  };
}

export const STEP_S = 1 / 60;
