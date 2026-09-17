import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // SSE needs the proxy to leave the stream alone, hence no buffering here.
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
})
