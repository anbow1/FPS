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
  return {
    nearHeight: heightTexture(data.near, TERRAIN.nearRes),
    farHeight: heightTexture(data.far, TERRAIN.farRes),
    nearNormal: rgbaTexture(near.normal, TERRAIN.nearRes),
    farNormal: rgbaTexture(far.normal, TERRAIN.farRes),
    nearCover: rgbaTexture(near.cover, TERRAIN.nearRes),
    farCover: rgbaTexture(far.cover, TERRAIN.farRes),
  };
}
