import { type CastCharacter, castUrls, loadCast } from './mpfbCast.ts';

// Field Line's soldiers from MPFB (assets/people, built by paris/tools/people/build_people_mpfb.py
// --cast fieldline): every file's URL, for mpfbCast.ts to load. An empty folder leaves the procedural men.

const JSON_URLS = import.meta.glob<string>('../assets/people/*.json', { eager: true, query: '?url', import: 'default' });
const BIN_URLS = import.meta.glob<string>('../assets/people/*.bin', { eager: true, query: '?url', import: 'default' });
const TEX_URLS = import.meta.glob<string>('../assets/people/tex/*', { eager: true, query: '?url', import: 'default' });

export function loadSoldierCast(quality: 'high' | 'low'): Promise<CastCharacter[]> {
  return loadCast(castUrls(JSON_URLS, BIN_URLS, TEX_URLS), quality);
}
