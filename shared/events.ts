/**
 * Shared WebSocket frame contract sent by the Python FastAPI backend
 * (/ws/overlay/{room_id}) and consumed by both app/ and web/ (docks, overlays).
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
  | ViewersFrame
  | StatusFrame
