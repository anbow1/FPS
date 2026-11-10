import { attribute, clamp, dot, float, length, max, mix, smoothstep, texture, uv, vec3 } from 'three/tsl';
import { type BufferGeometry, type Group, type Material, Mesh, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type Node, type Texture, type WebGPURenderer } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import hatchInfo from '../../../shared/vehicles/hatchback/hatchback.json';
import sedanInfo from '../../../shared/vehicles/sedan/sedan.json';
import type { CarVariant } from './carModel.ts';

// The cars from the shared models (shared/vehicles: a hatchback and a saloon from a CC BY car pack,
// prepared by tools/vehicles/prepare_vehicle.py), in place of the lofted procedural bodies: their
// photographed paint (recoloured per car through the `paint` instance colour, only where the texture
// shows the model's own paint), glass, lamps and wheels. Each wheel comes on its own, centred on its
// axle, so the traffic turns it with the distance driven.

export interface SharedCar {
  /** Body paint and trim (one texture), glass, head and tail lamps, all in the car's frame. */
  paint: BufferGeometry;
  glass: BufferGeometry | null;
  headlamp: BufferGeometry | null;
  taillamp: BufferGeometry | null;
  paintMaterial: MeshPhysicalNodeMaterial;
  /** A left and a right wheel, each centred on its axle; their own textured material. */
  wheel: [BufferGeometry, BufferGeometry];
  wheelMaterial: MeshStandardNodeMaterial;
  /** Front and rear axle z, half the track, the wheel radius (m). */
  axleZ: [number, number];
  trackHalf: number;
  wheelR: number;
}

interface CarJson {
  wheels: Record<'FL' | 'FR' | 'RL' | 'RR', { centre: number[]; radius: number }>;
  paint?: number[] | null;
  /** How far the paint's texels stray from `paint` in chromaticity (prepare_vehicle.py measures it). */
  paintTolerance?: number;
}

const MODELS: Record<CarVariant, { info: CarJson; urls: [string, string] }> = {
  hatch: {
    info: hatchInfo as CarJson,
    urls: [new URL('../../../shared/vehicles/hatchback/hatchback_lod0.glb', import.meta.url).href, new URL('../../../shared/vehicles/hatchback/hatchback_lod1.glb', import.meta.url).href],
  },
  saloon: {
    info: sedanInfo as CarJson,
    urls: [new URL('../../../shared/vehicles/sedan/sedan_lod0.glb', import.meta.url).href, new URL('../../../shared/vehicles/sedan/sedan_lod1.glb', import.meta.url).href],
  },
};

const loaded = new Map<string, SharedCar>();

/** The loaded car of `variant` at full (fine) or coarse detail; undefined keeps the procedural car. */
export function sharedCar(variant: CarVariant, fine: boolean): SharedCar | undefined {
  return loaded.get(`${variant}-${fine ? 0 : 1}`);
}

/**
 * Loads both cars at both levels; a failure leaves the procedural cars (logged, not thrown). The models'
 * textures are KTX2 (tools/assets/ktx2_glb.mjs): `renderer` must be initialised, the loader asks it which
 * compressed formats the GPU takes.
 */
export async function loadSharedCars(renderer: WebGPURenderer): Promise<void> {
  // No transcoder path: three's loader then points at its own copy of the Basis transcoder (new URL with
  // import.meta.url), which the bundler emits into the build, so the APK needs no network.
  const ktx2 = new KTX2Loader().detectSupport(renderer);
  const loader = new GLTFLoader().setKTX2Loader(ktx2);
  await Promise.all(
    (Object.keys(MODELS) as CarVariant[]).flatMap((variant) =>
      [0, 1].map(async (lod) => {
        const { info, urls } = MODELS[variant];
        try {
          const scene = (await loader.loadAsync(urls[lod] as string)).scene;
          loaded.set(`${variant}-${lod}`, carOf(scene, info));
        } catch (err) {
          console.warn(`shared car ${variant} lod${lod} did not load; the procedural one stands in:`, err);
        }
      }),
    ),
  ).finally(() => ktx2.dispose());
}

function carOf(scene: Group, info: CarJson): SharedCar {
  scene.updateMatrixWorld(true);
  const geo = (node: string, materialStarts?: string): { g: BufferGeometry; m: Material } | null => {
    const n = scene.getObjectByName(node);
    let out: { g: BufferGeometry; m: Material } | null = null;
    n?.traverse((o) => {
      if (out || !(o instanceof Mesh)) return;
      const m = (Array.isArray(o.material) ? o.material[0] : o.material) as Material;
      if (materialStarts && !m.name.toLowerCase().startsWith(materialStarts)) return;
      out = { g: (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld), m };
    });
    return out;
  };
  const body = geo('body', 'body');
  if (!body) throw new Error('car model without a body');
  // Wheels centred on their axles: the node's own translation taken back off.
  const wheelOf = (key: 'FL' | 'FR'): { g: BufferGeometry; m: Material } => {
    const w = geo(`wheel_${key}`);
    if (!w) throw new Error(`car model without wheel_${key}`);
    const c = info.wheels[key].centre;
    w.g.translate(-(c[0] ?? 0), -(c[1] ?? 0), -(c[2] ?? 0));
    return w;
  };
  const fl = wheelOf('FL');
  const fr = wheelOf('FR');
  const W = info.wheels;
  const z = (k: 'FL' | 'FR' | 'RL' | 'RR'): number => W[k].centre[2] ?? 0;
  const x = (k: 'FL' | 'FR' | 'RL' | 'RR'): number => Math.abs(W[k].centre[0] ?? 0);
  const wheelSrc = fl.m as MeshStandardNodeMaterial;
  const wheelMaterial = new MeshStandardNodeMaterial({ name: 'car wheel', roughness: 0.6, metalness: 0.2 });
  if (wheelSrc.map) wheelMaterial.colorNode = texture(wheelSrc.map, uv()).rgb;
  wheelMaterial.aoNode = attribute('color_1', 'vec3').x;
  return {
    paint: body.g,
    glass: geo('body', 'glass')?.g ?? null,
    headlamp: geo('lights_head')?.g ?? null,
    taillamp: geo('lights_rear')?.g ?? null,
    paintMaterial: paintMaterial(body.m as MeshStandardNodeMaterial, info.paint ?? null, info.paintTolerance ?? 0.05),
    wheel: [fl.g, fr.g],
    wheelMaterial,
    axleZ: [(z('FL') + z('FR')) / 2, (z('RL') + z('RR')) / 2],
    trackHalf: (x('FL') + x('FR') + x('RL') + x('RR')) / 4,
    wheelR: (W.FL.radius + W.RR.radius) / 2,
  };
}

const LUMA = vec3(0.2126, 0.7152, 0.0722);

/**
 * The body's own texture, its paint recoloured to the car's instance colour (`paint`): only the texels of
 * the model's paint (its chromaticity, within the model's measured spread of it; not too dark), so tyres, grilles, trim and shut lines keep theirs;
 * the texture's shading rides along as the luminance ratio. Lacquer: a smooth clear coat over the base.
 */
function paintMaterial(src: MeshStandardNodeMaterial, paint: number[] | null, tolerance: number): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'car paint', metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.06 });
  const albedo: Node<'vec3'> = src.map ? texture(src.map as Texture, uv()).rgb : vec3(0.5);
  let colour: Node<'vec3'> = albedo;
  if (paint && paint.length === 3) {
    const p = vec3(paint[0] ?? 0, paint[1] ?? 0, paint[2] ?? 0);
    const chroma = (c: Node<'vec3'>): Node<'vec3'> => c.div(max(c.x.add(c.y).add(c.z), 1e-4));
    const mask = float(1)
      .sub(smoothstep(tolerance, tolerance + 0.06, length(chroma(albedo).sub(chroma(p)))))
      .mul(smoothstep(0.002, 0.012, dot(albedo, LUMA)));
    const tint = attribute('paint', 'vec3');
    colour = mix(albedo, tint.mul(clamp(dot(albedo, LUMA).div(dot(p, LUMA)), 0, 1.6)), mask);
  }
  m.colorNode = colour;
  m.roughnessNode = float(0.3);
  m.aoNode = attribute('color_1', 'vec3').x;
  return m;
}
