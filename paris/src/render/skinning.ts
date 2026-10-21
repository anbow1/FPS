import { attribute, Fn, instanceIndex, int, ivec2, mat4, normalLocal, positionLocal, positionPrevious, textureLoad, vec4 } from 'three/tsl';
import { DataTexture, FloatType, type Matrix4, NearestFilter, type Node, RGBAFormat } from 'three/webgpu';

// Instanced skinning: one body mesh for every soldier, its joints soft. Each
// vertex carries up to four bones and weights (`skinIdx`, `skinWgt`); each
// soldier's bone matrices (world × inverse bind, so a vertex in the bind pose
// goes straight to the world) sit in a float texture, one row per instance,
// four texels per bone (the matrix columns). The vertex stage reads its row by
// the instance index and blends the bones, so the whole squad is one draw —
// three's SkinnedMesh would be a draw per man and per shadow cascade.
//
// Joints are soft because a vertex near a joint takes both bones: a knee bends
// as one skin, not as two capsules sliding through each other.

export class BoneTexture {
  readonly texture: DataTexture;
  private readonly data: Float32Array;

  constructor(
    readonly bones: number,
    readonly instances: number,
  ) {
    this.data = new Float32Array(bones * 4 * instances * 4);
    this.texture = new DataTexture(this.data, bones * 4, instances, RGBAFormat, FloatType);
    // Read with textureLoad only: float32 is not filterable everywhere, and nothing samples between texels.
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /** The skinning matrix of `bone` for `instance` (world × inverse bind). */
  set(instance: number, bone: number, m: Matrix4): void {
    this.data.set(m.elements, (instance * this.bones + bone) * 16);
  }

  /** Marks the matrices for upload; call once per frame after the last `set`. */
  commit(): void {
    this.texture.needsUpdate = true;
  }

  /** Copies another texture's matrices (last frame's, before they change). */
  copyFrom(other: BoneTexture): void {
    this.data.set(other.data);
    this.texture.needsUpdate = true;
  }
}

/**
 * A material's `positionNode` that skins the bind-pose vertex by its bones in `bones` (and turns its normal
 * the same way). The mesh's instance matrices must be identity: the bone matrices carry the whole placement.
 * With `previous` (last frame's bones) the previous position is skinned too, so the velocity buffer (TRAA,
 * motion blur) sees the body's real motion rather than the distance from its bind pose.
 */
export function skinnedPosition(bones: BoneTexture, previous?: BoneTexture): Node<'vec3'> {
  return Fn(() => {
    const idx = attribute('skinIdx', 'vec4');
    const wgt = attribute('skinWgt', 'vec4');
    const row = int(instanceIndex);
    const boneIn = (t: BoneTexture, b: Node<'float'>) => {
      const x = int(b).mul(4);
      return mat4(textureLoad(t.texture, ivec2(x, row)), textureLoad(t.texture, ivec2(x.add(1), row)), textureLoad(t.texture, ivec2(x.add(2), row)), textureLoad(t.texture, ivec2(x.add(3), row)));
    };
    const bone = (b: Node<'float'>) => boneIn(bones, b);
    if (previous) {
      const p0 = vec4(positionLocal, 1);
      const was = (b: Node<'float'>) => boneIn(previous, b).mul(p0);
      positionPrevious.assign(was(idx.x).mul(wgt.x).add(was(idx.y).mul(wgt.y)).add(was(idx.z).mul(wgt.z)).add(was(idx.w).mul(wgt.w)).xyz);
    }
    const m0 = bone(idx.x);
    const m1 = bone(idx.y);
    const m2 = bone(idx.z);
    const m3 = bone(idx.w);
    const p = vec4(positionLocal, 1);
    const skinned = m0.mul(p).mul(wgt.x).add(m1.mul(p).mul(wgt.y)).add(m2.mul(p).mul(wgt.z)).add(m3.mul(p).mul(wgt.w));
    // Rigid bones (no scale): the normal turns with the same blend of rotations.
    const n = vec4(normalLocal, 0);
    const skinnedN = m0.mul(n).mul(wgt.x).add(m1.mul(n).mul(wgt.y)).add(m2.mul(n).mul(wgt.z)).add(m3.mul(n).mul(wgt.w));
    normalLocal.assign(skinnedN.xyz.normalize());
    return skinned.xyz;
  })() as unknown as Node<'vec3'>;
}
