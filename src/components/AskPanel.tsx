import { useEffect, useRef, useState } from 'react'
import { host } from '../lib/sidecar'
import { chatContext, CONTEXT_MESSAGES } from '../lib/llm'
import type { FeedItem, RoomState } from '../types'

interface Props {
  items: FeedItem[]
  room: RoomState
}

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; text: string }
  | { kind: 'ok'; question: string; answer: string }

/**
 * Asking the configured model what the room is talking about.
 *
 * A panel rather than a toolbar button because the answer needs somewhere to sit:
 * it is several sentences long and it is the only thing in this app that arrives
 * after a deliberate pause rather than with the stream.
 *
 * Collapsed by default like the log. Both are the same kind of thing — a read on
 * what is happening, one click away, never in the way of the chat itself — but
 * they keep their own class names rather than sharing the log's: two panels
 * answering to `.log-toggle` makes "the log's toggle" ambiguous to anything
 * reaching for it, the tests included.
 *
 * The excerpt goes out with the question rather than the room's whole history. A
 * live room produces more text than any context window holds, and the recent tail
 * is what a question asked now is actually about.
 */
export function AskPanel({ items, room }: Props) {
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [state, setState] = useState<State>({ kind: 'idle' })
  const answerRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    // Guarded because scrollIntoView is not a function in every environment the
    // panel renders in: jsdom, where the UI suite runs, implements no layout and
    // so has none to scroll. The scroll is a nicety — bringing a fresh answer
    // into view in a long panel — and its absence is never worth an unhandled
    // TypeError taking the answer down with it.
    const node = answerRef.current
    if (state.kind === 'ok' && typeof node?.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' })
    }
  }, [state])

  const busy = state.kind === 'busy'
  const canAsk = question.trim() !== '' && !busy

  async function ask() {
    const asked = question.trim()
    if (asked === '' || busy) return
    setState({ kind: 'busy' })
    try {
      // Cut from the live feed at the moment of asking, not from a value kept in
      // state: the room moves while the request is in flight and the answer is
      // about what was said when it was asked.
      const context = chatContext(items)
      const answer = await host.llmChat(asked, context)
      if (!alive.current) return
      setQuestion('')
      setState(answer.trim() === '' ? { kind: 'error', text: 'The model answered with nothing.' } : { kind: 'ok', question: asked, answer })
    } catch (error: unknown) {
      if (!alive.current) return
      setState({ kind: 'error', text: message(error) })
    }
  }

  return (
    <div className={`ask-panel${open ? ' ask-open' : ''}`}>
      <div className="log-bar">
        <button className="ask-toggle" onClick={() => setOpen((value) => !value)}>
          <span className={`ask-caret${open ? ' ask-caret-open' : ''}`}>▸</span>
          Ask
        </button>
        {state.kind === 'ok' && <span className="log-count">1 answer</span>}
        {state.kind === 'error' && <span className="log-badge">error</span>}
        {open && (
          <span className="ask-hint">
            {room.target ? `about @${room.target}'s chat` : 'the chat so far'} · last {CONTEXT_MESSAGES} messages
          </span>
        )}
      </div>

      {open && (
        <div className="ask-body">
          <div className="ask-row">
            <input
              className="input"
              placeholder="What is the chat talking about?"
              aria-label="Ask about the chat"
              value={question}
              disabled={busy}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canAsk) ask()
              }}
            />
            <button className="btn btn-small btn-primary" onClick={ask} disabled={!canAsk}>
              {busy ? 'Asking…' : 'Ask'}
            </button>
          </div>

          <div className="ask-answer" ref={answerRef}>
            {state.kind === 'busy' && <p className="ask-note">Waiting for the model…</p>}
            {state.kind === 'error' && <p className="ask-error">{state.text}</p>}
            {state.kind === 'ok' && (
              <>
                <p className="ask-question">{state.question}</p>
                <p className="ask-text">{state.answer}</p>
              </>
            )}
            {state.kind === 'idle' && (
              <p className="ask-note">
                {items.length === 0
                  ? 'Nothing has been said yet — connect to a live room first.'
                  : 'Asks the model you picked under Model, using the recent chat as context.'}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Whatever the rejection was, as one line worth showing. */
function message(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}
