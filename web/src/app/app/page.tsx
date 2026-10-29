/**
 * The entry point under `/app`.
 *
 * This used to ask which platform to connect, because there were two. With one
 * platform left the question has one answer, so the page is a redirect rather
 * than a picker with a single button: an address that asks a question it has
 * already decided is worse than one that simply goes there.
 *
 * Public: the connect route behind it carries no token, and the links it leads
 * to are the ones OBS loads with no credential.
 */

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function AppEntry() {
  redirect('/app/tiktok')
}
