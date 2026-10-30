/**
 * What one room's connection is doing, as a badge.
 *
 * Two states, and only two: **LIVE** when the backend is connected to the room,
 * and **OFFLINE** for everything else. The backend distinguishes more — dialling,
 * waiting for a streamer who is not live, a live that ended — and an earlier
 * version of this badge showed all of them. In practice an operator reads the
 * badge to answer one question, "is chat coming in right now", and four labels
 * for "no" sent them looking for a problem that was not there. So the finer
 * states are collapsed: not connected is offline, whatever the reason.
 *
 * It lives in one place rather than inside each page that shows it, because two
 * definitions of "is this stream live" is one more than there should be.
 */

import type { RoomStatus } from '@/lib/types'

export default function RoomStateBadge({ status }: { status?: RoomStatus }) {
  // Nothing has been read yet. "Offline" here would be a reading the page never
  // took, so it says nothing and waits for one.
  if (!status) return null

  if (status.connected) {
    return <span className="badge live">LIVE</span>
  }

  return <span className="badge off">OFFLINE</span>
}
