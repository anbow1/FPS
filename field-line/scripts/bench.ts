import { initNavMesh } from '../src/game/navMesh.ts';
import { PHYSICS } from '../src/config.ts';
import type { GameIntent } from '../src/game/game.ts';
import { Game } from '../src/game/game.ts';
import { buildMap } from '../src/maps/index.ts';
import type { MapId } from '../src/maps/types.ts';

// CPU cost of one 60 Hz logic step (physics + AI + bullets + grenades), against
// the budget sheet's CPU lines: physics 2.0 ms + AI and game logic 2.5 ms.
// Run: npx tsx scripts/bench.ts   (or: npm run bench)

const BUDGET_MS = 2.0 + 2.5;

function idle(): GameIntent {
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
    weaponLightPressed: false,
  };
}

await initNavMesh();
for (const id of ['city', 'boulevard', 'forest'] as MapId[]) {
  const t0 = performance.now();
  const game = new Game(buildMap(id), 'skirmish', 99);
  const buildMs = performance.now() - t0;
  // Put the player where squads will see and engage, and keep them alive.
  const s0 = game.soldiers[0];
  if (s0) game.player.body.position.set(s0.body.position.x + 5, s0.body.position.y, s0.body.position.z + 25);
  game.player.bufferHp = 1e9;
  const times: number[] = [];
  let worstStep = 0;
  let worstMs = 0;
  for (let i = 0; i < 60 * 30; i++) {
    const intent = idle();
    intent.weapon.fireHeld = intent.weapon.firePressed = i % 30 === 0;
    const a = performance.now();
    game.step(intent, PHYSICS.stepSeconds);
    const ms = performance.now() - a;
    // The first second is JIT warm-up and the squads' first path requests: reported, not averaged.
    if (i >= 60) times.push(ms);
    if (ms > worstMs) {
      worstMs = ms;
      worstStep = i;
    }
    game.events.drain();
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((s, v) => s + v, 0) / times.length;
  const p99 = times[Math.floor(times.length * 0.99)] ?? 0;
  const engaged = game.soldiers.filter((s) => s.state === 'engage' || s.state === 'flank').length;
  console.log(`${id}: map+world build ${buildMs.toFixed(0)} ms · step mean ${mean.toFixed(3)} ms · p99 ${p99.toFixed(3)} ms · max after warm-up ${(times[times.length - 1] ?? 0).toFixed(2)} ms (worst overall ${worstMs.toFixed(1)} ms at step ${worstStep}) · budget ${BUDGET_MS} ms · ${engaged}/${game.soldiers.length} AI engaged`);
}
