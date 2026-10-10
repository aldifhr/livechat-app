/**
 * Wire format shared with the Rust host.
 *
 * The backend is the only producer of these shapes, and it arrives already mapped
 * onto them by src-tauri/src/backend.rs, so this mirrors that mapping rather than
 * saying anything about any protocol.
 */

export type FeedKind = 'chat' | 'gift' | 'like' | 'follow' | 'share' | 'join'

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
  /** Usernames this message is directed at. */
  mentions?: string[]
  /** Emoji images sent alongside the text. */
  emotes?: { url: string; id: string }[]
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
}

/**
 * What the app shows about the room.
 *
 * Was a map keyed by platform, because two rooms could be open at once and a
 * single status would have had to lie about one of them. With one room left there
 * is nothing to lie about.
 */
export interface RoomState {
  status: 'idle' | 'connecting' | 'connected' | 'error'
  message: string
  /** The streamer handle, as TikTok spells it. */
  target: string
  title: string
  viewers: number
}

export const IDLE_ROOM: RoomState = {
  status: 'idle',
  message: '',
  target: '',
  title: '',
  viewers: 0,
}