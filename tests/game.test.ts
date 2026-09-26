import { describe, expect, it } from 'vitest';
import { GRENADES, ROUND_556, ROUND_MAGNUM } from '../src/config.ts';
import { Vec3 } from '../src/core/vec.ts';
import { solveRange } from '../src/game/ballistics.ts';
import { Game } from '../src/game/game.ts';
import { buildMap } from '../src/maps/index.ts';
import { idleIntent, STEP_S } from './helpers.ts';

// End-to-end checks of the acceptance list, run headless on the real maps.

/** Points the player's line of sight at a world point, plus a holdover in mil. */
function aimAt(game: Game, target: Vec3, holdMil: number): void {
  const eye = game.player.eyePosition(new Vec3());
  const dx = target.x - eye.x;
  const dz = target.z - eye.z;
  game.player.yawRad = Math.atan2(-dx, -dz);
  game.player.pitchRad = Math.atan2(target.y - eye.y, Math.hypot(dx, dz)) + holdMil / 1000;
}

function runSeconds(game: Game, seconds: number, configure: (i: ReturnType<typeof idleIntent>, t: number) => void = () => {}): void {
  const steps = Math.round(seconds / STEP_S);
  for (let s = 0; s < steps; s++) {
    const intent = idleIntent();
    configure(intent, s * STEP_S);
    game.step(intent, STEP_S);
  }
}

/** Aims with hold-breath, fires one shot, waits for the round to land. Returns range hits added. */
function shootPlate(game: Game, distanceM: number, holdMil: number, windHoldMil: number): number {
  const plate = game.map.rangeTargets.find((t) => t.distanceM === distanceM);
  if (!plate) throw new Error(`no plate at ${distanceM} m`);
  const before = game.mode.rangeHits;
  game.player.stance = 'prone';
  const aim = (): void => {
    aimAt(game, plate.pos, holdMil);
    game.player.yawRad += windHoldMil / 1000;
  };
  runSeconds(game, 1.0, (i) => {
    aim();
    i.weapon.aimHeld = true;
    i.player.aiming = true;
    i.player.holdBreath = true;
  });
  runSeconds(game, 2.5, (i, t) => {
    if (t < 0.05) aim();
    i.weapon.aimHeld = true;
    i.player.aiming = true;
    i.player.holdBreath = true;
    i.weapon.firePressed = t < STEP_S;
    i.weapon.fireHeld = t < STEP_S;
  });
  return game.mode.rangeHits - before;
}

/** Wind drift in mil for a full-value crosswind, from the lag rule: drift = wind · (tof − range / v0). */
function windHoldMil(game: Game, round: typeof ROUND_556, rangeM: number): number {
  const s = solveRange(round, rangeM);
  const lag = s.timeOfFlightSeconds - rangeM / round.muzzleVelocityMs;
  // The range wind blows along +X; the round drifts +X, so hold into it (yaw +, which turns left toward -X).
  return ((game.wind.x * lag) / rangeM) * 1000;
}

describe('range acceptance', () => {
  it('the carbine zeroed at 300 m hits the 300 m plate with no holdover', () => {
    const game = new Game(buildMap('range'), 'range', 7);
    let hits = 0;
    for (let i = 0; i < 3; i++) hits += shootPlate(game, 300, 0, windHoldMil(game, ROUND_556, 300));
    expect(hits).toBeGreaterThanOrEqual(2);
  });

  it('the sniper rifle hits the 600 m plate using the holdover from the ballistics sheet', () => {
    const game = new Game(buildMap('range'), 'range', 11);
    runSeconds(game, 1.2, (i, t) => {
      i.weapon.select = t < STEP_S ? 'sniper' : null;
    });
    expect(game.weapons.current).toBe('sniper');
    const hold = solveRange(ROUND_MAGNUM, 600).holdoverMil;
    expect(hold).toBeGreaterThan(2.5); // between the sheet's 1.7 (500 m) and 5.0 (800 m)
    expect(hold).toBeLessThan(3.6);
    let hits = 0;
    for (let i = 0; i < 3; i++) {
      hits += shootPlate(game, 600, hold, windHoldMil(game, ROUND_MAGNUM, 600));
      runSeconds(game, 1.5); // bolt cycle
    }
    expect(hits).toBeGreaterThanOrEqual(2);
  });
});

describe('AI acceptance', () => {
  it('smoke between an AI and the player blocks its sight', () => {
    const clear = new Game(buildMap('range'), 'range', 3);
    const squadClear = clear.spawnSquad(new Vec3(0, 0, -40), []);
    const watcher = squadClear.members[0];
    if (!watcher) throw new Error('squad spawned empty');
    runSeconds(clear, 2, () => {
      for (const m of squadClear.members) m.yawRad = 0 + Math.PI; // face +Z, toward the firing line
    });
    expect(squadClear.members.some((m) => m.seesPlayer)).toBe(true);

    const smoked = new Game(buildMap('range'), 'range', 3);
    const cloud = smoked.grenades.smokes[0];
    if (!cloud) throw new Error('no smoke slot');
    cloud.active = true;
    cloud.pos.set(0, 0, -20);
    cloud.ageSeconds = GRENADES.smokeGrowSeconds;
    cloud.radiusM = GRENADES.smokeMaxRadiusM;
    const squadSmoked = smoked.spawnSquad(new Vec3(0, 0, -40), []);
    runSeconds(smoked, 2, () => {
      for (const m of squadSmoked.members) m.yawRad = Math.PI;
    });
    expect(squadSmoked.members.some((m) => m.seesPlayer)).toBe(false);
  });

  it('an enemy squad flanks a stationary player within 15 s', () => {
    const game = new Game(buildMap('city'), 'skirmish', 21);
    // Stand in the courtyard in view of the courtyard squad; soak damage so the test is about the AI.
    game.player.body.position.set(0, 0.15, 26);
    game.player.bufferHp = 1e6;
    let flankAt = -1;
    runSeconds(game, 15, (_i, t) => {
      if (flankAt < 0 && game.soldiers.some((s) => s.state === 'flank')) flankAt = t;
    });
    expect(flankAt).toBeGreaterThanOrEqual(0);
    expect(flankAt).toBeLessThan(15);
  });
});
