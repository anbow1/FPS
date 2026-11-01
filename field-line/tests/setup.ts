import { initNavMesh } from '../src/game/navMesh.ts';

// The city maps' navigation mesh needs Recast's module loaded (game/navMesh.ts).
await initNavMesh();
