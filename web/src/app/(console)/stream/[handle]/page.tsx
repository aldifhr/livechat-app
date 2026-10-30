import { Suspense } from 'react'
import StreamProfile from '@/sections/StreamProfile'

/**
 * One stream, on its own address: `/stream/@handle`.
 *
 * Split out of the list so a stream is something with an address rather than a card
 * in a grid. The handle is the parameter rather than the room id because that is the
 * part a person says out loud. It is resolved in the browser, because the room list
 * is behind the session and this route already sits behind that gate — and because
 * the profile has to show a room that has just been renamed.
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
