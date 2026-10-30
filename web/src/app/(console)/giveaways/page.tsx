import { BACKEND } from '@/lib/server/backend'
import GiveawayHub from '@/components/GiveawayHub'

export const dynamic = 'force-dynamic'

/**
 * The giveaway feature, at `/giveaways`.
 *
 * The backend origin is read here, on the server, and handed to the hub so the
 * picker can open a room's socket — the client cannot read the environment, and
 * the socket lives on a different host from this page.
 */
export default function GiveawaysPage() {
  return <GiveawayHub backendOrigin={BACKEND} />
}
