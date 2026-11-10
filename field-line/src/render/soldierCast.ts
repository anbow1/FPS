import { ktx2Loader } from './gltf.ts';
import { type CastCharacter, castUrls, loadCast } from './mpfbCast.ts';

// Field Line's soldiers from MPFB (assets/people, built by paris/tools/people/build_people_mpfb.py
// --cast fieldline): every file's URL, for mpfbCast.ts to load. An empty folder leaves the procedural men.
// Baked atlases (assets/people/atlas/*.ktx2, tools/assets/bake_atlases.mjs) stand in for drawing them.

const JSON_URLS = import.meta.glob<string>('../assets/people/*.json', { eager: true, query: '?url', import: 'default' });
const BIN_URLS = import.meta.glob<string>('../assets/people/*.bin', { eager: true, query: '?url', import: 'default' });
const ATLAS_URLS = import.meta.glob<string>('../assets/people/atlas/*.ktx2', { eager: true, query: '?url', import: 'default' });
// The pieces' own textures go into the build only for baking (`vite build --mode bake`, which
// tools/assets/bake_atlases.mjs opens): the game itself draws nothing, it loads the baked atlases (11 MB
// instead of these 10). An atlas that is missing or fails to load is drawn in each piece's plain colour.
// A dynamic import behind a build-time constant: outside the bake mode the bundler drops the branch, and the
// textures with it.
async function pieceTextures(): Promise<Record<string, string>> {
  return import.meta.env.MODE === 'bake' ? (await import('./soldierTex.ts')).TEX_URLS : {};
}

/** After useRendererForModels() (gltf.ts): the atlases are KTX2. */
export async function loadSoldierCast(quality: 'high' | 'low'): Promise<CastCharacter[]> {
  return loadCast(castUrls(JSON_URLS, BIN_URLS, await pieceTextures(), ATLAS_URLS), quality, ktx2Loader());
}
