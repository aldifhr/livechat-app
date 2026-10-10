/**
 * Runs the UI suites against a real app.
 *
 * Each of these opens a window with WebView2's debug port enabled and drives it
 * through the DevTools protocol. They cover what jsdom cannot — the actual Tauri
 * commands, the actual bridge process, and real network traffic.
 *
 * They are kept separate from `npm test` on purpose: they need a built exe and,
 * for the TikTok suites, a streamer who is live. The headless UI suite is what
 * runs every time.
 *
 *   npm run test:e2e:app -- @someuser
 */

import { spawn, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Two levels up: this file sits in `sidecar/test/`, not `sidecar/`.
const pkgRoot = fileURLToPath(new URL('../..', import.meta.url))

const EXE = join(
  pkgRoot,
  'src-tauri',
  'target',
  'release',
  'livechat-app.exe',
)

const SUITES = [
  { file: 'test-app.mjs', needsLive: true },
  { file: 'test-log-ui.mjs', needsLive: true },
  { file: 'test-disconnect.mjs', needsLive: true },
  { file: 'test-error-ui.mjs', needsLive: false },
  { file: 'test-kill.mjs', needsLive: true },
]

const tiktok = process.argv[2]

/** Kill any leftover bridge from an earlier run before starting. */
function cleanup() {
  // Only this app's own processes. `msedgewebview2` is deliberately not touched:
  // it is shared with Windows components (Widgets, SearchHost, M365 Copilot), so
  // killing it would tear down unrelated processes and would not reliably reach
  // ours anyway.
  for (const name of ['livechat-app', 'livechat-bridge']) {
    try {
      execSync(`Stop-Process -Name ${name} -Force -ErrorAction SilentlyContinue`, {
        shell: 'powershell.exe',
      })
    } catch {
      // Nothing running is the normal case.
    }
  }
}

/**
 * Waits for the debug endpoint to stop answering.
 *
 * The endpoint is what proves the previous app's window is really gone. Waiting on
 * a process name is not enough: the page outlives the process briefly, and a
 * suite that finds the stale page on the endpoint would drive the old window.
 */
async function waitForPortFree(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://localhost:9222/json/list', {
        signal: AbortSignal.timeout(2000),
      })
      const pages = await response.json()
      if (!pages.some((p) => p.url?.includes('tauri.localhost'))) return true
    } catch {
      // Not listening at all, which is the state we want.
      return true
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function run(file, scriptArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(pkgRoot, 'sidecar', file), ...scriptArgs], {
      cwd: pkgRoot,
      stdio: 'inherit',
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

cleanup()
await waitForPortFree()
await new Promise((r) => setTimeout(r, 1500))

let failed = 0
let skipped = 0

for (const suite of SUITES) {
  // Each suite gets a fresh app: they share one window otherwise, and one
  // suite's platform selection would decide the next one's starting state.
  cleanup()
  await waitForPortFree()
  await new Promise((r) => setTimeout(r, 1000))

  const child = spawn(EXE, [], {
    stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' },
  })

  // Long enough for WebView2 to be listening before a suite probes the endpoint.
  await new Promise((r) => setTimeout(r, 10000))

  const needs = [tiktok]
  if (suite.needsLive && !tiktok) {
    console.log(`\n=== ${suite.file} — SKIPPED (needs a live @username) ===`)
    skipped++
  } else {
    console.log(`\n=== ${suite.file} ===`)
    const code = await run(suite.file, needs)
    if (code !== 0) failed++
  }

  child.kill()
}

cleanup()

console.log(`\n${failed === 0 ? 'all suites passed' : `${failed} suite(s) failed`}${skipped ? `, ${skipped} skipped` : ''}`)
process.exit(failed === 0 ? 0 : 1)