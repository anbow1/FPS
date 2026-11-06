import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  // The shared models (../shared/vehicles) live outside this project.
  server: { fs: { allow: ['..'] } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
