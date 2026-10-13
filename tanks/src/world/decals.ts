import * as THREE from 'three/webgpu';
import { stdMat } from '../render/palette';
import { addThermalConst } from '../render/nodes';
import { makeScorchTexture, makeTrackMarkTexture } from '../render/textures';
import type { Heightfield } from './heightfield';

/**
 * Ground decals as ring-buffered instanced quads laid on the terrain normal:
 * tank track imprints (wet-mud material from the sheet) and scorch marks after hits.
 */
class DecalRing {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly capacity: number) {
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.count = 0;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }
  add(m: THREE.Matrix4): void {
    this.mesh.setMatrixAt(this.next, m);
    this.next = (this.next + 1) % this.capacity;
    this.mesh.count = Math.max(this.mesh.count, this.next === 0 ? this.capacity : this.next);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear(): void {
    this.next = 0;
    this.mesh.count = 0;
  }
}

export class Decals {
  readonly group = new THREE.Group();
  private tracks: DecalRing;
  private scorch: DecalRing;

  constructor(private readonly hf: Heightfield) {
    const trackGeo = new THREE.PlaneGeometry(1, 1);
    trackGeo.rotateX(-Math.PI / 2);
    const trackMat = stdMat('mudWet', {
      alphaMap: makeTrackMarkTexture(),
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      // Reversed depth buffer (near = 1) and three.js passes the bias through unflipped: positive pulls
      // the mark toward the camera. A negative one pushed every track and scorch under the ground.
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 4,
    });
    addThermalConst(trackMat, 0.1);
    this.tracks = new DecalRing(trackGeo, trackMat, 6000);
    const scorchMat = stdMat('soot', {
      alphaMap: makeScorchTexture(),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 3,
      polygonOffsetUnits: 6,
    });
    addThermalConst(scorchMat, 0.14);
    this.scorch = new DecalRing(trackGeo, scorchMat, 240);
    this.group.add(this.tracks.mesh, this.scorch.mesh);
  }

  private place(ring: DecalRing, x: number, z: number, yaw: number, w: number, l: number, lift: number): void {
    this.hf.normalAt(x, z, _n);
    _nv.set(_n.x, _n.y, _n.z);
    _q.setFromUnitVectors(_up, _nv);
    _q2.setFromAxisAngle(_up, yaw);
    _q.multiply(_q2);
    _p.set(x, this.hf.heightAt(x, z) + lift, z);
    _s.set(w, 1, l);
    _m.compose(_p, _q, _s);
    ring.add(_m);
  }

  addTrack(x: number, z: number, yaw: number, width: number): void {
    this.place(this.tracks, x, z, yaw, width, 0.75, 0.03);
  }

  addScorch(x: number, z: number, size: number): void {
    this.place(this.scorch, x, z, Math.random() * Math.PI * 2, size, size, 0.05);
  }

  clear(): void {
    this.tracks.clear();
    this.scorch.clear();
  }
}

const _n = { x: 0, y: 1, z: 0 };
const _nv = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
