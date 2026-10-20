/**
 * The OBS browser source, one address per platform.
 *
 * `/docks/youtube?room=<id>` and `/docks/tiktok?room=<id>` render the same
 * page. The platform segment exists because a streamer building an OBS scene
 * has a different mental model per platform — the link reads like the thing it
 * watches — and because it gives the two somewhere to diverge later without
 * moving anyone's saved browser source.
 *
 * The segment is not used to fetch anything: the room id in the query is what
 * identifies the stream, and the room's own record says which platform it reads.
 * Passing the platform in the URL as well would be a second source of truth that
 * can disagree with the first.
 *
 * `/docks` itself still works — it is what older links and the dashboard point
 * at, and the page needs nothing from the path.
 */

import DocksPage from '../page'

export const dynamic = 'force-dynamic'

export default function PlatformDocks() {
  return <DocksPage />
}
