/**
 * The webhook contract, as the page sees it.
 *
 * Mirrors `WebhookConfig` in src-tauri/src/webhook.rs. Duplicated rather than
 * imported across the wire because `types.ts` is the vocabulary the UI is written
 * against, and it should not depend on the Rust side to say so.
 */

export interface WebhookConfig {
  /** Whether gifts are sent at all. Off by default. */
  enabled: boolean
  /** The receiving URL. */
  url: string
  /** Sent as `Authorization: Bearer <token>`. Empty sends no header. */
  token: string
}

export const EMPTY_WEBHOOK: WebhookConfig = { enabled: false, url: '', token: '' }

/**
 * The URL the settings box starts with.
 *
 * The app's own backend, which already exposes routes a webhook would post to — so
 * the common case is a URL that already works and the user only edits it when they
 * want somewhere else. Mirrors `EXAMPLE_URL` in webhook.rs.
 */
export const EXAMPLE_WEBHOOK_URL = 'https://kit-backend.aldifhr.my.id'

/** Whether there is enough filled in to be worth spending a request on. */
export function isWebhookReady(config: WebhookConfig): boolean {
  return config.url.trim() !== ''
}

/**
 * One gift, as it is posted.
 *
 * Mirrors `GiftPayload` in src-tauri/src/webhook.rs, field for field and case for
 * case — camelCase, because a struct that quietly answers in another case parses to
 * nothing on the far side and the sender never finds out.
 */
export interface WebhookGift {
  nickname: string
  userId: string
  giftName: string
  count: number
  diamonds: number
  timestamp: number
}
