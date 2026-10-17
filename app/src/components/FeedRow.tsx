import { memo, useState } from 'react'
import { kindLabel } from '../hooks/useFeed'
import { tiktokProfileUrl } from '../lib/platforms'
import { host } from '../lib/sidecar'
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
    case 'share':
      // Only when it is more than one. TikTok reports how many viewers a share
      // brought in, and `x1` on every ordinary share is noise — but a share that
      // brought four people is worth saying, and the number only reaches here now
      // that the bridge passes it on.
      return (item.count ?? 1) > 1
        ? `shared the stream · ${item.count} joined`
        : kindLabel(item.kind)
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
}

/**
 * A viewer's name, linked to their profile when there is one to link to.
 *
 * A plain span when the name cannot be a username. That is not an edge case being
 * defended against — display names are free text, and a name in Arabic or Devanagari
 * or Thai turns into a long percent-encoded URL for an account that does not exist.
 * The name still shows; it just is not dressed as a link, because a control that
 * always fails is worse than a word.
 */
function Nickname({ name, handle }: { name: string; handle: string }) {
  const url = tiktokProfileUrl(handle)
  if (!url) return <span className="nickname">{name}</span>

  return (
    <button
      type="button"
      className="nickname nickname-link"
      title={`Open @${name} on TikTok`}
      onClick={() => {
        void host.openStream(url).catch(() => {
          // The host refuses anything but TikTok, and a profile URL is TikTok — so
          // a failure here is the browser, not the rule, and there is nothing the
          // row can do about it.
        })
      }}
    >
      {name}
    </button>
  )
}

function FeedRowImpl({ item, isLast }: Props) {
  const repeat = item.repeatCount ?? 1
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copyMessage() {
    if (item.kind !== 'chat') return
    try {
      await navigator.clipboard.writeText(`${item.nickname || 'Viewer'}: ${item.text}`)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

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
          {/* The name is a link to the viewer's TikTok profile — the one thing on a
              chat row worth following up on. Opened through the host, not a plain
              anchor: the webview's content security policy will not navigate, so an
              <a href> would do nothing.

              Not every name is a username. The stable handle is used when there is
              one, and the display name otherwise, and a display name can be free
              text in any script. So the URL is built by the platform's rule and comes
              back empty when the name cannot be a username at all — a row whose name
              is `℘กัॐ…` has no profile, and a link that is certain to fail is worse
              than a name that is plainly not a link. */}
          <Nickname name={item.nickname || 'Room'} handle={item.id || item.nickname || ''} />
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
          {item.kind === 'chat' && (
            <button
              className={`copy-message-btn${copyState === 'copied' ? ' is-copied' : ''}`}
              type="button"
              title={copyState === 'copied' ? 'Message copied' : copyState === 'failed' ? 'Could not copy message' : 'Copy message'}
              aria-label={copyState === 'copied' ? 'Message copied' : 'Copy message'}
              onClick={() => void copyMessage()}
            >
              {copyState === 'copied' ? '✓' : '⧉'}
            </button>
          )}
        </div>

        {item.kind === 'chat' ? (
          <>
            <p className="text">{item.text}</p>
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
    // Compared by identity: `mark` replaces the object rather than editing one, so
    previous.item.emotes === next.item.emotes,
)
