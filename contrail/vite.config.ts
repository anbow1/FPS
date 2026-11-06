import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  resolve: {
    // Addons import 'three'; point it at the WebGPU build so there is one copy of the core.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  // The shared models (../shared/vehicles) live outside this project.
  server: { fs: { allow: ['..'] } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  test: {
    testTimeout: 120_000,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
