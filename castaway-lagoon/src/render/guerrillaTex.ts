// The band's piece textures, for baking only: guerrillaCast.ts imports this module in the bake mode build
// (`vite build --mode bake`, opened by tools/assets/bake_atlases.mjs) and nowhere else, so the game's own
// build leaves the files out and loads the baked atlases instead.
export const TEX_URLS = import.meta.glob<string>('../assets/people/tex/*', { eager: true, query: '?url', import: 'default' });
