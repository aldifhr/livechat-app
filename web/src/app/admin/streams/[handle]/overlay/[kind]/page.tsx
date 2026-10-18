import { notFound } from 'next/navigation'
import OverlayBuilder, { type BuilderKind } from '@/sections/OverlayBuilder'

/**
 * One stream's customizer for one overlay: /admin/streams/@handle/overlay/chat.
 *
 * Styling belongs to a stream, so the customizer hangs off the stream's own address
 * rather than off a builder that would have to name the room another way. The kind
 * is a path segment, so each overlay is somewhere a link can point.
 *
 * The handle is resolved in the browser, like the profile: the room list is behind
 * the session and this route is already behind that gate, and a room renamed a
 * moment ago still resolves without a redirect.
 */

const KINDS: Record<string, BuilderKind> = {
  chat: 'chat',
  'top-chatter': 'board',
  cat: 'cat',
}

export default async function StreamOverlayPage({
  params,
}: {
  params: Promise<{ handle: string; kind: string }>
}) {
  const { handle, kind } = await params
  const builderKind = KINDS[kind]
  if (!builderKind) notFound()
  return <OverlayBuilder handle={handle} kind={builderKind} />
}
