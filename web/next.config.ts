import type { NextConfig } from 'next'
import { fileURLToPath } from 'node:url'

// `new URL('../', import.meta.url).pathname` is not a filesystem path: on Windows
// it comes back as `/C:/Users/...` — a leading slash and forward slashes, which
// the tracer cannot open, so `npm run dev`/`build` die in a Windows checkout.
// `fileURLToPath` is the conversion that accounts for the platform. `'..'`
// resolves to the repo root, the parent of `web/`.
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const config: NextConfig = {
  // Standalone output so the VPS runs `node web/server.js` rather than a full
  // `next start` with the toolchain in the image.
  output: 'standalone',
  // shared/ is a sibling of web/, not a part of it, so the tracer starts at the
  // repo root. Without this the build cannot see the overlay contract the app
  // imports and the server fails to start.
  outputFileTracingRoot: repoRoot,
}

export default config