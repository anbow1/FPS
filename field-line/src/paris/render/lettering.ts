import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three/webgpu';

// Shop names for the fascias, drawn once into a canvas atlas: one row per
// name, in a serif face's capitals as a sign-writer gilds them on Paris
// shopfronts. Only trades, no names of real businesses. Rows 0…CAFE_ROWS−1 are
// for cafés, the rest for shops; the shader picks a row by the shop's seed.

const CAFES = ['CAFÉ', 'BRASSERIE', 'BISTROT', 'CAFÉ · TABAC'];
const SHOPS = [
  'BOULANGERIE',
  'PHARMACIE',
  'LIBRAIRIE',
  'FLEURISTE',
  'FROMAGERIE',
  'PÂTISSERIE',
  'OPTICIEN',
  'PAPETERIE',
  'CAVISTE',
  'HORLOGERIE',
  'CHAPELLERIE',
  'ÉPICERIE FINE',
];

export const CAFE_ROWS = CAFES.length;
export const LETTERING_ROWS = CAFES.length + SHOPS.length;
/**
 * A row's width over its height, about a fascia's text band (3–4.5 m by 0.54 m): the band spans the whole
 * row, so a shop narrower or wider than that squeezes or widens its letters a little, as a sign-writer
 * would, and a long name is drawn condensed to fit.
 */
export const LETTERING_ASPECT = 6.5;

let atlas: CanvasTexture | null = null;

/** The atlas: white letters on transparent (alpha = ink), LETTERING_ROWS rows of LETTERING_ASPECT : 1. */
export function letteringTexture(): CanvasTexture {
  if (atlas) return atlas;
  const rowH = 128;
  const canvas = document.createElement('canvas');
  canvas.width = rowH * LETTERING_ASPECT;
  canvas.height = rowH * LETTERING_ROWS;
  // In memory, not on the GPU: drawn once, then copied into a WebGPU texture, and a GPU canvas's copy reads it back across contexts (seconds on software GPUs).
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas unavailable for the shop lettering');
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  [...CAFES, ...SHOPS].forEach((name, i) => {
    // Capitals 60 % of the band, letter-spaced a little as painted signs are.
    ctx.font = `600 ${Math.round(rowH * 0.62)}px "Didot", "Bodoni MT", "Georgia", "Times New Roman", serif`;
    ctx.letterSpacing = `${Math.round(rowH * 0.06)}px`;
    ctx.fillText(name, canvas.width / 2, rowH * (i + 0.54), canvas.width * 0.9);
  });
  atlas = new CanvasTexture(canvas);
  atlas.colorSpace = SRGBColorSpace;
  atlas.minFilter = LinearMipmapLinearFilter;
  atlas.magFilter = LinearFilter;
  atlas.anisotropy = 8;
  atlas.flipY = false;
  return atlas;
}
