import { emitLocal, type SidecarEvent } from '../lib/sidecar'

interface Props {
  open: boolean
  onClose: () => void
  inline?: boolean
}

const demoViewer = {
  nickname: 'Demo Viewer',
  id: 'demo_viewer',
  avatar: '',
}

/** Sends sample frames through the same local event path as the live bridge. */
export function SimulatorDialog({ open, onClose, inline = false }: Props) {
  if (!open) return null

  function send(event: SidecarEvent) {
    emitLocal(event)
  }

  function sample(type: 'chat' | 'gift' | 'like' | 'follow' | 'share' | 'join') {
    const timestamp = Date.now()
    const base = { platform: 'tiktok' as const, ...demoViewer, timestamp }

    switch (type) {
      case 'chat':
        send({ ...base, type, text: 'Hello from the event simulator!' })
        break
      case 'gift':
        send({ ...base, type, giftName: 'Rose', count: 1, diamonds: 1 })
        break
      case 'like':
        send({ ...base, type, count: 25 })
        break
      case 'follow':
      case 'share':
      case 'join':
        send({ ...base, type })
        break
    }
  }

  const actions = (
    <div className="simulator-actions">
      <button className="btn" onClick={() => sample('chat')}>Chat</button>
      <button className="btn" onClick={() => sample('gift')}>Gift</button>
      <button className="btn" onClick={() => sample('like')}>Like</button>
      <button className="btn" onClick={() => sample('follow')}>Follow</button>
      <button className="btn" onClick={() => sample('share')}>Share</button>
      <button className="btn" onClick={() => sample('join')}>Join</button>
    </div>
  )

  if (inline) {
    return (
      <main className="page-view simulator-page">
        <header className="page-view-head">
          <h1>Event simulator</h1>
          <p>Sample events appear in the feed. Nothing is sent to TikTok.</p>
        </header>
        {actions}
      </main>
    )
  }

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div
        className="modal simulator-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Event simulator"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2 className="modal-title">Event simulator</h2>
            <p className="muted simulator-hint">Sample events appear in the feed. Nothing is sent to TikTok.</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {actions}
      </div>
    </div>
  )
}
