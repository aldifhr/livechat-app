import { Suspense } from 'react'
import StreamProfile from '@/sections/StreamProfile'

export const dynamic = 'force-dynamic'

/**
 * One YouTube stream, on its own address: /app/youtube/stream/@handle.
 *
 * The same page `/admin/streams/@handle` serves, scoped to YouTube so the links
 * it builds stay in this tree — styling, the giveaway picker and the way back all
 * lead to `/app/youtube/...` rather than dropping the operator into the console
 * that shows every platform at once.
 *
 * The handle is resolved in the browser rather than here, because the room list is
 * behind the session and this route already sits behind that gate.
 */
export default async function YouTubeStreamPage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  return (
    <Suspense>
      <StreamProfile handle={handle} provider="youtube" />
    </Suspense>
  )
}
