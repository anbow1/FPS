import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { WebGPURenderer } from 'three/webgpu';

// The downloaded models' textures are KTX2 inside the GLB (KHR_texture_basisu, tools/assets/ktx2_glb.mjs):
// block-compressed on the GPU, a quarter to an eighth of the memory of the RGBA8 a JPEG decodes to. Every
// glTF loader of the game comes from here, so they share one KTX2 loader (one set of transcoder workers).
// No transcoder path: three's loader points at its own copy (new URL with import.meta.url), which the
// bundler emits into the build, so the APK needs no network.

let ktx2: KTX2Loader | null = null;

/** Once, after `renderer.init()`: the KTX2 loader asks the renderer which compressed formats the GPU takes. */
export function useRendererForModels(renderer: WebGPURenderer): void {
  ktx2?.dispose();
  ktx2 = new KTX2Loader().detectSupport(renderer);
}

/** The shared KTX2 loader; throws before useRendererForModels(), when it could only transcode blind. */
export function ktx2Loader(): KTX2Loader {
  if (!ktx2) throw new Error('KTX2 textures need useRendererForModels(renderer) first');
  return ktx2;
}

/** A glTF loader that reads KTX2 textures. */
export function modelLoader(): GLTFLoader {
  return new GLTFLoader().setKTX2Loader(ktx2Loader());
}
