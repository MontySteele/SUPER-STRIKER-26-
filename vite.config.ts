import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import controllerRelay from './vite-plugin-controller';

export default defineConfig({
  base: './',
  plugins: [controllerRelay()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        controller: resolve(__dirname, 'controller.html'),
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
