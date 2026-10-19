/**
 * Shared WebSocket frame contract sent by the Python FastAPI backend
 * (/ws/overlay/{room_id}) and consumed by both desktop/ and web/ (docks, overlays).
 */

export interface EmoteItem {
  id?: string
  url: string
}

export interface BaseUserFrame {
  user: string
  userId?: string
  avatar?: string
}

export interface CommentFrame extends BaseUserFrame {
  type: 'comment'
  text: string
  emotes?: EmoteItem[]
  isModerator?: boolean
  mentions?: string[]
}

export interface GiftFrame extends BaseUserFrame {
  type: 'gift'
  giftName: string
  count?: number
  value?: number
  giftImage?: string
  diamonds?: number
}

export interface LikeFrame extends BaseUserFrame {
  type: 'like'
  count?: number
  totalLikes?: number
}

export interface JoinFrame extends BaseUserFrame {
  type: 'join'
  viewers?: number
}

export interface FollowFrame extends BaseUserFrame {
  type: 'follow'
}

/** The stream's own title, sent once per session. */
export interface IntroFrame extends BaseUserFrame {
  type: 'intro'
  title: string
}

/**
 * A room-wide notice from TikTok rather than a viewer.
 *
 * `user` is present only when the notice came from a person, so a consumer must
 * not assume a name here — an empty string is the ordinary case.
 */
export interface NoticeFrame {
  type: 'notice'
  text: string
  user?: string
  source?: string
}

export interface SubscriptionFrame extends BaseUserFrame {
  type: 'subscription'
  /** Total months subscribed, not the increment. */
  months?: number
  isSend?: boolean
  isCustom?: boolean
}

export interface PollFrame {
  type: 'poll'
  pollId?: string
  question: string
  options?: string[]
  state?: string
}

export interface ViewersFrame {
  type: 'viewers'
  count: number
}

export interface StatusFrame {
  type: 'status'
  connected?: boolean
  connecting?: boolean
  viewers?: number
  message?: string
}

export type OverlayEventFrame =
  | CommentFrame
  | GiftFrame
  | LikeFrame
  | JoinFrame
  | FollowFrame
  | IntroFrame
  | NoticeFrame
  | SubscriptionFrame
  | PollFrame
  | ViewersFrame
  | StatusFrame
