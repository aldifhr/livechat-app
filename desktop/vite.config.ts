import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Tauri serves the frontend from a fixed port in dev and expects the build in
// dist/. Do not change this without updating devUrl in tauri.conf.json.
export default defineConfig({
  // Tailwind v4 drives the app stylesheets and utility classes.
  plugins: [react(), tailwindcss()],
  // shared/ is a sibling of desktop/, not a part of it, so it needs a name rather
  // than a relative path that would climb out of the package on every import.
  resolve: {
    alias: {
      // `@/*` is what the component library's generated files import, so it is
      // declared here as well as in tsconfig — Vite resolves the alias itself and
      // would fail the build on an import the type checker was happy with.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    // Keep local giveaway uploads same-origin in the webview, avoiding browser
    // CORS preflight while forwarding them to the public snapshot endpoint.
    // The dashboard's route validates and rate-limits the upload and forwards it
    // to the backend with the token attached, so the app needs no credential of
    // its own — which is the whole reason this goes through the dashboard rather
    // than at the backend directly.
    proxy: {
      '/api/giveaways/snapshots': {
        target: 'https://streamtools.aldifhr.my.id',
        changeOrigin: true,
        headers: { origin: 'https://tauri.localhost' },
      },
      // The commitment endpoints, same treatment as the snapshot upload: the app
      // has no session, so it reaches them cross-origin in a build and through
      // this proxy in dev, and the web route allows the tauri origin.
      '/api/giveaways/commit': {
        target: 'https://streamtools.aldifhr.my.id',
        changeOrigin: true,
        headers: { origin: 'https://tauri.localhost' },
      },
    },
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
