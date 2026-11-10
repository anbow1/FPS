import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { WebGPURenderer } from 'three/webgpu';
import { type CastCharacter, castUrls, loadCast } from './mpfbCast.ts';

// The band from MPFB (assets/people, built by paris/tools/people/build_people_mpfb.py --cast lagoon):
// every file's URL, for mpfbCast.ts to load. An empty folder leaves the procedural men.
// Baked atlases (assets/people/atlas/*.ktx2, tools/assets/bake_atlases.mjs) stand in for drawing them.

const JSON_URLS = import.meta.glob<string>('../assets/people/*.json', { eager: true, query: '?url', import: 'default' });
const BIN_URLS = import.meta.glob<string>('../assets/people/*.bin', { eager: true, query: '?url', import: 'default' });
const ATLAS_URLS = import.meta.glob<string>('../assets/people/atlas/*.ktx2', { eager: true, query: '?url', import: 'default' });
// The pieces' own textures go into the build only for baking (guerrillaTex.ts). A dynamic import behind a
// build-time constant: outside the bake mode the bundler drops the branch, and the textures with it. An atlas
// that is missing or fails to load is drawn in each piece's plain colour.
async function pieceTextures(): Promise<Record<string, string>> {
  return import.meta.env.MODE === 'bake' ? (await import('./guerrillaTex.ts')).TEX_URLS : {};
}

/** `renderer` must be initialised: the loader asks it which compressed formats the GPU takes. */
export function loadGuerrillaCast(quality: 'high' | 'low', renderer: WebGPURenderer): Promise<CastCharacter[]> {
  // No transcoder path: three's loader then points at its own copy of the Basis transcoder (new URL with
  // import.meta.url), which the bundler emits into the build, so the APK needs no network.
  const ktx2 = new KTX2Loader().detectSupport(renderer);
  return pieceTextures()
    .then((tex) => loadCast(castUrls(JSON_URLS, BIN_URLS, tex, ATLAS_URLS), quality, ktx2))
    .finally(() => ktx2.dispose());
}
