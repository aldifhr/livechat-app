/**
 * Headless DOM for the UI tests.
 *
 * Renders the real components into jsdom and drives them through a fake
 * transport, so the UI can be tested without launching the app, opening a
 * window, or enabling WebView2's debug port. The components under test are the
 * shipped ones — only the transport to the Rust host is replaced.
 */

import { JSDOM } from 'jsdom'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// This file lives one level deeper than the project's own test helpers, so the
// project root is two up rather than one.
const pkgRoot = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Bundles the UI into a temp dir and returns entry URLs for it and for the
 * transport module.
 *
 * Vite rather than tsc: tsc emits extensionless imports, which Node's ESM loader
 * will not resolve, and bundling matches how the app actually ships. Two entries
 * are produced on purpose — the test and the app have to end up holding the *same*
 * instance of the transport module, or setting a fake on the test's copy would
 * never be seen by the UI.
 */
export async function loadApp() {
  const outDir = mkdtempSync(join(tmpdir(), 'ui-test-'))

  // The Tauri APIs are never reached headlessly, but the bundle still has to
  // resolve them, so they are stubbed at bundle time rather than mocked later.
  const stubs = join(outDir, 'stubs')
  mkdirSync(stubs, { recursive: true })
  writeFileSync(
    join(stubs, 'api-core.js'),
    'export const invoke = async () => undefined\n',
  )
  writeFileSync(
    join(stubs, 'api-event.js'),
    'export const listen = async () => () => {}\n',
  )

  const alias = {
    '@tauri-apps/api/core': join(stubs, 'api-core.js'),
    '@tauri-apps/api/event': join(stubs, 'api-event.js'),
  }

  const { build } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default

  // A single entry, so the UI and the test share one copy of the transport
  // module. Two separate bundles would each get their own, and setting a fake on
  // the test's copy would never be seen by the components.
  await build({
    root: pkgRoot,
    logLevel: 'error',
    plugins: [react()],
    resolve: { alias },
    define: {
      // React ships a production build by default under a bundler, and that build
      // throws on `act`. Tests need the development build.
      'process.env.NODE_ENV': '"development"',
    },
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'esnext',
      lib: {
        entry: join(pkgRoot, 'sidecar', 'test', 'ui-entry.ts'),
        formats: ['es'],
        fileName: () => 'ui.js',
      },
      rollupOptions: {
        // Left unbundled so the components and this test share one React. A
        // second copy inside the bundle has its own hook dispatcher, and every
        // hook call then fails with "Invalid hook call".
        external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
      },
    },
  })

  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'module' }))
  // So bare specifiers inside the bundle resolve to the project's own copies.
  symlinkSync(join(pkgRoot, 'node_modules'), join(outDir, 'node_modules'), 'junction')

  return {
    outDir,
    /** Exports `App`, `setTransport`, `host` and `attach` — one module instance. */
    entry: pathToFileURL(join(outDir, 'ui.js')).href,
  }
}

/**
 * Installs a jsdom window on the globals React and the components read.
 *
 * Returning the pieces needed to tear it down keeps a failed assertion from
 * leaking a window into the next test.
 */
export function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })

  // Loaded on purpose: the app's stylesheet is imported by `main.tsx`, which the
  // tests replace with their own render call. Without it, every styling assertion
  // would pass vacuously against jsdom's default styles.
  const css = readFileSync(join(pkgRoot, 'src', 'styles.css'), 'utf8')
  const style = dom.window.document.createElement('style')
  style.textContent = css
  dom.window.document.head.append(style)

  const g = globalThis
  const saved = {
    window: g.window,
    document: g.document,
    HTMLElement: g.HTMLElement,
    Element: g.Element,
    Node: g.Node,
    Event: g.Event,
    KeyboardEvent: g.KeyboardEvent,
    MouseEvent: g.MouseEvent,
    getComputedStyle: g.getComputedStyle,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
  }

  g.window = dom.window
  g.document = dom.window.document
  g.HTMLElement = dom.window.HTMLElement
  g.Element = dom.window.Element
  g.Node = dom.window.Node
  g.Event = dom.window.Event
  g.KeyboardEvent = dom.window.KeyboardEvent
  g.MouseEvent = dom.window.MouseEvent
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
  g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
  g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
  // React 18 requires this to allow effects to flush synchronously in tests.
  g.IS_REACT_ACT_ENVIRONMENT = true

  return {
    dom,
    container: dom.window.document.getElementById('root'),
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete g[key]
        else g[key] = value
      }
      dom.window.close()
    },
  }
}

/** Lets React flush pending effects and state updates. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A transport that records commands and lets a test push frames by hand.
 *
 * This is the whole point of the module: the UI is exercised end to end with no
 * window and no Rust process, so a test run costs milliseconds and cannot be
 * derailed by a rate limit on either platform.
 */
export function fakeTransport() {
  const commands = []
  const handlers = new Set()

  return {
    commands,
    transport: {
      async listen(handler) {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
      async invoke(command, args) {
        commands.push({ command, args })
      },
    },
    /** Pushes a frame to the UI exactly as the host would. */
    emit(event) {
      for (const handler of handlers) handler(event)
    },
    lastCommand(name) {
      return [...commands].reverse().find((c) => c.command === name)
    },
  }
}
/**
 * Ends a suite early when an external condition made it meaningless.
 *
 * Both platforms throttle and streams end, and neither is a defect in the app. A
 * suite that reports a pile of failures because one video ended trains people to
 * ignore it, so this exits 0 with the reason printed.
 */
export function skip(reason, socket) {
  console.log(`\nSKIPPED — ${reason}`)
  console.log('(an upstream condition, not an app failure; the checks above still ran)')
  socket?.close()
  process.exit(0)
}
