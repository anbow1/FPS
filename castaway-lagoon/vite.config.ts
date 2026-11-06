import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  resolve: {
    // Addons import 'three'; point it at the WebGPU build so there is one copy of the core.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  // The shared vehicle models (../shared/vehicles) sit outside this project's root.
  server: { fs: { allow: ['..'] } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
