/**
 * Test entry point.
 *
 * Bundled as a single module so the UI and the fake transport share one copy of
 * the transport module — with two separate bundles each would get its own, and
 * setting a fake on the test's copy would never be seen by the components.
 *
 * Not part of the shipped app: only the UI test imports it.
 */

import App from '../src/App'
import Overlay from '../src/components/Overlay'
import { setTransport, host, attach } from '../src/lib/sidecar'

export { App, Overlay, setTransport, host, attach }