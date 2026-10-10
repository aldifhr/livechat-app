import { useState } from 'react'
import { CONTEXT_MESSAGES } from '../lib/llm'
import type { FeedItem, RoomState } from '../types'

interface Props {
  items: FeedItem[]
  room: RoomState
  /** Runs the ask and puts both the question and the answer in the feed. */
  onAsk: (question: string) => Promise<void>
  /** True while a question is in flight, so the input can reflect it. */
  asking: boolean
}

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
export function AskPanel({ items, room, onAsk, asking }: Props) {
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')

  const canAsk = question.trim() !== '' && !asking

  async function ask() {
    const asked = question.trim()
    if (asked === '' || asking) return
    // Cleared here rather than after the call: the exchange now lands in the
    // feed, so the input is free the moment it is sent, and holding the text
    // until the answer returns would only invite a second identical send.
    setQuestion('')
    await onAsk(asked)
  }

  return (
    <div className={`ask-panel${open ? ' ask-open' : ''}`}>
      <div className="log-bar">
        <button className="ask-toggle" onClick={() => setOpen((value) => !value)}>
          <span className={`ask-caret${open ? ' ask-caret-open' : ''}`}>▸</span>
          Ask
        </button>
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
              disabled={asking}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canAsk) ask()
              }}
            />
            <button className="btn btn-small btn-primary" onClick={ask} disabled={!canAsk}>
              {asking ? 'Asking…' : 'Ask'}
            </button>
          </div>

          <p className="ask-note">
            {items.length === 0
              ? 'Nothing has been said yet — connect to a live room first.'
              : 'The question and the model’s answer appear in the feed above.'}
          </p>
        </div>
      )}
    </div>
  )
}
