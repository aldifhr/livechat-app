/**
 * What one room's connection is doing, as a badge.
 *
 * Four states, not two, and the precedence below is the entire content of this
 * component: the backend distinguishes them, and collapsing them into a boolean is
 * what sends an operator looking for a connection problem that is not there.
 *
 * It lives in one place rather than inside either page that shows it because two
 * definitions of "is this stream live" is one more than there should be. The
 * streams page had its own, and it disagreed: it read `connected` and nothing else,
 * so a room the backend was actively dialling rendered as "offline" until the next
 * poll — up to fifteen seconds after a Connect that had worked.
 */

import type { RoomStatus } from '@/lib/types'

export default function RoomStateBadge({ status }: { status?: RoomStatus }) {
  // Nothing has been read yet. "Offline" here would be a reading the page never
  // took, so it says nothing and waits for one.
  if (!status) return null

  if (status.liveEnded && !status.waiting) {
    // The live ended and nothing will retry it. A room in this state needs a fresh
    // Connect, and a badge that only said "offline" would point the reader at the
    // connection instead.
    return <span className="badge off">Live ended</span>
  }

  if (status.waiting) {
    // `waiting` before `connecting`, and it matters: the backend sets both while it
    // polls for a streamer who is not live — one so an older client still waits, one
    // so a client that knows about it can say what is actually happening. Reading
    // `connecting` first showed "Connecting" for a streamer who is simply offline,
    // which is the one thing this must not say: nothing is connecting, and nothing
    // will until they go live. `liveEnded` is folded in here for the same reason —
    // a live that ended and is being polled for is a wait, not a dead end.
    // `connecting` is carried alongside it on purpose, so a client that knows
    // nothing about `waiting` still waits — but this is the state the operator is
    // actually in, and it has a Stop on the stream page. Calling it "Offline" read
    // as a dead connection with a Stop button beside it, which is not what is
    // happening: nothing is connected, but something is watching and can be
    // called off.
    return <span className="badge off">Waiting</span>
  }

  if (status.connecting) {
    // A handshake is genuinely in flight. This is the state a card sits in for the
    // second or two after Connect, and it is the state that has to be legible: it
    // is the difference between "it worked, hold on" and "it failed".
    return <span className="badge off">Connecting</span>
  }

  if (status.connected) {
    return <span className="badge live">Live</span>
  }

  return <span className="badge">Offline</span>
}
