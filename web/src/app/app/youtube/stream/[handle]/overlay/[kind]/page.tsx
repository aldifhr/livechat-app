import { notFound } from 'next/navigation'
import OverlayBuilder, { type BuilderKind } from '@/sections/OverlayBuilder'

const KINDS: Record<string, BuilderKind> = {
  chat: 'chat',
  'top-chatter': 'board',
  cat: 'cat',
  'like-target': 'likes',
}

/**
 * One YouTube stream's customizer for one overlay:
 * /app/youtube/stream/@handle/overlay/chat.
 *
 * Styling belongs to a stream, so the customizer hangs off the stream's own
 * address. The kind is a path segment, so each overlay is somewhere a link can
 * point.
 */
export default async function YouTubeOverlayPage({
  params,
}: {
  params: Promise<{ handle: string; kind: string }>
}) {
  const { handle, kind } = await params
  const builderKind = KINDS[kind]
  if (!builderKind) notFound()
  return <OverlayBuilder handle={handle} kind={builderKind} provider="youtube" />
}
