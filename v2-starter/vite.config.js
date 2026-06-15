import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [cesium()],
  server: {
    port: 5173,
  },
  build: {
    target: 'esnext',
    // Cesium assets are large — raise the chunk warning threshold
    chunkSizeWarningLimit: 3000,
  },
  // No define block needed — Vite natively exposes VITE_* vars from .env.local
  // via import.meta.env. Adding a define block here overrides that with
  // process.env.* which is undefined at config-eval time, breaking the values.
});
