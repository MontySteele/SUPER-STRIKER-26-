import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        // studio character viewer (§7A.9) — a build input so it works in dev
        // and survives into dist/ for reviewing kits on a deployed build
        viewer: resolve(__dirname, 'viewer.html'),
        // guest controller page (§5.4.2) — inputs only, renders no gameplay
        join: resolve(__dirname, 'join.html'),
      },
    },
  },
  // Vite rejects unknown Host headers by default, which 403s Cloudflare
  // quick tunnels (Host: <random>.trycloudflare.com) before index.html loads.
  preview: {
    allowedHosts: ['.trycloudflare.com'],
  },
  server: {
    allowedHosts: ['.trycloudflare.com'],
  },
});
