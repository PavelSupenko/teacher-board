import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development Vite serves the client while the WebSocket is proxied to the
// local collaboration server (server/index.js).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:4321', ws: true },
      '/api': { target: 'http://localhost:4321' },
    },
  },
})
