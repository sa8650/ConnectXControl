import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api to the local Pages Functions runtime so the
// browser never needs another origin (works in sandboxed previews too).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8788', changeOrigin: true }
    }
  },
  build: { outDir: 'dist', sourcemap: false }
});
