import { DataTexture, FloatType, LinearFilter, LinearMipmapLinearFilter, NearestFilter, RedFormat, RGBAFormat, UnsignedByteType } from 'three/webgpu';
import { bakeMapsParallel, TERRAIN, type TerrainData } from '../sim/terrain.ts';

// GPU copies of the baked terrain (sim/terrain.ts): the height grids as R32F
// (read with four textureLoads and a manual bilinear, exactly like the CPU, so
// the mesh and the collision agree — and because float32 is not filterable on
// every GPU), plus filterable RGBA8 maps baked from them: the surface normal
// and the land cover (forest, rock, snow, water/river).

export interface TerrainTextures {
  nearHeight: DataTexture;
  farHeight: DataTexture;
  nearNormal: DataTexture;
  farNormal: DataTexture;
  nearCover: DataTexture;
  farCover: DataTexture;
}

function heightTexture(grid: Float32Array, res: number): DataTexture {
  const t = new DataTexture(grid, res, res, RedFormat, FloatType);
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function rgbaTexture(data: Uint8Array, res: number): DataTexture {
  const t = new DataTexture(data, res, res, RGBAFormat, UnsignedByteType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export async function buildTerrainTextures(data: TerrainData): Promise<TerrainTextures> {
  // On worker threads, a band of rows each (the per-texel work is the land-cover noise).
  const [near, far] = await Promise.all([bakeMapsParallel(data.near, TERRAIN.nearRes, TERRAIN.nearSizeM), bakeMapsParallel(data.far, TERRAIN.farRes, TERRAIN.farSizeM)]);
  broadCurvature(near.normal, data.near, TERRAIN.nearRes, TERRAIN.nearSizeM / TERRAIN.nearRes);
  return {
    nearHeight: heightTexture(data.near, TERRAIN.nearRes),
    farHeight: heightTexture(data.far, TERRAIN.farRes),
    nearNormal: rgbaTexture(near.normal, TERRAIN.nearRes),
    farNormal: rgbaTexture(far.normal, TERRAIN.farRes),
    nearCover: rgbaTexture(near.cover, TERRAIN.nearRes),
    farCover: rgbaTexture(far.cover, TERRAIN.farRes),
  };
}

/** Stencil reach (cells) and gain of the near grid's curvature: a 40 m Laplacian, the scale of the gullies seen from the air. */
const CURVE_STEP = 4;
/** tanh gain: the battlefield's 10th / 90th percentiles land near ∓0.55 (measured over a 6 km square). */
const CURVE_GAIN = 45;

/**
 * Replaces the near normal map's alpha (the bake's 10 m curvature, which mostly saw the knolls) with
 * curvature over ±40 m: the gullies, hollows and spurs an aerial photo shows (render/landCover.ts).
 * One pass over the grid on the main thread, ~4 M texels × 5 reads.
 */
function broadCurvature(normal: Uint8Array, grid: Float32Array, res: number, cellM: number): void {
  const s = CURVE_STEP;
  const d2 = (s * cellM) ** 2;
  for (let j = 0; j < res; j++) {
    const jm = Math.max(0, j - s) * res;
    const jp = Math.min(res - 1, j + s) * res;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const h = grid[row + i]!;
      const lap = (grid[row + Math.max(0, i - s)]! + grid[row + Math.min(res - 1, i + s)]! + grid[jm + i]! + grid[jp + i]! - 4 * h) / d2;
      normal[(row + i) * 4 + 3] = Math.round((Math.tanh(lap * CURVE_GAIN) * 0.5 + 0.5) * 255);
    }
  }
}
