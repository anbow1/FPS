import { ktx2Loader } from './gltf';
import { type CastCharacter, castUrls, loadCast } from './mpfbCast';

// The infantry's men: Field Line's MPFB soldiers (field-line/src/assets/people, built by
// paris/tools/people/build_people_mpfb.py --cast fieldline), borrowed rather than copied. Only their far
// level is loaded: in this game a soldier is seen from a tank, tens to hundreds of metres off.
//
// Their atlases are Field Line's baked ones (field-line/src/assets/people/atlas/*_far.ktx2, made by
// tools/assets/bake_atlases.mjs): mpfbCast.ts is the same file in both games, so the far atlas is the same
// layout texel for texel. The piece textures are not in this build: an atlas that fails to load is drawn
// in each piece's plain colour instead (mpfbCast.ts), a soldier in flat cloth and skin rather than none.

const JSON_URLS = import.meta.glob<string>('../../../field-line/src/assets/people/*_far.json', { eager: true, query: '?url', import: 'default' });
const BIN_URLS = import.meta.glob<string>('../../../field-line/src/assets/people/*_far.bin', { eager: true, query: '?url', import: 'default' });
const ATLAS_URLS = import.meta.glob<string>('../../../field-line/src/assets/people/atlas/*_far.ktx2', { eager: true, query: '?url', import: 'default' });

/** After useRendererForModels() (gltf.ts): the atlases are KTX2. */
export function loadSoldierCast(): Promise<CastCharacter[]> {
  return loadCast(castUrls(JSON_URLS, BIN_URLS, {}, ATLAS_URLS), 'low', ktx2Loader());
}
