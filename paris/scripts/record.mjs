// Renders the ten seconds frame by frame in a headless browser and encodes them.
//
//   node scripts/record.mjs <url of the built page> <out dir> [width] [height] [ffmpeg] [supersample]
//
// The page runs in ?record mode: every frame is simulated and rendered in order
// (window.__paris.renderFrame) at `supersample` × the size and read back as a JPEG;
// ffmpeg (if given) scales the frames down (Lanczos), adds the film grain — here,
// not in the page, where it would be averaged away by the downscale and make every
// frame incompressible — and encodes H.264 at the clip's frame rate. Headless
// Chromium has no GPU here, so it renders through SwiftShader: slow, but exact.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const [url, outDir, w = '1920', h = '1080', ffmpeg = '', ss = '2'] = process.argv.slice(2);
if (!url || !outDir) throw new Error('usage: record.mjs <url> <outDir> [width] [height] [ffmpeg] [supersample]');
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`${url}?record&w=${w}&h=${h}&ss=${ss}&format=jpeg`);
await page.waitForFunction(() => window.__paris?.ready === true, null, { timeout: 0, polling: 500 });
const frames = await page.evaluate(() => window.__paris.frames);
const start = Date.now();
for (let i = 0; i < frames; i++) {
  const jpeg = await page.evaluate((k) => window.__paris.renderFrame(k), i);
  writeFileSync(join(outDir, `f${String(i).padStart(4, '0')}.jpg`), Buffer.from(jpeg.split(',')[1], 'base64'));
  const per = (Date.now() - start) / (i + 1) / 1000;
  console.log(`frame ${i + 1}/${frames}  ${per.toFixed(1)} s/frame  ~${Math.round(((frames - i - 1) * per) / 60)} min left`);
}
await browser.close();
if (ffmpeg) {
  const fps = 25;
  // Grain: temporal, luma only, about ±2 % — film-like at 1080p, and cheap for the encoder with -tune grain.
  const filter = `scale=${w}:${h}:flags=lanczos,noise=c0s=5:c0f=t+u`;
  execFileSync(ffmpeg, ['-y', '-framerate', String(fps), '-i', join(outDir, 'f%04d.jpg'), '-vf', filter, '-c:v', 'libx264', '-preset', 'slow', '-tune', 'grain', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(outDir, 'paris.mp4')], { stdio: 'inherit' });
}
