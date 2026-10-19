import { emitLocal, type SidecarEvent } from '../lib/sidecar'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'

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
      {(['chat', 'gift', 'like', 'follow', 'share', 'join'] as const).map((type) => (
        <Button
          key={type}
          variant="secondary"
          onClick={() => sample(type)}
          className="btn [padding:9px_14px] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)]"
        >
          {type[0].toUpperCase() + type.slice(1)}
        </Button>
      ))}
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
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogContent
        showCloseButton={false}
        aria-label="Event simulator"
        className="modal simulator-modal flex w-[min(460px,calc(100vw-40px))] max-w-[min(460px,calc(100vw-40px))] sm:max-w-[min(460px,calc(100vw-40px))] max-h-[90vh] flex-col gap-3 overflow-y-auto [scrollbar-width:thin] border border-[var(--line)] bg-[var(--panel)] p-[18px_20px] rounded-[var(--radius)] shadow-[0_12px_40px_rgba(0,0,0,0.5)]"
      >
        <DialogHeader className="modal-head flex-row items-center gap-[10px]">
          <div>
            <DialogTitle className="modal-title [margin:0] [font-size:16px] [font-weight:600]">Event simulator</DialogTitle>
            <DialogDescription className="muted simulator-hint [margin:4px_0_0] [font-size:12px]">Sample events appear in the feed. Nothing is sent to TikTok.</DialogDescription>
          </div>
          <Button variant="ghost" size="icon-xs" className="modal-close [ml-auto] [padding:2px_8px] [text-muted-foreground] [&:hover]:[color:var(--text)]" onClick={onClose} aria-label="Close">×</Button>
        </DialogHeader>

        {actions}
      </DialogContent>
    </Dialog>
  )
}
