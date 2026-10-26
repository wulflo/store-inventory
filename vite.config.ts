import { defineConfig } from 'vitest/config';

// Tauri 2 espera el dev server en 1420 y usa variables `TAURI_ENV_*`.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      // La carpeta de datos vive fuera del proyecto: no la vigiles.
      ignored: ['**/src-tauri/target/**', '**/data/**', '**/.data/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'es2021',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: 'esbuild',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
