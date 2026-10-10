import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri serves the frontend from a fixed port in dev and expects the build in
// dist/. Do not change this without updating devUrl in tauri.conf.json.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome110',
  },
})