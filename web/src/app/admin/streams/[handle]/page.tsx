import { Suspense } from 'react'
import StreamProfile from '@/sections/StreamProfile'

/**
 * One stream, on its own address: /admin/streams/@handle.
 *
 * Split out of the list so a stream is something with an address rather than a card
 * in a grid. That is worth doing for the same reason the overlay builder is a page
 * and not a panel: the thing an operator is working on — this stream, its links,
 * its name — is somewhere they can be sent, bookmarked, and returned to with the
 * back button. A grid of six cards has no such address for any of them.
 *
 * The handle is the parameter rather than the room id because that is the part a
 * person says out loud. It is resolved in the browser rather than here, because the
 * room list is behind the session and this route already sits behind that gate; and
 * because the profile has to show a room that has just been renamed, which a route
 * resolved at request time could not do without a redirect.
 */
export default async function StreamProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  return (
    <Suspense>
      <StreamProfile handle={handle} />
    </Suspense>
  )
}
