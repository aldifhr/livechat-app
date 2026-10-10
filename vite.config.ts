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
    // target/ is cargo's, not the frontend's. Watching it meant watching tens of
    // thousands of build artifacts, and watching the .exe specifically meant
    // failing with EBUSY every time cargo held it open to link - which takes the
    // dev server down mid-build and reports it as a watcher error.
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome110',
  },
})