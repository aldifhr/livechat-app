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
    <div className="simulator-actions [display:flex] [flex-wrap:wrap] [gap:8px]">
      <button className="btn [padding:9px_14px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [cursor:pointer] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)] [&:disabled]:[opacity:0.45] [&:disabled]:[cursor:not-allowed]" onClick={() => sample('chat')}>Chat</button>
      <button className="btn [padding:9px_14px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [cursor:pointer] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)] [&:disabled]:[opacity:0.45] [&:disabled]:[cursor:not-allowed]" onClick={() => sample('gift')}>Gift</button>
      <button className="btn [padding:9px_14px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [cursor:pointer] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)] [&:disabled]:[opacity:0.45] [&:disabled]:[cursor:not-allowed]" onClick={() => sample('like')}>Like</button>
      <button className="btn [padding:9px_14px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [cursor:pointer] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)] [&:disabled]:[opacity:0.45] [&:disabled]:[cursor:not-allowed]" onClick={() => sample('follow')}>Follow</button>
      <button className="btn [padding:9px_14px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [cursor:pointer] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)] [&:disabled]:[opacity:0.45] [&:disabled]:[cursor:not-allowed]" onClick={() => sample('share')}>Share</button>
      <button className="btn [padding:9px_14px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [cursor:pointer] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)] [&:disabled]:[opacity:0.45] [&:disabled]:[cursor:not-allowed]" onClick={() => sample('join')}>Join</button>
    </div>
  )

  if (inline) {
    return (
      <main className="page-view simulator-page [flex:1_1_auto] [min-height:0] [overflow:auto] [padding:20px] [&_.stats-panel]:[width:min(900px,_100%)] [&_.stats-panel]:[margin:0_auto] [&_.stats-panel]:[border:1px_solid_var(--line)] [&_.stats-panel]:[border-radius:var(--radius)] [&_.log-panel]:[width:min(900px,_100%)] [&_.log-panel]:[margin:0_auto] [&_.log-panel]:[border:1px_solid_var(--line)] [&_.log-panel]:[border-radius:var(--radius)] [&_.stats-body]:[max-height:none] [&_.stats-body]:[overflow:visible] [&_.log-panel]:[display:flex] [&_.log-panel]:[min-height:180px] [&_.log-panel]:[flex-direction:column] [&_.log-list]:[flex:1_1_auto] [&_.log-list]:[max-height:none] [&_.log-list]:[min-height:120px]">
        <header className="page-view-head [margin:0_auto_18px] [width:min(900px,_100%)] [&_h1]:[margin:0] [&_h1]:[font-size:20px] [&_p]:[margin:4px_0_0] [&_p]:[color:var(--muted)] [&_p]:[font-size:12px]">
          <h1>Event simulator</h1>
          <p>Sample events appear in the feed. Nothing is sent to TikTok.</p>
        </header>
        {actions}
      </main>
    )
  }

  return (
    <div className="modal-scrim [position:fixed] [inset:0] [z-index:10] [display:grid] [place-items:center] [padding:20px] [background:rgba(0,_0,_0,_0.6)]" onClick={onClose} role="presentation">
      <div
        className="modal simulator-modal [width:min(440px,_100%)] [max-height:90vh] [overflow-y:auto] [scrollbar-width:thin] [display:flex] [flex-direction:column] [gap:12px] [padding:18px_20px] [background:var(--panel)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [box-shadow:0_12px_40px_rgba(0,_0,_0,_0.5)] [width:min(460px,_100%)]"
        role="dialog"
        aria-modal="true"
        aria-label="Event simulator"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head [display:flex] [align-items:center] [gap:10px]">
          <div>
            <h2 className="modal-title [margin:0] [font-size:16px] [font-weight:600]">Event simulator</h2>
            <p className="muted simulator-hint [margin:4px_0_0] [font-size:12px]">Sample events appear in the feed. Nothing is sent to TikTok.</p>
          </div>
          <button className="modal-close [margin-left:auto] [padding:2px_8px] [background:none] [border:0] [color:var(--muted)] [font:inherit] [font-size:13px] [cursor:pointer] [&:hover]:[color:var(--text)]" onClick={onClose} aria-label="Close">×</button>
        </div>

        {actions}
      </div>
    </div>
  )
}
