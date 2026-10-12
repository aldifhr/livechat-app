import { useEffect, useRef, useState } from 'react'
import { LogLine } from './LogLine'
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
 * Collapsed by default so it does not compete with the chat, but one click from
 * there when a stream stops updating and the reason is not on the status line.
 */
export function LogPanel({ entries, tallies, onClear }: Props) {
  const [open, setOpen] = useState(false)
  const [level, setLevel] = useState<'all' | 'info' | 'warn' | 'error'>('all')
  const listRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  const errors = (tallies.__error ?? 0) + entries.filter((e) => e.level === 'error').length

  useEffect(() => {
    const node = listRef.current
    if (!node || !pinned.current) return
    node.scrollTop = node.scrollHeight
  }, [entries, open])

  // `warn` includes errors, since a reader who wants warnings wants to see what
  // went wrong too. Every other level is an exact match.
  const visible =
    level === 'all'
      ? entries
      : level === 'warn'
        ? entries.filter((entry) => entry.level === 'warn' || entry.level === 'error')
        : entries.filter((entry) => entry.level === level)

  return (
    <div className={`log-panel${open ? ' log-open' : ''}`}>
      <div className="log-bar">
        <button className="log-toggle" onClick={() => setOpen((value) => !value)}>
          <span className={`log-caret${open ? ' log-caret-open' : ''}`}>▸</span>
          Log
        </button>

        {entries.length > 0 && <span className="log-count">{entries.length}</span>}
        {errors > 0 && <span className="log-badge">{errors} error{errors === 1 ? '' : 's'}</span>}

        {open && (
          <>
            <div className="log-filters">
              {LEVELS.map((value) => (
                <button
                  key={value}
                  className={`chip chip-small${level === value ? ' chip-active' : ''}`}
                  onClick={() => setLevel(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            {/* Disabled rather than hidden when there is nothing to clear: the
                button keeps its position, so the bar does not reflow under the
                pointer every time the last line is removed. */}
            <button className="btn btn-small" onClick={onClear} disabled={entries.length === 0}>
              Clear
            </button>
          </>
        )}
      </div>

      {open && (
        <div
          className="log-list"
          ref={listRef}
          onScroll={(e) => {
            const node = e.currentTarget
            pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
          }}
        >
          {visible.length === 0 ? (
            <p className="log-empty">Nothing logged yet.</p>
          ) : (
            visible.map((entry) => <LogLine key={entry.key} entry={entry} />)
          )}
        </div>
      )}
    </div>
  )
}