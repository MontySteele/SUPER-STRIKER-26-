import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
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
