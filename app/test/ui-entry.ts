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
import { setTransport, host, attach } from '../src/lib/sidecar'
import { DEFAULT_BASE_URL } from '../src/lib/backend'
import { useFeed } from '../src/hooks/useFeed'
import { FeedRow } from '../src/components/FeedRow'
import { myHandles } from '../src/lib/mentions'
import { MAX_ITEMS } from '../src/hooks/collapse'

// `MAX_ITEMS` is re-exported so the feed-cap test reads the cap the app actually
// enforces rather than keeping a second copy of the number. The copy is how the
// suite stayed red when the cap moved from 500 to 200 and only the literal did not.
export { App, setTransport, host, attach, DEFAULT_BASE_URL, useFeed, FeedRow, myHandles, MAX_ITEMS }