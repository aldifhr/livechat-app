import { useEffect } from 'react'
import { host } from '../lib/sidecar'
import { useShowcase, type Card } from '../hooks/useShowcase'

/**
 * The overlay window.
 *
 * A transparent, always-on-top window that puts gifts and like bursts over the
 * stream. It reads the same frames the main window does — the bridge emits to
 * every webview at once — but renders a different thing from them, so it never
 * has to agree with the main window about filters or about which rows are new.
 */

export default function Overlay() {
  const { cards, viewers } = useShowcase()

  // The host drives this window's position and size; it must not decide to close
  // it when the app's own logic says there is nothing to show. Closing only ever
  // happens because the user asked.
  useEffect(() => {
    document.body.classList.add('overlay-body')
    return () => document.body.classList.remove('overlay-body')
  }, [])

  const live = viewers > 0

  return (
    <div className="overlay">
      <div className="overlay-bar" data-tauri-drag-region>
        {live && <span className="overlay-room">{viewers.toLocaleString()} watching</span>}
        <button
          className="overlay-close"
          title="Hide the overlay"
          aria-label="Hide the overlay"
          onClick={() => {
            host.setOverlayVisible(false).catch(() => {
              // Nothing to report: the toolbar toggle is right there.
            })
          }}
        >
          ✕
        </button>
      </div>

      <div className="overlay-cards">
        {cards.length === 0 ? (
          <p className="overlay-idle">Waiting for gifts…</p>
        ) : (
          cards.map((card) => <CardView key={card.key} card={card} />)
        )}
      </div>
    </div>
  )
}

function CardView({ card }: { card: Card }) {
  return (
    <div className="overlay-card overlay-card-${card.kind}">
      {card.avatar ? (
        <img className="overlay-avatar" src={card.avatar} alt="" referrerPolicy="no-referrer" />
      ) : (
        <span className="overlay-avatar overlay-fallback" aria-hidden="true">
          {(card.nickname.trim()[0] ?? '?').toUpperCase()}
        </span>
      )}

      <div className="overlay-body">
        <div className="overlay-nick">{card.nickname || 'Room'}</div>
        <div className="overlay-line">
          {card.kind === 'gift' ? (
            <>
              {card.image && (
                <img className="overlay-gift-image" src={card.image} alt="" referrerPolicy="no-referrer" />
              )}
              <span className="overlay-gift">{card.label}</span>
              {card.count > 1 && <span className="overlay-x">×{card.count}</span>}
            </>
          ) : (
            <span className="overlay-likes">{card.count.toLocaleString()} likes</span>
          )}
        </div>
      </div>

      {card.diamonds > 0 && <div className="overlay-diamonds">{card.diamonds.toLocaleString()} ◆</div>}
    </div>
  )
}