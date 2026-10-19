import { memo, useState } from 'react'
import { kindLabel } from '../hooks/useFeed'
import { tiktokProfileUrl } from '../lib/platforms'
import { host } from '../lib/sidecar'
import type { FeedItem } from '../types'
import { Badge } from './ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { Bubble, BubbleContent } from './ui/bubble'

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
    case 'intro':
      // The title is the whole content of this row; `describe` is what the row
      // says beside the name, and the name is the streamer.
      return item.title ? `went live · ${item.title}` : 'went live'
    case 'subscription':
      // Total months, not the increment — `x1` and `x12` are the same row shape,
      // and saying "renewed" for both would hide the difference.
      return (item.months ?? 0) > 1
        ? `subscribed · month ${item.months}`
        : 'subscribed'
    case 'poll':
      return item.options?.length
        ? `started a poll · ${item.options.length} options`
        : 'started a poll'
    default:
      return kindLabel(item.kind)
  }
}

interface Props {
  item: FeedItem
  /** The newest row, highlighted and used as the scroll anchor. */
  isLast: boolean
}

const bubbleContentClass = 'chat-bubble-content rounded-[3px_14px_14px_14px] border-[color-mix(in_srgb,var(--line)_55%,transparent)] px-3 py-1.5 text-[length:inherit] leading-[inherit] shadow-sm'

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
  if (!url) return <span className="nickname [font-size:inherit] [font-weight:600] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">{name}</span>

  return (
    <button
      type="button"
      className="nickname nickname-link [font-size:inherit] [font-weight:600] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap] [padding:0] [border:0] [background:none] [font:inherit] [color:inherit] [cursor:pointer] [text-align:left] [&:hover]:[text-decoration:underline]"
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

function ViewerAvatar({ avatar, name, handle }: { avatar: string; name: string; handle: string }) {
  const image = (
    <Avatar className="avatar [width:32px] [height:32px] [background:var(--panel-2)] [flex:0_0_auto]">
      {avatar && <AvatarImage src={avatar} alt="" loading="lazy" referrerPolicy="no-referrer" />}
      <AvatarFallback className="avatar-fallback [background:var(--panel-2)] [font-weight:600] [color:var(--muted)]" aria-hidden="true">
        {(name.trim()[0] ?? '?').toUpperCase()}
      </AvatarFallback>
    </Avatar>
  )
  const url = tiktokProfileUrl(handle)
  if (!url) return image

  return (
    <button
      type="button"
      className="profile-avatar-button [width:32px] [height:32px] [flex:0_0_auto] [padding:0] [border:0] [border-radius:50%] [background:transparent] [cursor:pointer] [&:focus-visible]:[outline:2px_solid_var(--accent)]"
      title={`Open @${name} on TikTok`}
      aria-label={`Open @${name} on TikTok`}
      onClick={() => { void host.openStream(url).catch(() => {}) }}
    >
      {image}
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
    <div className={`row row-${item.kind} [display:flex] [gap:var(--gap,_10px)] [padding:var(--pad-y,_7px)_var(--pad-x,_10px)] [border-radius:var(--radius)] [&:hover_.copy-message-btn]:[opacity:1]${isLast ? ' row-new' : ''}`}>
      <ViewerAvatar avatar={item.avatar} name={item.nickname || 'Viewer'} handle={item.id || item.nickname || ''} />

      <div className="row-body [min-width:0] [flex:1] [position:relative]">
        <div className="row-head [&_.room-tag]:[min-width:20px] [&_.room-tag]:[padding:1px_4px] [&_.room-tag]:[font-size:9px] [display:flex] [align-items:baseline] [gap:8px]">
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
            <Badge variant="secondary" className="badge-mod [flex:0_0_auto] [padding:1px_5px] [border-radius:4px] [background:rgba(61,_220,_132,_0.18)] [color:var(--green)] [font-size:9px] [font-weight:700] [letter-spacing:0.04em]" title="Room moderator">
              MOD
            </Badge>
          )}
          {item.isFiltered && (
            <Badge variant="outline" className="badge-filtered [flex:0_0_auto] [padding:1px_5px] [border-radius:4px] [background:var(--panel-2)] [color:var(--muted)] [font-size:9px]" title="Filtered by TikTok">
              filtered
            </Badge>
          )}
{item.isBot && (
            <Badge variant="secondary" className="badge-bot [flex:0_0_auto] [padding:1px_5px] [border-radius:4px] [background:rgba(120,_160,_255,_0.18)] [color:var(--accent,_#7aa0ff)] [font-size:9px] [font-weight:700] [letter-spacing:0.04em]" title="Automatic reply">
              auto
            </Badge>
          )}
          <span className="time [font-size:inherit] [flex:0_0_auto] [color:var(--muted)] [font-size:11px] [font-variant-numeric:tabular-nums]">{formatTime(item.timestamp)}</span>
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
          <Bubble variant="secondary" className="mt-1 max-w-[min(100%,48ch)]">
            <BubbleContent className={bubbleContentClass}>
              <p className="text chat-message-text m-0 w-full [font-size:inherit] [overflow-wrap:anywhere]">{item.text}</p>
              {item.emotes && item.emotes.length > 0 && (
                <div className="emotes [display:flex] [gap:4px]">
                  {item.emotes.map((emote) => (
                    <img
                      key={emote.id || emote.url}
                      className="emote [width:22px] [height:22px] [object-fit:contain]"
                      src={emote.url}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ))}
                </div>
              )}
            </BubbleContent>
          </Bubble>
        ) : (
          <Bubble variant="secondary" className="mt-1 max-w-[min(100%,48ch)]">
            <BubbleContent className={bubbleContentClass}>
              <p className="event m-0 [font-size:inherit] [display:flex] [align-items:center] [gap:8px] [flex-wrap:wrap]">
                {item.giftImage && (
                  <img
                    className="gift-image [flex:0_0_auto] [width:20px] [height:20px] [object-fit:contain] [vertical-align:middle] [border-radius:4px]"
                    src={item.giftImage}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                )}
                <span className={`event-label ${item.kind === 'gift' ? 'text-app-gold' : item.kind === 'join' ? 'text-app-green' : item.kind === 'follow' ? 'text-app-follow' : item.kind === 'share' ? 'text-app-share' : item.kind === 'like' ? 'text-red-500' : 'text-app-muted'}`}>
                  {item.kind === 'like' && <span aria-hidden="true">👍 </span>}
                  {describe(item)}
                </span>
                {item.kind === 'gift' && (item.diamonds ?? 0) > 0 && (
                  <Badge variant="secondary" className="diamonds [padding:1px_7px] [background:rgba(245,_196,_81,_0.14)] [border-radius:999px] [color:var(--gold)] [font-size:12px] [font-variant-numeric:tabular-nums]">{item.diamonds} diamonds</Badge>
                )}
              </p>
            </BubbleContent>
          </Bubble>
        )}

        {repeat > 1 && <span className="repeat [position:absolute] [right:8px] [top:6px] [padding:1px_7px] [background:var(--accent)] [border-radius:999px] [color:var(--bg)] [font-size:11px] [font-weight:600]">x{repeat}</span>}
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
