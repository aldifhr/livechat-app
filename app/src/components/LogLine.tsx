import { memo } from 'react'
import type { LogEntry } from '../hooks/useLog'

/**
 * One line in the log panel.
 *
 * Memoised because the panel appends to the end of a list that can hold hundreds
 * of rows: without it, every new line would re-render all of them.
 */

function clock(timestamp: number): string {
  // Padded to two digits per field so consecutive lines line up in the panel's
  // monospace column. Locales that put the hour first or use a dot separator
  // would break that alignment, so the parts are formatted rather than taking
  // whatever `toLocaleTimeString` produces.
  const d = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
}

function FeedRowImpl({ entry }: { entry: LogEntry }) {
  return (
    <div className={`log-line log-${entry.level} [display:flex] [gap:9px] [padding:2px_0] [line-height:1.45] [&.log-warn_.log-level]:[color:var(--gold)] [&.log-error_.log-level]:[color:var(--accent)]`}>
      <span className="log-time [flex:0_0_auto] [color:var(--muted)] [font-variant-numeric:tabular-nums]">{clock(entry.at)}</span>
      <span className="log-level [flex:0_0_auto] [width:42px] [text-transform:uppercase] [font-size:10px] [letter-spacing:0.04em] [padding-top:1px] [color:var(--muted)]">{entry.level}</span>
      <span className="log-message [min-width:0] [overflow-wrap:anywhere] [color:var(--text)]">{entry.message}</span>
    </div>
  )
}

export const LogLine = memo(
  FeedRowImpl,
  (previous, next) => previous.entry === next.entry,
)
