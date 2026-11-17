/**
 * Old dashboard addresses, kept as bookmarks.
 *
 * The console used to live under /admin/*. It does now at the top level, and
 * /admin itself already redirects — but a bookmark to /admin/dashboard skipped
 * that page entirely and ended in a 404. Redirect any remaining /admin/... path
 * to the console so those links keep working.
 */
import { redirect } from 'next/navigation'

export default async function LegacyAdmin({
  params,
}: {
  params: Promise<{ path: string[] }>
}) {
  const { path } = await params
  // Drop the stale segment; unknown old pages land on the console root, which
  // is where a person using an obsolete link meant to go.
  void path
  redirect('/dashboard')
}
