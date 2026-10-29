import type { NextConfig } from 'next'
import { fileURLToPath } from 'node:url'

// `new URL('../', import.meta.url).pathname` is not a filesystem path: on Windows
// it comes back as `/C:/Users/...` — a leading slash and forward slashes, which
// the tracer cannot open, so `npm run dev`/`build` die in a Windows checkout.
// `fileURLToPath` is the conversion that accounts for the platform. `'..'`
// resolves to the repo root, the parent of `web/`.
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const config: NextConfig = {
  // Follow security upgrades. Set so an agent upgrading this app pulls the
  // patched release for a published advisory rather than the newest feature
  // version — the safe default for a deployment that only wants the fix.
  experimental: {
    agentUpgrade: 'security',
  },
  // Standalone output so the VPS runs `node web/server.js` rather than a full
  // `next start` with the toolchain in the image.
  output: 'standalone',
  // shared/ is a sibling of web/, not a part of it, so the tracer starts at the
  // repo root. Without this the build cannot see the overlay contract the app
  // imports and the server fails to start.
  outputFileTracingRoot: repoRoot,

  // The overlay addresses, locally.
  //
  // In production these are nginx's job, not Next's: the pages are static files
  // served from disk by `snippets/streamtools-overlays.conf`, which is why OBS
  // keeps working while this service restarts, and why nginx has to rewrite
  // `/overlay/chat-overlay` onto the file behind it. Locally there is no nginx,
  // and the extensionless address the app hands out — the one that goes into a
  // browser source — 404s while the `.html` next to it works. A link that is
  // correct in production and dead in development is worse than either, because
  // the only place it can be tested is the place it does not work.
  //
  // The two older short spellings stay available. The full overlay routes are
  // handled by app route handlers, which inject the backend socket origin while
  // keeping the page itself on this web host.
  async rewrites() {
    return [
      { source: '/overlay', destination: '/overlay/chat-overlay' },
      { source: '/topchatter', destination: '/overlay/top-chatter' },
    ]
  },
}

export default config
