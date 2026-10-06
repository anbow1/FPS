import { abs, cameraPosition, exp, float, fract, fwidth, length, max, min, mix, positionWorld, smoothstep, vec3 } from 'three/tsl';
import { BackSide, DirectionalLight, HemisphereLight, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, type Node, PlaneGeometry, type Scene, SphereGeometry } from 'three/webgpu';

// Milestone 1 stage (brief: "the flight model in a grey sky"): a neutral sky
// gradient, a ground plane with 100 m and 1 km grid lines so speed, altitude
// and attitude read, haze with distance, and a sun in lux. Replaced by the
// terrain (milestone 3) and the physical atmosphere (milestone 4).

/** Clear-noon values from lighting-reference.png. */
export const NOON = { sunLux: 100_000, skyLux: 20_000, ev100: 15.3 } as const;

export function buildGreyWorld(scene: Scene, exposure: number): { sun: DirectionalLight; ground: Mesh; sky: Mesh } {
  const sun = new DirectionalLight(0xfff4e8, NOON.sunLux * exposure);
  sun.position.set(0.3, 0.8, 0.45).multiplyScalar(1000);
  scene.add(sun, sun.target);
  // Hemisphere ambient standing in for the sky until the environment probe exists. three uses the
  // intensity as irradiance (diffuse = albedo/π × intensity), so it is the sky's illuminance in lux.
  const hemi = new HemisphereLight(0xb7c6d8, 0x6b6a62, NOON.skyLux * exposure);
  scene.add(hemi);

  // Sky: a dome that follows the camera, grey-blue by elevation, in pre-exposed radiance.
  const skyRadiance = (NOON.skyLux / Math.PI) * exposure;
  const skyMat = new MeshBasicNodeMaterial({ name: 'grey sky', side: BackSide, depthWrite: false });
  const elevation = positionWorld.sub(cameraPosition).normalize().y;
  skyMat.colorNode = mix(vec3(0.72, 0.76, 0.8), vec3(0.38, 0.48, 0.62), smoothstep(0, 0.6, elevation.max(0))).mul(skyRadiance * 1.2);
  const sky = new Mesh(new SphereGeometry(400_000, 32, 16), skyMat);
  sky.name = 'sky dome';
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  const g = new PlaneGeometry(400_000, 400_000, 1, 1).rotateX(-Math.PI / 2);
  const m = new MeshStandardNodeMaterial({ name: 'grey ground', roughness: 0.95, metalness: 0 });
  const p = positionWorld.xz;
  const line = (cellM: number, widthM: number): Node<'float'> => {
    const d = abs(fract(p.div(cellM)).sub(0.5)).mul(cellM);
    const toLine = min(float(cellM / 2).sub(d.x), float(cellM / 2).sub(d.y));
    return float(1).sub(smoothstep(float(widthM), max(fwidth(toLine).mul(1.5), widthM * 2), toLine));
  };
  const lines = max(line(100, 0.6).mul(0.5), line(1000, 3));
  const dist = length(positionWorld.sub(cameraPosition));
  const haze = float(1).sub(exp(dist.mul(-1 / 60_000)));
  m.colorNode = mix(mix(vec3(0.32, 0.33, 0.3), vec3(0.12, 0.13, 0.12), lines), vec3(0.6, 0.64, 0.68), haze);
  const ground = new Mesh(g, m);
  ground.receiveShadow = true;
  ground.name = 'grey ground';
  scene.add(ground);
  return { sun, ground, sky };
}
