import { bakeMapRows, sourceHeight } from './terrain.ts';

// Slices of the terrain bake, off the main thread (terrain.ts runs several of
// these at once, so loading takes a fraction of the time it would on one core):
//   heights  rows j0…j1 of a res × res grid covering sizeM, from the source function;
//   maps     normal and land-cover texels for rows j0…j1, from the band of the grid sent along.

type Job =
  | { kind: 'heights'; res: number; sizeM: number; detail: number; j0: number; j1: number }
  | { kind: 'maps'; res: number; sizeM: number; j0: number; j1: number; row0: number; grid: Float32Array };

self.onmessage = (e: MessageEvent<Job>): void => {
  const job = e.data;
  const post = (self as unknown as Worker).postMessage.bind(self);
  if (job.kind === 'maps') {
    const m = bakeMapRows(job.grid, job.row0, job.res, job.sizeM, job.j0, job.j1);
    post(m, [m.normal.buffer, m.cover.buffer]);
    return;
  }
  const { res, sizeM, detail, j0, j1 } = job;
  const out = new Float32Array((j1 - j0) * res);
  const cell = sizeM / res;
  for (let j = j0; j < j1; j++) {
    const z = -sizeM / 2 + (j + 0.5) * cell;
    for (let i = 0; i < res; i++) out[(j - j0) * res + i] = sourceHeight(-sizeM / 2 + (i + 0.5) * cell, z, detail);
  }
  post(out, [out.buffer]);
};
