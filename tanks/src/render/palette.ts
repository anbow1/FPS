import * as THREE from 'three/webgpu';

/**
 * PBR values from the material reference sheet. Colours are sRGB hex; THREE converts them
 * to linear when assigned (ColorManagement is on). Paint, phosphate, rust and rubber are metal 0.
 */
export const PBR = {
  asphaltDry: { color: 0x3a3a3c, rough: 0.92, metal: 0 },
  concrete: { color: 0x8f8b85, rough: 0.88, metal: 0 },
  brick: { color: 0x8a4b3a, rough: 0.8, metal: 0 },
  windowGlass: { color: 0xe6ebeb, rough: 0.02, metal: 0 },
  drySoil: { color: 0x6b5a47, rough: 0.95, metal: 0 },
  mudWet: { color: 0x3e3328, rough: 0.4, metal: 0 },
  sand: { color: 0xc2b280, rough: 0.9, metal: 0 },
  grassDry: { color: 0x6d7343, rough: 0.9, metal: 0 },
  grassFresh: { color: 0x4a6030, rough: 0.85, metal: 0 },
  pineFoliage: { color: 0x3c4a2e, rough: 0.85, metal: 0 },
  treeBark: { color: 0x4a3b30, rough: 0.93, metal: 0 },
  rock: { color: 0x7a7672, rough: 0.85, metal: 0 },
  water: { color: 0x3e5a4c, rough: 0.02, metal: 0 },
  steelWorn: { color: 0xc6c6c8, rough: 0.35, metal: 1 },
  parkerised: { color: 0x3c3c3e, rough: 0.62, metal: 0 },
  natoGreen: { color: 0x4b5340, rough: 0.76, metal: 0 },
  khakiGreen: { color: 0x5c5b3e, rough: 0.8, metal: 0 },
  rubberTrack: { color: 0x2b2b2d, rough: 0.9, metal: 0 },
  tyreRubber: { color: 0x2c2c2e, rough: 0.86, metal: 0 },
  soot: { color: 0x2b2b2c, rough: 0.97, metal: 0 },
  rust: { color: 0x7a4326, rough: 0.88, metal: 0 },
  brass: { color: 0xf5e4ae, rough: 0.25, metal: 1 },
} as const;

export type PbrKey = keyof typeof PBR;

export function linear(hex: number): THREE.Color {
  return new THREE.Color(hex); // ColorManagement converts sRGB hex → linear working space
}

/** A node material from the sheet (node materials take the thermal output and wind nodes). */
export function stdMat(key: PbrKey, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardNodeMaterial {
  const p = PBR[key];
  return new THREE.MeshStandardNodeMaterial({ color: p.color, roughness: p.rough, metalness: p.metal, ...extra });
}
