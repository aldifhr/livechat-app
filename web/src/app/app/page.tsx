import { redirect } from 'next/navigation'

/**
 * The old platform entry point.
 *
 * There is one platform, so `/app` and everything under it moved to the console
 * root — `/streams`, `/stream/@handle`, `/analytics`. This keeps links and
 * bookmarks made before the move working.
 */
export default function AppRedirect() {
  redirect('/dashboard')
}
