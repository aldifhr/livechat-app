/**
 * Where one stream's pages are.
 *
 * Both the list and the profile build the same three links, and the profile's own
 * address is needed by both — the list links to it, and the builder links back to
 * it. Three places spelling out `/admin/streams/…` is three places to change when
 * the shape of that address changes.
 */

import { api } from './api'

/**
 * The address of a stream's profile.
 *
 * The handle and not the room id: this is an address somebody types, bookmarks and
 * pastes to a colleague, and `61ea70c9-6d36-4a6a-bf94-b648532447bb` is not that.
 *
 * The `@` is left unencoded on purpose — `encodeURIComponent('@')` is `%40`, and
 * browsers leave that on screen. A handle is `[A-Za-z0-9._]` as the backend
 * validates it, so the encode around it is a guard rather than a transformation.
 *
 * A room with no handle yet falls back to its id, which is ugly but reachable: the
 * profile resolves either, so a link built before the handle was set does not
 * dead-end.
 */
export function profilePath(username: string, id: string): string {
  return username ? `/admin/streams/@${encodeURIComponent(username)}` : `/admin/streams/${id}`
}

/** The kind of overlay a customizer styles, as it appears in the address. */
export type OverlayKind = 'chat' | 'top-chatter' | 'cat' | 'like-target'

/**
 * A stream's customizer for one overlay, under the stream's own address.
 *
 * Styling belongs to a stream, so the customizer sits under the stream rather than
 * under a builder that would have to name the room some other way. The kind is a
 * path segment so each overlay is its own page — a link to "restyle my chat" is a
 * link to somewhere.
 */
export function customizerPath(username: string, id: string, kind: OverlayKind): string {
  return `${profilePath(username, id)}/overlay/${kind}`
}

/** A stream's giveaway picker, under the stream's own address. */
export function giveawayPath(username: string, id: string): string {
  return `${profilePath(username, id)}/giveaway`
}

/**
 * The overlay links for one stream, in full.
 *
 * Named rather than inlined because a link pasted into OBS is the product's
 * terminal action, and every page that offers one has to offer the same three. The
 * studio variant is the same page with a different parameter, which is why it looks
 * like a sibling here and is a separate link to whoever copies it.
 *
 * The cat is another visual option alongside the chat overlays, for when the streamer
 * wants something other than the standard chat cards.
 */
export function streamLinks(roomId: string) {
  return {
    original: api.chatOverlay(roomId),
    studio: api.chatOverlay(roomId, 'studio'),
    cat: api.catOverlay(roomId),
    topChatters: api.topChatterOverlay(roomId),
    likeTarget: api.likeTargetOverlay(roomId),
  }
}

/** The label each of those is offered under, in the order they are offered. */
export const LINK_LABELS = {
  original: 'Chat overlay · Original',
  studio: 'Chat overlay · Studio',
  cat: 'Kucing Pixel Stream',
  topChatters: 'Top Chatters',
  likeTarget: 'Target Likes',
} as const
