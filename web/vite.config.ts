import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The StreamKit dashboard: a landing page at / and the admin console at /admin.
// Deployed as static files behind nginx, which serves this directory's dist/ and
// falls back to index.html so a deep link like /admin survives a refresh.
export default defineConfig({
  plugins: [react()],
  // shared/ is a sibling of web/, not a part of it, so it needs a name rather
  // than a relative path that would climb out of the package on every import.
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    port: 5184,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome110',
  },
})