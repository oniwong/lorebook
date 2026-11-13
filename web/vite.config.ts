import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // Everything must be served from this origin; no CDN, no external fonts.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
});
