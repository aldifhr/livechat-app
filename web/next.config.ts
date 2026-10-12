import type { NextConfig } from 'next'

const config: NextConfig = {
  // Standalone output so the VPS runs `node web/server.js` rather than a full
  // `next start` with the toolchain in the image.
  output: 'standalone',
  // shared/ is a sibling of web/, not a part of it, so the tracer starts at the
  // repo root. Without this the build cannot see the overlay contract the app
  // imports and the server fails to start.
  outputFileTracingRoot: new URL('../', import.meta.url).pathname,
}

export default config