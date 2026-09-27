import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  resolve: {
    // Addons import 'three'; point it at the WebGPU build so there is one copy of the core.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    // Two games, two pages: the FPS (index.html) and the tropical lagoon (lagoon.html).
    rollupOptions: { input: { main: 'index.html', lagoon: 'lagoon.html' } },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
