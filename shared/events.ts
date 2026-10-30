/**
 * Shared WebSocket frame contract sent by the Python FastAPI backend
 * (/ws/overlay/{room_id}) and consumed by the web dashboard and overlay pages.
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
  /** The stream itself finished, rather than the socket dropping. A dropped
   *  socket is worth reconnecting; a finished live is not, and the two look
   *  identical from the event stream alone. Sent only when true, so a plain
   *  status frame is unchanged on the wire. */
  liveEnded?: boolean
  /** The backend is polling for a streamer who has no live right now, which
   *  can last up to two hours. Distinct from `connecting`, which means a
   *  handshake is in flight. Also sent only when true. */
  waiting?: boolean
}

/** A viewer shared the stream. Carries a count because TikTok reports a total. */
export interface ShareFrame extends BaseUserFrame {
  type: 'share'
  count?: number
}

/**
 * A room-wide alert, which is how the backend surfaces something that is not a
 * viewer action: a donation, or an unhandled event kind it wants visible while
 * developing rather than dropped.
 *
 * `user` is absent by design — an alert is not from a person, so a consumer
 * must not read a name off one.
 */
export interface AlertFrame {
  type: 'alert'
  title: string
  text: string
  icon?: string
  /** A donation amount, when the alert carries one. Present only when the
   *  backend had one, so a plain alert is unchanged on the wire. */
  amount?: number
}

/** A backend-side error, broadcast to the room rather than raised at a caller. */
export interface ErrorFrame {
  type: 'error'
  message: string
}

/** A room's styling, pushed to every overlay already watching it. */
export interface ConfigFrame {
  type: 'config'
  config: Record<string, unknown>
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
  | ShareFrame
  | AlertFrame
  | StatusFrame
  | ErrorFrame
  | ConfigFrame
