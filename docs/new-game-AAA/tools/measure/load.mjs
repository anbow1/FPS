// Where a game's loading time goes: what the game logs per stage, how many pipelines and shader
// modules each stage built, and which texture uploads were slow.
//
//   node tools/measure/serve.mjs castaway-lagoon/dist 4173 &
//   node tools/measure/load.mjs --game castaway-lagoon [--extra '&q=low'] [--json load.json]
//
// The game prints `[load] <stage>: <seconds>` lines (see field-line/src/main.ts); the builds between two
// such lines are counted under the later one. "gpu idle" is when the GPU has finished everything that
// was queued while loading (GPUQueue.onSubmittedWorkDone): pipelines compile on the GPU's side, so the
// game can say it is ready long before the picture stops stalling. That number, not "ready", is the
// loading time a player feels.
//
// WebGPU only (the counters wrap the WebGPU API). A software GPU is 5–20× slower than a phone at
// compiling: compare runs on one machine, and read the counts (pipelines, modules, uploads) as exact.
import { writeFileSync } from 'node:fs';
import { gameOf, launch, openGame, parseArgs } from './lib.mjs';

const args = parseArgs();
const game = gameOf(args.game ?? 'generic');
const { browser, page, errors } = await launch('webgpu');

await page.addInitScript(() => {
  const ev = (window.__ev = []);
  const wrap = (proto, name) => {
    const f = proto[name];
    proto[name] = function (...a) {
      const t0 = performance.now();
      const r = f.apply(this, a);
      if (r && typeof r.then === 'function') r.then(() => ev.push({ k: name, t: t0, d: performance.now() - t0 }));
      else ev.push({ k: name, t: t0, d: performance.now() - t0 });
      return r;
    };
  };
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...a) {
    const d = await requestDevice.apply(this, a);
    window.__dev = d;
    return d;
  };
  wrap(GPUDevice.prototype, 'createRenderPipeline');
  wrap(GPUDevice.prototype, 'createRenderPipelineAsync');
  wrap(GPUDevice.prototype, 'createComputePipeline');
  wrap(GPUDevice.prototype, 'createShaderModule');
  // Uploads of images and canvases: a GPU-backed 2D canvas is read back across contexts (see the playbook).
  const copy = GPUQueue.prototype.copyExternalImageToTexture;
  window.__uploads = [];
  GPUQueue.prototype.copyExternalImageToTexture = function (src, dst, size) {
    const t0 = performance.now();
    const r = copy.call(this, src, dst, size);
    const s = src.source;
    window.__uploads.push({ kind: s.constructor.name, w: s.width, h: s.height, ms: performance.now() - t0 });
    return r;
  };
  const log = console.log;
  console.log = (...a) => {
    if (typeof a[0] === 'string' && a[0].startsWith('[load]')) ev.push({ k: 'LOAD ' + a[0].slice(7), t: performance.now(), d: 0 });
    log(...a);
  };
});

const readyS = await openGame(page, args.url ?? 'http://localhost:4173/', game, args.extra ?? '');
const t0 = Date.now();
await page.evaluate(() => window.__dev?.queue.onSubmittedWorkDone());
const idleS = readyS + (Date.now() - t0) / 1000;
const { ev, uploads } = await page.evaluate(() => ({ ev: window.__ev, uploads: window.__uploads }));

ev.sort((a, b) => a.t - b.t);
const stages = [];
let acc = {};
const close = (name) => {
  stages.push({ stage: name, ...acc });
  acc = {};
};
for (const e of ev) {
  if (e.k.startsWith('LOAD ')) close(e.k.slice(5));
  else {
    const a = (acc[e.k] ??= { n: 0, s: 0 });
    a.n++;
    a.s += e.d / 1000;
  }
}
close('(after the last stage)');

const short = { createRenderPipeline: 'pipelines', createRenderPipelineAsync: 'pipelines (async)', createComputePipeline: 'compute', createShaderModule: 'modules' };
console.log('\nstage — builds');
for (const s of stages) {
  const parts = Object.entries(s).filter(([k]) => k !== 'stage').map(([k, v]) => `${v.n} ${short[k]} ${v.s.toFixed(2)} s`);
  console.log(`  ${s.stage}${parts.length ? ' — ' + parts.join(', ') : ''}`);
}
const total = (k) => ev.filter((e) => e.k === k).length;
console.log(`\npipelines ${total('createRenderPipeline') + total('createRenderPipelineAsync')}, shader modules ${total('createShaderModule')}`);

const by = new Map();
for (const u of uploads) {
  const k = `${u.kind} ${u.w}×${u.h}`;
  const e = by.get(k) ?? { n: 0, ms: 0 };
  e.n++;
  e.ms += u.ms;
  by.set(k, e);
}
const slow = [...by.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8);
console.log(`\nimage uploads ${uploads.length}, ${(uploads.reduce((s, u) => s + u.ms, 0) / 1000).toFixed(2)} s; slowest kinds:`);
for (const [k, e] of slow) console.log(`  ${e.n} × ${k}: ${(e.ms / 1000).toFixed(2)} s`);

console.log(`\nready after ${readyS.toFixed(1)} s, gpu idle after ${idleS.toFixed(1)} s`);
if (args.json) writeFileSync(args.json, JSON.stringify({ readyS, idleS, stages, uploads: Object.fromEntries(by) }, null, 1));
for (const e of errors) console.log('ERROR', e);
await browser.close();
