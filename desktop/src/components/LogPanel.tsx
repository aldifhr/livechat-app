import { useEffect, useRef, useState } from 'react'
import { LogLine } from './LogLine'
import { AnimatedSpan, Terminal } from './ui/terminal'
import type { LogEntry } from '../hooks/useLog'

interface Props {
  entries: LogEntry[]
  tallies: Record<string, number>
  onClear: () => void
}

const LEVELS: ('all' | 'info' | 'warn' | 'error')[] = ['all', 'info', 'warn', 'error']

/**
 * The in-app log.
 *
 * Rendered as a full page from the Dock, with filters and clear controls in its
 * header.
 */
export function LogPanel({ entries, tallies, onClear }: Props) {
  const [level, setLevel] = useState<'all' | 'info' | 'warn' | 'error'>('all')
  const listRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  const errors = (tallies.__error ?? 0) + entries.filter((e) => e.level === 'error').length

  useEffect(() => {
    const node = listRef.current
    if (!node || !pinned.current) return
    node.scrollTop = node.scrollHeight
  }, [entries])

  // `warn` includes errors, since a reader who wants warnings wants to see what
  // went wrong too. Every other level is an exact match.
  const visible =
    level === 'all'
      ? entries
      : level === 'warn'
        ? entries.filter((entry) => entry.level === 'warn' || entry.level === 'error')
        : entries.filter((entry) => entry.level === level)

  return (
    <div className="log-panel [flex:0_0_auto] [background:var(--panel)] [border-top:1px_solid_var(--line)]">
      <div className="log-bar [display:flex] [align-items:center] [gap:10px] [padding:7px_20px]">
        <span className="log-title [color:var(--text)] [font-size:12px] [font-weight:600]">Event log</span>

        {entries.length > 0 && <span className="log-count [padding:0_6px] [background:var(--panel-2)] [border-radius:999px] [color:var(--muted)] [font-size:11px] [font-variant-numeric:tabular-nums]">{entries.length}</span>}
        {errors > 0 && <span className="log-badge [padding:1px_8px] [background:var(--accent-soft)] [border-radius:999px] [color:var(--accent)] [font-size:11px] [font-weight:600]">{errors} error{errors === 1 ? '' : 's'}</span>}

        <div className="log-filters [display:flex] [gap:4px] [margin-left:auto]">
          {LEVELS.map((value) => (
            <button
              key={value}
              className={`chip chip-small [display:inline-flex] [align-items:center] [gap:6px] [padding:6px_11px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:999px] [color:var(--muted)] [font:inherit] [font-size:13px] [cursor:pointer] [&:hover]:[color:var(--text)] [padding:3px_8px] [font-size:11px]${level === value ? ' chip-active' : ''}`}
              onClick={() => setLevel(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <button className="btn btn-small [padding:9px_14px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [cursor:pointer] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)] [&:disabled]:[opacity:0.45] [&:disabled]:[cursor:not-allowed] [padding:4px_10px] [font-size:12px]" onClick={onClear} disabled={entries.length === 0}>
          Clear
        </button>
      </div>

      <div
        className="log-list [flex:1_1_auto] [min-height:120px] [max-height:190px] [overflow-y:auto] [padding:0] [border-top:1px_solid_var(--line)] [scrollbar-width:thin] [font-family:'Cascadia_Mono',_Consolas,_'SF_Mono',_Menlo,_monospace] [font-size:11.5px]"
        ref={listRef}
        onScroll={(e) => {
          const node = e.currentTarget
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
        }}
      >
        <Terminal sequence={false} startOnView={false} className="event-terminal [width:100%] [height:auto] [max-width:none] [max-height:none] [min-height:100%] [border:0] [border-radius:0] [background:transparent] [&_>_div:first-child]:[flex:0_0_auto] [&_>_div:first-child]:[padding:9px_14px] [&_>_div:first-child]:[border-bottom:1px_solid_var(--line)] [&_pre]:[flex:1_1_auto] [&_pre]:[min-height:0] [&_pre]:[margin:0] [&_pre]:[overflow:visible] [&_pre]:[padding:10px_14px] [&_pre]:[white-space:pre-wrap] [&_code]:[overflow:visible] [&_code]:[white-space:normal]">
          {visible.length === 0 ? (
            <AnimatedSpan className="event-terminal-empty [color:var(--muted)]">Nothing logged yet.</AnimatedSpan>
          ) : (
            visible.map((entry) => (
              <AnimatedSpan key={entry.key} className="event-terminal-entry [min-width:0]">
                <LogLine entry={entry} />
              </AnimatedSpan>
            ))
          )}
        </Terminal>
      </div>
    </div>
  )
}
