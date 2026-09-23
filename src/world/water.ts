import * as THREE from 'three';
import { WATER_LEVEL } from '../config';
import { PBR } from '../render/palette';
import { addPatch, G, inject, thermalPatch } from '../render/shaderPatch';
import type { NoiseSet } from '../render/textures';
import { LAKES } from './layout';

/** River/lake surface: tinted, near-mirror (rough 0.02), two scrolling detail-normal layers. */
export function buildWater(noise: NoiseSet): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: PBR.water.color,
    roughness: 0.03,
    metalness: 0,
    transparent: true,
    opacity: 0.88,
    envMapIntensity: 1.0,
  });
  addPatch(mat, {
    key: 'water',
    apply(shader) {
      shader.uniforms.tGrad = { value: noise.gradient };
      shader.uniforms.uTime = G.uTime;
      inject(shader, 'vertex', '#include <common>', 'varying vec3 vWPos;', 'after');
      inject(shader, 'vertex', '#include <begin_vertex>', 'vWPos = (modelMatrix * vec4(position, 1.0)).xyz;', 'after');
      inject(shader, 'fragment', '#include <common>', 'varying vec3 vWPos; uniform sampler2D tGrad; uniform float uTime;', 'after');
      inject(
        shader,
        'fragment',
        '#include <normal_fragment_maps>',
        `{
          vec2 p = vWPos.xz;
          vec2 g1 = texture2D(tGrad, p / 9.0 + vec2(uTime * 0.012, uTime * 0.007)).xy * 2.0 - 1.0;
          vec2 g2 = texture2D(tGrad, p / 3.7 - vec2(uTime * 0.02, -uTime * 0.013)).xy * 2.0 - 1.0;
          vec2 g = g1 * 0.08 + g2 * 0.05;
          vec3 nw = normalize(vec3(-g.x, 1.0, -g.y));
          normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
        }`,
        'after',
      );
    },
  });
  addPatch(mat, thermalPatch('water', '0.025'));
  for (const l of LAKES) {
    const g = new THREE.CircleGeometry(l.r * 1.35, 64);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set(l.x, WATER_LEVEL, l.z);
    m.receiveShadow = true;
    m.renderOrder = 1;
    group.add(m);
  }
  return group;
}
