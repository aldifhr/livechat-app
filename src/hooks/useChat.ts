import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { attach, detachHandler, host, type FramePlatform, type SidecarEvent } from '../lib/sidecar'
import { chatContext } from '../lib/llm'
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
   * Asks the configured model about the room and puts both the question and the
   * answer in the feed, as if the model were just another chatter.
   *
   * The question is pushed immediately so the user sees it land before the round
   * trip; the answer arrives later and is pushed when it does. Neither goes
   * through `stats.record`, so a question is not counted as a chat message and
   * the model does not appear on the chatters leaderboard — it is not a viewer.
   */
  ask: (question: string) => Promise<void>
  /** True while a question is in flight, so the input can show it. */
  asking: boolean
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
  const { items, push, clear: clearFeed, totalReceived } = useFeed({
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
   * Asking the model, and putting the exchange in the feed.
   *
   * The question lands immediately so the user sees their own words before the
   * round trip; the answer lands when it returns. Both go through `push` rather
   * than `emit`, so neither is counted as a chat event and the model never joins
   * the chatters leaderboard — it is not a viewer, and a "message" total that
   * climbs because you asked a question is a total that lies about the room.
   *
   * On failure the answer row is still written, carrying the reason: a question
   * that silently vanishes reads as a hung app, while one that comes back
   * "could not reach the endpoint" is a state the user can act on.
   */
  const [asking, setAsking] = useState(false)
  const itemsRef = useRef(items)
  itemsRef.current = items

  const ask = useCallback(
    async (question: string) => {
      const asked = question.trim()
      if (asked === '' || asking) return
      setAsking(true)
      const at = Date.now()
      // Pushed before the call so the feed scrolls to it as it would to any new
      // row, rather than jumping twice — once for the question, once for the
      // answer.
      push({
        platform: 'tiktok',
        kind: 'ask',
        nickname: 'You',
        id: 'you',
        avatar: '',
        timestamp: at,
        text: asked,
      })
      try {
        const context = chatContext(itemsRef.current)
        const answer = await host.llmChat(asked, context)
        push({
          platform: 'tiktok',
          kind: 'answer',
          nickname: 'AI',
          id: 'ai',
          avatar: '',
          timestamp: Date.now(),
          text: answer.trim() === '' ? 'The model answered with nothing.' : answer,
        })
      } catch (error: unknown) {
        push({
          platform: 'tiktok',
          kind: 'answer',
          nickname: 'AI',
          id: 'ai',
          avatar: '',
          timestamp: Date.now(),
          text: `Could not ask: ${message(error)}`,
        })
      } finally {
        setAsking(false)
      }
    },
    [asking, push],
  )

  // Read inside the event handler to tell a dropped connection from a
  const handle = useCallback(
    (event: SidecarEvent) => {
      const inRoom = roomOf(event.platform)
      // Any frame from a room proves it is still talking, whatever the frame says.
      if (inRoom) markAlive()

      switch (event.type) {
        case 'status': {
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
            status: event.connecting
              ? 'connecting'
              : event.connected
                ? 'connected'
                : event.liveEnded
                  ? 'ended'
                  : previous.status === 'connected'
                    ? 'idle'
                    : 'error',
            message: event.message,
          }))
          break
        }
        case 'room':
          if (!inRoom) break
          setRoom((previous) => ({
            ...previous,
            status: 'connected',
            target: event.username,
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
          emit({
            ...event,
            platform: 'tiktok',
            kind: 'chat',
            text: event.text,
            // Only carried when set, so a plain message stays a plain message.
            ...(event.isModerator ? { isModerator: true } : {}),
            ...(event.isFiltered ? { isFiltered: true } : {}),
            ...(event.mentions?.length ? { mentions: event.mentions } : {}),
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
            id: event.viewerId,
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
    return () => {
      active = false
      detachHandler(onEvent)
    }
  }, [])

  return useMemo(
    () => ({ room, items, totalReceived, clear, ask, asking, health, log: { ...log, tallies }, stats }),
    [room, items, totalReceived, clear, ask, asking, health, log, tallies, stats],
  )
}

export { host }

/** Whatever the rejection was, as one line worth showing. */
function message(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}
