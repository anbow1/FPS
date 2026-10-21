// Renders the ten seconds frame by frame in a headless browser and encodes them.
//
//   node scripts/record.mjs <url of the built page> <out dir> [width] [height] [ffmpeg]
//
// The page runs in ?record mode: every frame is simulated and rendered in order
// (window.__paris.renderFrame) and read back as a PNG; ffmpeg (if given) encodes
// them to H.264 at the clip's frame rate. Headless Chromium has no GPU here, so
// it renders through SwiftShader: slow, but every frame is exact.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const [url, outDir, w = '1920', h = '1080', ffmpeg = ''] = process.argv.slice(2);
if (!url || !outDir) throw new Error('usage: record.mjs <url> <outDir> [width] [height] [ffmpeg]');
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`${url}?record&w=${w}&h=${h}`);
await page.waitForFunction(() => window.__paris?.ready === true, null, { timeout: 0, polling: 500 });
const frames = await page.evaluate(() => window.__paris.frames);
const start = Date.now();
for (let i = 0; i < frames; i++) {
  const png = await page.evaluate((k) => window.__paris.renderFrame(k), i);
  writeFileSync(join(outDir, `f${String(i).padStart(4, '0')}.png`), Buffer.from(png.split(',')[1], 'base64'));
  const per = (Date.now() - start) / (i + 1) / 1000;
  console.log(`frame ${i + 1}/${frames}  ${per.toFixed(1)} s/frame  ~${Math.round(((frames - i - 1) * per) / 60)} min left`);
}
await browser.close();
if (ffmpeg) {
  const fps = 25;
  execFileSync(ffmpeg, ['-y', '-framerate', String(fps), '-i', join(outDir, 'f%04d.png'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(outDir, 'paris.mp4')], { stdio: 'inherit' });
}
