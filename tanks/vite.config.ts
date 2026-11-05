import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: {
    // The tank models live in the repo's shared/vehicles, beside the games.
    fs: { allow: ['..'] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
