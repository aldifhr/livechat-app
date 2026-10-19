/**
 * Wire format shared with the Rust host.
 *
 * The backend is the only producer of these shapes, and it arrives already mapped
 * onto them by src-tauri/src/backend.rs, so this mirrors that mapping rather than
 * saying anything about any protocol.
 */

export type FeedKind =
  | 'chat'
  | 'gift'
  | 'like'
  | 'follow'
  | 'share'
  | 'join'
  | 'intro'
  | 'notice'
  | 'subscription'
  | 'poll'

/**
 * Which room a row came from.
 *
 * Duplicated from the bridge's type rather than imported: `types.ts` is the
 * vocabulary the UI is written against, and it should not depend on the transport
 * module to say so.
 *
 * One room today. The bridge still stamps every frame with it, because that is
 * what lets a second platform be added without changing the wire shape.
 */
export type Platform = 'tiktok'

export interface Viewer {
  nickname: string
  /** The platform's stable per-person handle. A nickname can change and is not unique. */
  id: string
  avatar: string
}

export interface FeedItem extends Viewer {
  /** Unique per row, for React keys. Distinct from `id`, which is the viewer's. */
  key: string
  /** Both platforms can be live at once, so a row has to say where it came from. */
  platform: Platform
  kind: FeedKind
  timestamp: number
  /** TikTok marked this viewer as a room moderator. */
  isModerator?: boolean
  /** TikTok has filtered this message itself; it is usually noise. */
  isFiltered?: boolean
  /** Emoji images sent alongside the text. */
  emotes?: { url: string; id: string }[]
  /**
   * This row was written by the app, not a viewer — an auto-reply to a greeting.
   *
   * Optional rather than always-set because the overwhelming majority of rows are
   * real messages, and a flag that is false on almost every row should be absent
   * rather than carried. The renderer uses it to mark the row so a bot reply is
   * never mistaken for a viewer saying something.
   */
  isBot?: boolean
  /** Absent on chat events. */
  text?: string
  giftName?: string
  /**
   * Picture of the gift, when the platform sent one.
   *
   * Optional rather than empty-string-by-default: a gift can arrive with no
   * catalogue entry to name it, and an empty string would have to be told apart
   * from a missing key at every render site.
   */
  giftImage?: string
  /** Absent on chat events. */
  count?: number
  /** Diamonds only make sense on gifts. */
  diamonds?: number
  /** How many identical events in a row this row stands for. */
  repeatCount?: number
  /** The stream title, on an `intro` row. */
  title?: string
  /** Total months subscribed, on a `subscription` row. */
  months?: number
  /** Poll options, on a `poll` row. */
  options?: string[]
}

/**
 * What the app shows about the room.
 *
 * Was a map keyed by platform, because two rooms could be open at once and a
 * single status would have had to lie about one of them. With one room left there
 * is nothing to lie about.
 */
export interface RoomState {
  /**
   * `ended` is its own state rather than a flavour of `error`: the live finished
   * and nothing is wrong, which is the one outcome where the right thing to do
   * next is to stop rather than retry. Folding it into `error` would put a red
   * badge on a normal event.
   *
   * `waiting` is its own state for the same reason, in the other direction: the
   * backend is polling for a streamer who has no live right now, so there is
   * nothing to read and nothing wrong. It must not be `connecting` — that offers
   * a disabled "Connecting…" button for a wait that can last two hours, leaving
   * no way to call it off — and it must not be `ended`, because this streamer has
   * not been live, so nothing has ended.
   */
  status: 'idle' | 'connecting' | 'waiting' | 'connected' | 'ended' | 'error'
  message: string
  /** The streamer handle, as TikTok spells it. */
  target: string
  /**
   * The backend's id for this room, once it is known.
   *
   * Empty until a room frame arrives. The overlay link prefers it over the handle:
   * a link naming the room by id is one parameter nothing has to resolve, where a
   * handle is something the page turns into an id on every load.
   */
  id: string
  title: string
  viewers: number
}

export const IDLE_ROOM: RoomState = {
  status: 'idle',
  message: '',
  target: '',
  id: '',
  title: '',
  viewers: 0,
}
