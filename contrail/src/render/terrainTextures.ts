import { DataTexture, FloatType, LinearFilter, LinearMipmapLinearFilter, NearestFilter, RedFormat, RGBAFormat, UnsignedByteType } from 'three/webgpu';
import { type LandCover, sourceCover, TERRAIN, type TerrainData } from '../sim/terrain.ts';

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

/** Normals and land cover for one grid. Yields to the browser between row blocks. */
async function bakeMaps(grid: Float32Array, res: number, sizeM: number): Promise<{ normal: Uint8Array; cover: Uint8Array }> {
  const normal = new Uint8Array(res * res * 4);
  const cover = new Uint8Array(res * res * 4);
  const cell = sizeM / res;
  const lc: LandCover = { forest: 0, rock: 0, snow: 0, water: 0, river: 0 };
  const h = (i: number, j: number): number => grid[Math.min(res - 1, Math.max(0, j)) * res + Math.min(res - 1, Math.max(0, i))]!;
  for (let j = 0; j < res; j++) {
    const z = -sizeM / 2 + (j + 0.5) * cell;
    for (let i = 0; i < res; i++) {
      const x = -sizeM / 2 + (i + 0.5) * cell;
      const dx = (h(i + 1, j) - h(i - 1, j)) / (2 * cell);
      const dz = (h(i, j + 1) - h(i, j - 1)) / (2 * cell);
      const inv = 1 / Math.hypot(dx, 1, dz);
      const k = (j * res + i) * 4;
      normal[k] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      normal[k + 1] = Math.round((inv * 0.5 + 0.5) * 255);
      normal[k + 2] = Math.round((-dz * inv * 0.5 + 0.5) * 255);
      normal[k + 3] = 255;
      const height = h(i, j);
      sourceCover(x, z, height, 1 - inv, lc);
      cover[k] = Math.round(lc.forest * 255);
      cover[k + 1] = Math.round(lc.rock * 255);
      cover[k + 2] = Math.round(lc.snow * 255);
      cover[k + 3] = Math.round(Math.max(lc.water, lc.river) * 255);
    }
    if (j % 48 === 47) await new Promise((r) => setTimeout(r, 0));
  }
  return { normal, cover };
}

export async function buildTerrainTextures(data: TerrainData): Promise<TerrainTextures> {
  const near = await bakeMaps(data.near, TERRAIN.nearRes, TERRAIN.nearSizeM);
  const far = await bakeMaps(data.far, TERRAIN.farRes, TERRAIN.farSizeM);
  return {
    nearHeight: heightTexture(data.near, TERRAIN.nearRes),
    farHeight: heightTexture(data.far, TERRAIN.farRes),
    nearNormal: rgbaTexture(near.normal, TERRAIN.nearRes),
    farNormal: rgbaTexture(far.normal, TERRAIN.farRes),
    nearCover: rgbaTexture(near.cover, TERRAIN.nearRes),
    farCover: rgbaTexture(far.cover, TERRAIN.farRes),
  };
}
