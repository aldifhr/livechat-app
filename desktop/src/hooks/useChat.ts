import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { adoptSnapshot, attach, detachHandler, host, type FramePlatform, type SidecarEvent } from '../lib/sidecar'
import { useFeed, type FeedInput } from './useFeed'
import { useHealth } from './useHealth'
import { useLog } from './useLog'
import { createStats, type StatsRecorder } from './useStats'
import { IDLE_ROOM, type FeedItem, type RoomState } from '../types'

export interface UseChatOptions {
  collapseWindowMs: number
  collapseThreshold: number
}

export interface UseChatResult {
  room: RoomState
  items: FeedItem[]
  totalReceived: number
  clear: () => void
  /**
   * Writes a row the app invented rather than received.
   *
   * Skips the counters on purpose: the app is not a viewer, so a "Messages" total
   * that climbs because the app spoke is a total that lies about the room, and the
   * chatters board that answers to it would list a bot.
   */
  post: (item: FeedInput) => void
  log: ReturnType<typeof useLog>
  /** Whether the room is still talking. */
  health: ReturnType<typeof useHealth>['health']
  /** Session counters. Fed from the same events as the feed, never from the feed. */
  stats: StatsRecorder
}

/** The room a frame belongs to, or null for anything about the bridge itself. */
function roomOf(platform: FramePlatform): boolean {
  return platform === 'tiktok'
}

export function useChat({ collapseWindowMs, collapseThreshold }: UseChatOptions): UseChatResult {
  const [room, setRoom] = useState<RoomState>(IDLE_ROOM)
  const {
    items,
    push,
    post,
    clear: clearFeed,
    totalReceived,
  } = useFeed({
    windowMs: collapseWindowMs,
    threshold: collapseThreshold,
  })
  const log = useLog()
  const { push: logPush, bump, tallies } = log

  // Held in a ref because it is an accumulator, not a value: the panel subscribes
  // to this one instance, and a fresh one per render would throw its totals away.
  const statsRef = useRef<StatsRecorder | null>(null)
  statsRef.current ??= createStats()
  const stats = statsRef.current

  // The feed and the counters are cleared together: connecting to a new room with
  // the previous stream's totals still on the panel is worse than no totals.
  const clear = useCallback(() => {
    clearFeed()
    stats.reset()
  }, [clearFeed, stats])

  // Sampled for the whole session, not while the Stats page happens to be open.
  //
  // The timer used to live in `useStats`, which the panel mounts — so switching to
  // Home and back stopped the sampler for as long as the page was elsewhere, and
  // the chart resumed with a hole where those minutes should be. Its x-axis is
  // sample indices, so the hole did not even read as one: the line just continued,
  // claiming a flat stretch nobody measured. The accumulator outlives every page,
  // so the timer that feeds it does too.
  useEffect(() => {
    stats.startSampling()
    return () => stats.stopSampling()
  }, [stats])

  // Read inside the event handler to tell a dropped connection from a deliberate
  // Disconnect, and by the health check to know whether the room is open. Through
  // a ref so reading it does not rebuild the handler on every viewer count.
  const roomRef = useRef(room)
  roomRef.current = room

  // A dropped connection can look perfectly healthy otherwise: the socket dies
  // quietly and the only symptom is that the chat stops.
  const { health, markAlive } = useHealth(
    useCallback(() => roomRef.current.status === 'connected', []),
  )

  /**
   * Feeds one event to the feed and the counters.
   *
   * Both are written from here rather than in the panel, so the totals describe
   * every event that arrived even though the feed drops the old ones and the
   * panel only re-reads occasionally.
   */
  const emit = useCallback(
    (item: FeedInput) => {
      push(item)
      stats.record(item)
    },
    [push, stats],
  )

  /*
   * The hooks below are handed the feed's write functions rather than being wired
   * into the event path. A reply the app decides to write is a decision made
   * *after* an event has already been shown, and putting it here would mean a
   * slow provider could hold up the feed.
   */

  // Read inside the event handler to tell a dropped connection from a
  const handle = useCallback(
    (event: SidecarEvent) => {
      const inRoom = roomOf(event.platform)
      // Any frame from a room proves it is still talking, whatever the frame says.
      if (inRoom) markAlive()

      switch (event.type) {
        case 'status': {
          // A snapshot is not an event — it is the host telling a freshly-loaded
          // page what it is already looking at. It must not reach the log, or a
          // reload would leave a "Connected to @x" line that never happened, and
          // it must be applied whole rather than merged: it is the complete state,
          // not a transition from the idle room this page started with.
          if ((event as { snapshot?: boolean }).snapshot === true) {
            const snap = event as unknown as {
              connected?: boolean
              running?: boolean
              username?: string
              roomId?: string
              title?: string
              viewers?: number | null
              message?: string
            }
            setRoom({
              // The reader may be running without the stream being live — mid
              // handshake, or retrying a streamer's live. That is `waiting`, not
              // idle: the page must offer Stop over a reader that still exists
              // rather than a Connect button over one that does not.
              status: snap.connected ? 'connected' : snap.running ? 'waiting' : 'idle',
              message: snap.connected
                ? `Connected to @${snap.username ?? ''}`
                : snap.running
                  ? 'Waiting for the stream…'
                  : '',
              target: snap.username ?? '',
              id: snap.roomId ?? '',
              title: snap.title ?? '',
              viewers: typeof snap.viewers === 'number' ? snap.viewers : 0,
            })
            break
          }
          logPush(
            event.connecting || event.connected ? 'info' : 'warn',
            `${inRoom ? 'tiktok: ' : ''}${event.message}`,
          )
          if (!inRoom) {
            // A bridge-level status covers the whole process, so it clears the room
            // — otherwise a Disconnect would leave the badge reading "Connected"
            // over a stream that is already gone.
            setRoom(IDLE_ROOM)
            break
          }
          setRoom((previous) => ({
            ...previous,
            // `waiting` is checked before `liveEnded`, and the order matters when
            // both are set — which is what the backend sends while it polls for a
            // streamer whose live just ended. That combination means "the live is
            // over, but a source is still running and will pick the next one up on
            // its own", and `ended` would be the wrong reading of it: it offers a
            // Connect button for a room that already has a reader, and the wait
            // could not be called off. `waiting` renders Stop instead, which is
            // the only control that matches what the backend is doing. A bare
            // `liveEnded` — the wait has given up — still reads `ended`.
            status: event.waiting
              ? 'waiting'
              : event.liveEnded
                ? 'ended'
                : event.connecting
                  ? 'connecting'
                  : event.connected
                    ? 'connected'
                    : previous.status === 'connected'
                      ? 'idle'
                      : 'error',
            message: event.message,
          }))
          break
        }
        case 'room':
          // The bridge announces which room it resolved, by id, the moment it
          // connects. This is the only place the id reaches the page — the backend
          // sends no room frame of its own — and the overlay link needs it to be a
          // bare `?room=<id>`. It only fills the id; the room's live state (target,
          // title, connected) comes from the room's own frames, so this must not
          // overwrite them.
          if (event.platform === 'bridge') {
            if (event.roomId) {
              setRoom((previous) => ({ ...previous, id: event.roomId }))
            }
            break
          }
          if (!inRoom) break
          setRoom((previous) => ({
            ...previous,
            status: 'connected',
            target: event.username,
            // Kept so the overlay link can name the room by id — one parameter
            // nothing has to resolve — rather than by the handle the page would
            // have to turn into an id each time.
            id: event.roomId,
            title: event.title,
          }))
          logPush('info', `tiktok: room ${event.roomId} is open for ${event.username}`)
          break
        case 'viewers':
          // Deliberately not logged. A viewer update arrives every few seconds
          // and the figure is already on screen, so logging each one would bury
          // the events that actually explain a problem.
          if (!inRoom) break
          stats.setViewers(event.count)
          setRoom((previous) => ({ ...previous, viewers: event.count }))
          break
        case 'error':
          logPush('error', `${inRoom ? 'tiktok: ' : ''}${event.message}`)
          if (!inRoom) break
          setRoom((previous) => ({ ...previous, status: 'error', message: event.message }))
          break
        case 'log':
          logPush(event.level, event.message)
          break
        case 'ready':
          logPush('info', 'chat reader ready')
          break
        case 'chat':
          if (!inRoom) break
          // A bot reply is shown but not counted: it is the app talking, not a
          // viewer, so it must not inflate the chat total or put the bot on the
          // chatters leaderboard as if it were a person watching.
          const bot = event.isBot === true
          if (bot) {
            push({
              ...event,
              platform: 'tiktok',
              kind: 'chat',
              text: event.text,
              isBot: true,
            })
            break
          }
          emit({
            ...event,
            platform: 'tiktok',
            kind: 'chat',
            text: event.text,
            // Only carried when set, so a plain message stays a plain message.
            ...(event.isModerator ? { isModerator: true } : {}),
            ...(event.isFiltered ? { isFiltered: true } : {}),
            ...(event.emotes?.length ? { emotes: event.emotes } : {}),
          })
          bump('chat')
          break
        case 'gift':
          if (!inRoom) break
          emit({ ...event, platform: 'tiktok', kind: 'gift' })
          bump('gift')
          break
        case 'like':
          if (!inRoom) break
          emit({ ...event, platform: 'tiktok', kind: 'like' })
          bump('like')
          break
        case 'join':
          if (!inRoom) break
          // Renders like any other row: same avatar, same name, same shape. It is a
          // viewer appearing, not a room-level statistic.
          emit({
            platform: 'tiktok',
            kind: 'join',
            nickname: event.nickname,
            id: event.id,
            avatar: event.avatar,
            timestamp: event.timestamp,
          })
          bump('join')
          break
        case 'follow':
          if (!inRoom) break
          emit({ ...event, platform: 'tiktok', kind: 'follow' })
          bump('follow')
          break
        case 'share':
          if (!inRoom) break
          emit({ ...event, platform: 'tiktok', kind: 'share' })
          bump('share')
          break
        // The four below are room events rather than viewer actions, so they go
        // into the feed but not into the per-viewer counters: a stream title is
        // not something a viewer did, and counting it would put a number in
        // "Chatters" that no person earned.
        case 'intro':
          if (!inRoom) break
          push({ ...event, platform: 'tiktok', kind: 'intro', title: event.title })
          logPush('info', `tiktok: stream title "${event.title}"`)
          break
        case 'notice':
          if (!inRoom) break
          // A room notice is not from a viewer, so it carries no identity. The
          // fields are filled with empty strings rather than left off because a
          // feed row is a `Viewer`: the renderer already falls back to "Room" for
          // a blank name, and an absent field would be the same value with a type
          // that does not say so.
          push({
            ...event,
            platform: 'tiktok',
            kind: 'notice',
            id: '',
            avatar: '',
            text: event.text,
          })
          break
        case 'subscription':
          if (!inRoom) break
          emit({ ...event, platform: 'tiktok', kind: 'subscription', months: event.months })
          bump('subscription')
          break
        case 'poll':
          if (!inRoom) break
          // Same as a notice: a poll is the streamer's, not a viewer's, so there
          // is no identity to carry. The renderer names a blank row "Room".
          push({
            ...event,
            platform: 'tiktok',
            kind: 'poll',
            id: '',
            nickname: '',
            avatar: '',
            text: event.question,
            options: event.options,
          })
          logPush('info', `tiktok: poll "${event.question}" (${event.options.length} options)`)
          break
        default:
          break
      }
    },
    [emit, logPush, bump, stats],
  )

  // Subscribing once per mount: the listener is held in a ref so changing the
  // collapse settings does not tear down the Tauri listener mid-stream, which
  // would drop whatever arrives in between.
  const handleRef = useRef(handle)
  handleRef.current = handle

  useEffect(() => {
    let active = true
    // Named so it can be taken back off: `attach` fans frames out to a set that
    // outlives this component, and a handler left behind would keep the whole
    // feed alive after the app had closed it.
    const onEvent = (event: SidecarEvent) => {
      if (active) handleRef.current(event)
    }
    attach(onEvent)

    /*
     * Ask the host what it is reading, because this page cannot know.
     *
     * A reload — which `tauri:dev` does on every code change — replaces the whole
     * webview while the Rust process keeps the stream open. This page therefore
     * starts from an idle room: the button says Connect and the badge says "Not
     * connected" while chat rows are still arriving, because the reader was never
     * stopped. Asking once, here, is what closes that gap.
     *
     * Deliberately not a reconnect: the connection is meant to survive a reload,
     * the same way it survives the window being hidden to the tray. Reconnecting
     * would open a second socket for a room already being read, and the session
     * stamp would then reject every frame from the one that is actually running.
     *
     * After the listener is attached, so a frame arriving in the same tick is not
     * lost to a race with the snapshot. The snapshot itself is adopted through the
     * same guard and the same listeners as a real frame — see `adoptSnapshot`.
     */
    void host
      .backendStatus()
      .then((snapshot) => {
        if (!active || !snapshot) return
        adoptSnapshot(snapshot as unknown as SidecarEvent)
      })
      .catch(() => {
        // A host that cannot answer is one with no reader running, which is
        // exactly the idle room this page already shows. Nothing to recover.
      })

    return () => {
      active = false
      detachHandler(onEvent)
    }
  }, [])

  return useMemo(
    () => ({ room, items, totalReceived, clear, post, health, log: { ...log, tallies }, stats }),
    [room, items, totalReceived, clear, post, health, log, tallies, stats],
  )
}
