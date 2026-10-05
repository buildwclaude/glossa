import { defineConfig } from 'vite';

// `base: './'` so the same build runs from Capacitor's https://localhost/
// and from any static host.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
  },
  server: { host: true, port: 5180 },
});
