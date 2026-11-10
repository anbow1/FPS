// The cast's own piece textures (assets/people/tex): only the bake build imports this module
// (soldierCast.ts), so the game's build carries the baked atlases instead.
export const TEX_URLS = import.meta.glob<string>('../assets/people/tex/*', { eager: true, query: '?url', import: 'default' });
