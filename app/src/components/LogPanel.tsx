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
    <div className="log-panel">
      <div className="log-bar">
        <span className="log-title">Event log</span>

        {entries.length > 0 && <span className="log-count">{entries.length}</span>}
        {errors > 0 && <span className="log-badge">{errors} error{errors === 1 ? '' : 's'}</span>}

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
        <button className="btn btn-small" onClick={onClear} disabled={entries.length === 0}>
          Clear
        </button>
      </div>

      <div
        className="log-list"
        ref={listRef}
        onScroll={(e) => {
          const node = e.currentTarget
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
        }}
      >
        <Terminal sequence={false} startOnView={false} className="event-terminal">
          {visible.length === 0 ? (
            <AnimatedSpan className="event-terminal-empty">Nothing logged yet.</AnimatedSpan>
          ) : (
            visible.map((entry) => (
              <AnimatedSpan key={entry.key} className="event-terminal-entry">
                <LogLine entry={entry} />
              </AnimatedSpan>
            ))
          )}
        </Terminal>
      </div>
    </div>
  )
}
