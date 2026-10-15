/**
 * Which rooms are actually readable right now.
 *
 * Both room pickers — the overlay builder's and the live preview's — used to list
 * every room in store order and default to the first one. That is the order they
 * were created in, which has nothing to do with which can produce a chat: the
 * preview opened on an offline room while a live one sat further down the list,
 * and the only way to tell them apart was to pick one and watch it do nothing.
 *
 * Pure, so the ordering and the wording can be tested without a browser — the
 * same reason `shared/overlay.ts` is separate from the components that read it.
 */

import type { Room, RoomStatus } from './types'

/** How a room reads at a glance. */
export type RoomLive = 'live' | 'waiting' | 'offline'

/**
 * A room's state, from the status the backend serves.
 *
 * `waiting` covers both a streamer with no live and one whose live just ended:
 * the backend polls for either, so neither is "offline" in the sense that matters
 * to a picker — it is a room that will start producing chat on its own.
 */
export function liveOf(status: RoomStatus | undefined | null): RoomLive {
  if (!status) return 'offline'
  if (status.connected) return 'live'
  if (status.waiting || status.liveEnded) return 'waiting'
  return 'offline'
}

/** The word shown beside a room in a picker. */
export function labelOf(live: RoomLive): string {
  if (live === 'live') return 'LIVE'
  if (live === 'waiting') return 'offline — waiting'
  return 'offline'
}

/** A room with its state, which is what a picker actually needs. */
export interface RoomChoice {
  room: Room
  live: RoomLive
}

/**
 * Rooms ordered for a picker: live first, then waiting, then offline.
 *
 * Within a group the original order is kept, so the list does not reshuffle
 * between polls beyond what a state change justifies. Sorting is what makes the
 * default — the first entry — the room most likely to be worth opening, which is
 * the bug this exists for: an offline room was first because it was created
 * first, and every visit started there.
 */
export function orderForPicker(rooms: Room[], statuses: Record<string, RoomStatus | undefined>): RoomChoice[] {
  const rank: Record<RoomLive, number> = { live: 0, waiting: 1, offline: 2 }
  return rooms
    .map((room) => ({ room, live: liveOf(statuses[room.id]) }))
    .sort((a, b) => rank[a.live] - rank[b.live])
}

/**
 * Which room a picker should open on, given a requested id.
 *
 * A requested id wins only if it names a room that exists — a stale link should
 * land somewhere real rather than on a frame that loads nothing. Otherwise the
 * first live room, and failing that the first room of any kind: an all-offline
 * stream list still has rooms worth styling.
 */
export function pickDefaultRoom(choices: RoomChoice[], requested?: string | null): string {
  if (requested && choices.some((choice) => choice.room.id === requested)) return requested
  const live = choices.find((choice) => choice.live === 'live')
  return live?.room.id ?? choices[0]?.room.id ?? ''
}
