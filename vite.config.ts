import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: (chunk) => `assets/${chunk.name.replace(/^_+/, '')}.js`,
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  worker: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: (chunk) => `assets/${chunk.name.replace(/^_+/, '')}.js`,
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
});
