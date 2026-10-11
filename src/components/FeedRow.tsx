import { memo } from 'react'
import { kindLabel } from '../hooks/useFeed'
import { mentionsMe } from '../lib/mentions'
import type { FeedItem } from '../types'

/**
 * One feed row.
 *
 * Memoised because a busy room re-renders the list hundreds of times a minute
 * and only the newest rows actually changed — comparing on the fields that
 * render keeps the rest from re-rendering at all.
 */

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function describe(item: FeedItem): string {
  switch (item.kind) {
    case 'gift':
      return `sent ${item.giftName} x${item.count ?? 1}`
    case 'like':
      return `liked the stream x${item.count ?? 1}`
    case 'join':
      return 'joined the stream'
    default:
      return kindLabel(item.kind)
  }
}

interface Props {
  item: FeedItem
  /** The newest row, highlighted and used as the scroll anchor. */
  isLast: boolean
  /** Usernames that count as "you" when deciding whether a mention is for this reader. */
  myNames?: string[]
}

/**
 * Whether a mention names this reader.
 *
 * The rule itself lives in `lib/mentions` and is shared with the alert hook: one
 * rule, one normalisation. A second copy here drifted from it — it did not trim,
 * so `" ana "` highlighted through the alert path but not in the feed.
 */
function mentionsSomebody(item: FeedItem, myNames: string[]): boolean {
  return mentionsMe(item.mentions, myNames)
}

function FeedRowImpl({ item, isLast, myNames }: Props) {
  const repeat = item.repeatCount ?? 1
  const mentioned = mentionsSomebody(item, myNames ?? [])

  return (
    <div className={`row row-${item.kind}${isLast ? ' row-new' : ''}`}>
      {item.avatar ? (
        <img className="avatar" src={item.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <div className="avatar avatar-fallback" aria-hidden="true">
          {(item.nickname.trim()[0] ?? '?').toUpperCase()}
        </div>
      )}

      <div className="row-body">
        <div className="row-head">
          <span className="nickname">{item.nickname || 'Room'}</span>
          {item.isModerator && (
            <span className="badge-mod" title="Room moderator">
              MOD
            </span>
          )}
          {item.isFiltered && (
            <span className="badge-filtered" title="Filtered by TikTok">
              filtered
            </span>
          )}
          {item.isBot && (
            <span className="badge-bot" title="Automatic reply">
              auto
            </span>
          )}
          <span className="time">{formatTime(item.timestamp)}</span>
        </div>

        {item.kind === 'chat' || item.kind === 'ask' || item.kind === 'answer' ? (
          <>
            <p className={`text${mentioned ? ' text-mention' : ''}`}>{item.text}</p>
            {item.emotes && item.emotes.length > 0 && (
              <div className="emotes">
                {item.emotes.map((emote) => (
                  <img
                    key={emote.id || emote.url}
                    className="emote"
                    src={emote.url}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="event">
            {item.giftImage && (
              <img
                className="gift-image"
                src={item.giftImage}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            )}
            <span className="event-label">{describe(item)}</span>
            {item.kind === 'gift' && (item.diamonds ?? 0) > 0 && (
              <span className="diamonds">{item.diamonds} diamonds</span>
            )}
          </p>
        )}

        {repeat > 1 && <span className="repeat">x{repeat}</span>}
      </div>
    </div>
  )
}

export const FeedRow = memo(
  FeedRowImpl,
  (previous, next) =>
    previous.isLast === next.isLast &&
    previous.item.repeatCount === next.item.repeatCount &&
    previous.item.kind === next.item.kind &&
    previous.item.platform === next.item.platform &&
    previous.item.text === next.item.text &&
    previous.item.giftName === next.item.giftName &&
    previous.item.giftImage === next.item.giftImage &&
    previous.item.count === next.item.count &&
    previous.item.nickname === next.item.nickname &&
    previous.item.avatar === next.item.avatar &&
    previous.item.isModerator === next.item.isModerator &&
    previous.item.isFiltered === next.item.isFiltered &&
    previous.item.emotes === next.item.emotes &&
    // The highlight, not the row: without this, editing "My handles" in settings
    // left every already-painted row showing the old answer, so the highlight
    // only appeared on rows that changed for some unrelated reason.
    mentionsSomebody(previous.item, previous.myNames ?? []) ===
      mentionsSomebody(next.item, next.myNames ?? []),
)