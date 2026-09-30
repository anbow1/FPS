// Render benchmark in a headless browser (docs/graphics-playbook.md §9).
// Opens the built game with ?bench, which tours the map's fixed spots
// (src/app/bench.ts) and leaves one row per spot; saves the rows as JSON and,
// given a saved run to compare with, prints the change per spot.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/benchView.mjs --map forest --q high --save before
//   ...change...
//   node scripts/benchView.mjs --map forest --q high --save after --compare before
//
// Draw calls and triangles are exact anywhere. Frame times from a software
// renderer (SwiftShader) only compare runs on the same machine; real numbers
// come from the in-game Benchmark button on the phone.
// Needs Playwright: `npm i -D playwright` or PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const NO_PRESENT = `(() => {
  if (typeof GPUCanvasContext === 'undefined') return;
  const cfg = new WeakMap();
  const P = GPUCanvasContext.prototype;
  P.configure = function (c) { cfg.set(this, { c, tex: null }); };
  P.unconfigure = function () { cfg.delete(this); };
  P.getConfiguration = function () { return cfg.get(this)?.c ?? null; };
  P.getCurrentTexture = function () {
    const s = cfg.get(this);
    const w = this.canvas.width, h = this.canvas.height;
    if (!s.tex || s.tex.width !== w || s.tex.height !== h) {
      s.tex?.destroy();
      s.tex = s.c.device.createTexture({ size: [w, h], format: s.c.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING });
    }
    return s.tex;
  };
})();`;

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []),
);
const url = args.url ?? 'http://localhost:4173/';
const map = args.map ?? 'forest';
const quality = args.q ?? 'high';
const gpu = args.gpu ?? 'webgl';
const frames = args.frames ?? '4';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const flags =
  gpu === 'webgpu'
    ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ args: flags, executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
// --no-present: some headless Chrome builds lose the WebGPU device as soon as a canvas context
// is configured. Render into an ordinary texture instead: nothing shows, every shader still compiles.
if (args['no-present']) await page.addInitScript(NO_PRESENT);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 300));
});
const query = `?autostart&debug&bench&benchWarm=2&benchFrames=${frames}&map=${map}&q=${quality}`;
await page.goto(url + query);
await page.waitForFunction(() => Array.isArray(window.__bench), null, { timeout: 3_600_000, polling: 1000 });
const rows = await page.evaluate(() => window.__bench);
const backend = await page.evaluate(() => window.__fps?.stats.backend ?? '');
await browser.close();

const run = { map, quality, gpu, backend, date: new Date().toISOString(), rows };
console.log(`${map} · ${quality} · ${backend}`);
console.table(rows.map((r) => ({ spot: r.spot, calls: r.drawCalls, Mtris: +(r.triangles / 1e6).toFixed(2), cpuMs: r.cpuMs, gpuMs: r.gpuMs ?? 'n/a', p95Ms: r.p95Ms })));
if (errors.length) console.log('console errors:', errors.slice(0, 5));

const file = (name) => `bench/${name}-${map}-${quality}-${gpu}.json`;
if (args.save) {
  mkdirSync('bench', { recursive: true });
  writeFileSync(file(args.save), JSON.stringify(run, null, 2));
  console.log('saved', file(args.save));
}
if (args.compare) {
  const base = JSON.parse(readFileSync(file(args.compare), 'utf8'));
  const pct = (a, b) => (b === 0 ? '' : `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)} %`);
  console.table(
    rows.map((r) => {
      const b = base.rows.find((x) => x.spot === r.spot);
      if (!b) return { spot: r.spot, note: 'new spot' };
      return { spot: r.spot, calls: `${b.drawCalls} → ${r.drawCalls}`, tris: pct(r.triangles, b.triangles), cpu: pct(r.cpuMs, b.cpuMs), gpu: r.gpuMs !== null && b.gpuMs !== null ? pct(r.gpuMs, b.gpuMs) : 'n/a' };
    }),
  );
}
