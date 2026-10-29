import GiveawayRunner from '@/sections/GiveawayRunner'
import { BACKEND_ORIGIN } from '@/lib/server/backend'

export const dynamic = 'force-dynamic'

/**
 * A TikTok stream's giveaway picker:
 * /app/tiktok/stream/@handle/giveaway.
 *
 * The backend origin is read here, on the server, and handed to the client so it
 * can open the room's socket. The client cannot read the environment, and the
 * socket lives on a different host from this page. It is the browser-facing
 * origin, not the loopback one this server fetches the backend with.
 */
export default async function TikTokGiveawayPage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  return <GiveawayRunner handle={handle} backendOrigin={BACKEND_ORIGIN} provider="tiktok" />
}
