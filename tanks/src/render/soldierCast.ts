import { type CastCharacter, castUrls, loadCast } from './mpfbCast';

// The infantry's men: Field Line's MPFB soldiers (field-line/src/assets/people, built by
// paris/tools/people/build_people_mpfb.py --cast fieldline), borrowed rather than copied. Only their far
// level is loaded: in this game a soldier is seen from a tank, tens to hundreds of metres off.

const JSON_URLS = import.meta.glob<string>('../../../field-line/src/assets/people/*_far.json', { eager: true, query: '?url', import: 'default' });
const BIN_URLS = import.meta.glob<string>('../../../field-line/src/assets/people/*_far.bin', { eager: true, query: '?url', import: 'default' });
const TEX_URLS = import.meta.glob<string>('../../../field-line/src/assets/people/tex/*_{64,128,256}.*', { eager: true, query: '?url', import: 'default' });

export function loadSoldierCast(): Promise<CastCharacter[]> {
  return loadCast(castUrls(JSON_URLS, BIN_URLS, TEX_URLS), 'low');
}
