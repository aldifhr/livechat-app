import { Suspense } from 'react'
import StreamProfile from '@/sections/StreamProfile'

export const dynamic = 'force-dynamic'

/**
 * One TikTok stream, on its own address: /app/tiktok/stream/@handle.
 *
 * The same page `/admin/streams/@handle` serves, scoped to TikTok so the links
 * it builds stay in this tree — styling, the giveaway picker and the way back all
 * lead to `/app/tiktok/...` rather than dropping the operator into the console
 * that shows every platform at once.
 *
 * The handle is resolved in the browser rather than here, because the room list is
 * behind the session and this route already sits behind that gate.
 */
export default async function TikTokStreamPage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  return (
    <Suspense>
      <StreamProfile handle={handle} provider="tiktok" />
    </Suspense>
  )
}
