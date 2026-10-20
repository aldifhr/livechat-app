import GiveawayRunner from '@/sections/GiveawayRunner'
import { BACKEND } from '@/lib/server/backend'

export const dynamic = 'force-dynamic'

/**
 * A TikTok stream's giveaway picker:
 * /app/tiktok/stream/@handle/giveaway.
 *
 * The backend origin is read here, on the server, and handed to the client so it
 * can open the room's socket. The client cannot read the environment, and the
 * socket lives on a different host from this page.
 */
export default async function TikTokGiveawayPage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  return <GiveawayRunner handle={handle} backendOrigin={BACKEND} provider="tiktok" />
}
