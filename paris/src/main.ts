import { Node } from 'three/webgpu';
import { SHOT } from './config.ts';
import { Film } from './film.ts';

// Entry: the boulevard in real time (looping the ten seconds), a still at
// `?t=seconds`, or `?record` for the recorder (scripts/record.mjs), which
// renders frame after frame at the clip's frame rate through window.__paris.

const params = new URLSearchParams(location.search);
// `?debug`: TSL errors carry the stack of the node that failed.
if (params.has('debug')) (Node as unknown as { captureStackTrace: boolean }).captureStackTrace = true;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const status = document.getElementById('status') as HTMLDivElement;

async function start(): Promise<void> {
  const record = params.has('record');
  const width = Number(params.get('w') ?? 0) || canvas.clientWidth;
  const height = Number(params.get('h') ?? 0) || canvas.clientHeight;
  const film = new Film(canvas, Number(params.get('shutter') ?? (record ? 0.5 : 0.35)));
  const offline = record || params.has('t');
  // `ss`: supersampling for offline frames — rendered at ss × the size, scaled down by the recorder (ffmpeg,
  // Lanczos), which smooths the thin things TAA alone leaves stepped: railings, twigs, wires, road lines.
  const supersample = Math.max(1, Number(params.get('ss') ?? 1));
  if (record && params.get('format') === 'jpeg') film.frameFormat = 'image/jpeg';
  await film.init(offline ? width : canvas.clientWidth, offline ? height : canvas.clientHeight, offline ? supersample : Math.min(window.devicePixelRatio, 2));
  status.textContent = '';
  const still = params.get('t');
  if (record || still !== null) {
    const api = {
      frames: Math.round(SHOT.durationS * SHOT.fps),
      /** Renders frame `i` (frames must come in order: the street is simulated forward). */
      renderFrame: async (i: number): Promise<string> => film.renderFrame(i),
      /** Renders the clip's moment `t` for a still (simulating from the start). */
      renderAt: async (t: number): Promise<string> => film.renderAt(t),
      /** The still rendered for `?t`, as a PNG data URL. */
      still: '',
      info: () => film.info(),
      ready: false,
    };
    (window as unknown as { __paris: typeof api }).__paris = api;
    if (still !== null) api.still = await film.renderAt(Number(still));
    api.ready = true;
    return;
  }
  window.addEventListener('resize', () => film.resize(canvas.clientWidth, canvas.clientHeight, Math.min(window.devicePixelRatio, 2)));
  film.play();
}

start().catch((e: unknown) => {
  status.textContent = `Failed to start: ${e instanceof Error ? e.message : String(e)}`;
  throw e;
});
