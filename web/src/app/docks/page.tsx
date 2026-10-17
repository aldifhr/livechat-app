'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/client'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import type { RoomSession, RoomStatus } from '@/lib/types'

const POLL_MS = 15_000
const MAX_CHAT_LINES = 50

type ChatEvent = {
  type: 'comment' | 'gift' | 'like' | 'follow' | 'join'
  user: string
  text?: string
  giftName?: string
  avatar?: string
}

function duration(seconds: number | null): string {
  if (!seconds) return '—'
  const whole = Math.floor(seconds)
  if (whole < 60) return `${whole}s`
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function UserAvatar({ avatar, user }: { avatar?: string; user: string }) {
  const [failed, setFailed] = useState(false)
  if (avatar && !failed) {
    return (
      <img
        src={avatar}
        alt=""
        onError={() => setFailed(true)}
        className="h-6 w-6 shrink-0 rounded-full object-cover bg-zinc-800"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    )
  }
  return (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-semibold text-zinc-400">
      {(user.trim()[0] || '?').toUpperCase()}
    </div>
  )
}

type FilterType = 'all' | 'comment' | 'gift' | 'join' | 'like' | 'follow'

const FILTERS: Array<{ id: FilterType; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'comment', label: '💬 Chat' },
  { id: 'gift', label: '🎁 Gift' },
  { id: 'join', label: '👋 Join' },
  { id: 'like', label: '❤️ Like' },
  { id: 'follow', label: '💖 Follow' },
]

export default function DocksPage() {
  const [roomId, setRoomId] = useState('')
  const [status, setStatus] = useState<RoomStatus | null>(null)
  const [session, setSession] = useState<RoomSession | null>(null)
  const [chat, setChat] = useState<ChatEvent[]>([])
  const [filter, setFilter] = useState<FilterType>('all')
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [rooms, setRooms] = useState<Array<{ id: string; username: string; name: string; connected: boolean }>>([])
  const wsRef = useRef<WebSocket | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Read room id from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const id = params.get('room') || ''
    setRoomId(id)
  }, [])

  // Fetch public room list for the switcher
  useEffect(() => {
    api.publicRooms()
      .then(({ rooms }) => {
        setRooms(rooms.filter((room) => room.username || room.name))
      })
      .catch(() => {})
  }, [])

  // Poll status + session
  const load = useCallback(async () => {
    if (!roomId) return
    try {
      const [read, counted] = await Promise.all([
        api.status(roomId).catch(() => undefined),
        api.session(roomId).catch(() => undefined),
      ])
      if (read) setStatus(read)
      if (counted) setSession(counted)
      setError('')
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Failed to load')
    } finally {
      setLoaded(true)
    }
  }, [roomId])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  // WebSocket for live chat
  useEffect(() => {
    if (!roomId) return
    const params = new URLSearchParams(window.location.search)
    const custom = params.get('ws') || params.get('backend')
    const base = custom
      ? custom.replace(/\/+$/, '').replace(/^http/, 'ws')
      : location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        ? 'wss://kit-backend.aldifhr.my.id'
        : location.origin.replace(/^http/, 'ws')
    const url = `${base}/ws/overlay/${encodeURIComponent(roomId)}`
    console.log('[docks] Connecting WebSocket:', url)
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[docks] WebSocket connected to', url)
    }

    ws.onerror = (err) => {
      console.error('[docks] WebSocket error:', err)
    }

    ws.onmessage = (event) => {
      console.log('[docks] WS frame received:', event.data)
      try {
        const frame = JSON.parse(event.data)
        if (frame.type === 'comment' && frame.user) {
          setChat((current) => [
            ...current.slice(-MAX_CHAT_LINES + 1),
            { type: 'comment', user: frame.user, text: frame.text, avatar: frame.avatar },
          ])
        } else if (frame.type === 'gift' && frame.user) {
          setChat((current) => [
            ...current.slice(-MAX_CHAT_LINES + 1),
            { type: 'gift', user: frame.user, giftName: frame.giftName || 'gift', avatar: frame.avatar },
          ])
        } else if (frame.type === 'follow' && frame.user) {
          setChat((current) => [
            ...current.slice(-MAX_CHAT_LINES + 1),
            { type: 'follow', user: frame.user, avatar: frame.avatar },
          ])
        } else if (frame.type === 'like' && frame.user) {
          setChat((current) => [
            ...current.slice(-MAX_CHAT_LINES + 1),
            { type: 'like', user: frame.user, avatar: frame.avatar },
          ])
        } else if (frame.type === 'join' && frame.user) {
          setChat((current) => [
            ...current.slice(-MAX_CHAT_LINES + 1),
            { type: 'join', user: frame.user, avatar: frame.avatar },
          ])
        }
      } catch (err) {
        console.error('[docks] Failed to parse frame:', err)
      }
    }

    ws.onclose = (ev) => {
      console.warn('[docks] WebSocket closed:', ev.code, ev.reason)
      setTimeout(() => {
        if (wsRef.current === ws) wsRef.current = null
      }, 3000)
    }

    return () => {
      console.log('[docks] Cleaning up WebSocket')
      ws.close()
      wsRef.current = null
    }
  }, [roomId])

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat])

  // No room in URL: auto-select the first room if there's exactly one,
  // otherwise show the room list so the user can pick.
  if (!roomId && rooms.length === 1) {
    const only = rooms[0]
    if (only) {
      setRoomId(only.id)
      const url = new URL(window.location.href)
      url.searchParams.set('room', only.id)
      window.history.replaceState({}, '', url.toString())
    }
  }

  // No room selected and multiple (or zero) rooms: show a picker so the
  // operator can choose one without editing the URL.
  if (!roomId && rooms.length !== 1) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-zinc-900 p-4 text-zinc-400">
        {rooms.length === 0 ? (
          <p className="text-center text-sm">No streams yet — add one in the dashboard.</p>
        ) : (
          <>
            <p className="text-center text-sm">Select a stream</p>
            <select
              aria-label="Select room"
              onChange={(e) => {
                const next = e.target.value
                if (!next) return
                setRoomId(next)
                const url = new URL(window.location.href)
                url.searchParams.set('room', next)
                window.history.replaceState({}, '', url.toString())
              }}
              className="max-w-64 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-500"
            >
              <option value="">Choose…</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.username ? `@${room.username}` : room.name || room.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
    )
  }

  if (error && !loaded) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-900 p-4 text-red-400">
        <p className="text-center text-sm">{error}</p>
      </div>
    )
  }

  const events = session ? Object.values(session.totals).reduce((sum, n) => sum + n, 0) : 0
  const filteredChat = filter === 'all' ? chat : chat.filter((e) => e.type === filter)

  return (
    <div className="flex h-full flex-col bg-zinc-900 text-zinc-100">
      {/* Header — room switcher + status */}
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2">
        {rooms.length > 1 && (
          <select
            aria-label="Select room"
            value={roomId}
            onChange={(e) => {
              const next = e.target.value
              setRoomId(next)
              const url = new URL(window.location.href)
              if (next) url.searchParams.set('room', next)
              else url.searchParams.delete('room')
              window.history.replaceState({}, '', url.toString())
            }}
            className="max-w-32 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-200 outline-none focus:border-zinc-500"
          >
            {!roomId && <option value="">Select room</option>}
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.username ? `@${room.username}` : room.name || room.id.slice(0, 8)}
              </option>
            ))}
          </select>
        )}
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${status?.connected ? 'bg-emerald-400' : status?.connecting ? 'bg-amber-400' : 'bg-zinc-600'}`} />
          <span className="text-xs font-medium text-zinc-300">
            {status?.connected ? 'Live' : status?.connecting ? 'Connecting' : status?.waiting ? 'Waiting' : 'Offline'}
          </span>
        </div>
        {status?.connected && status.viewers != null && (
          <span className="ml-auto rounded-full bg-emerald-400/10 px-2 py-0.5 text-xs font-semibold text-emerald-400">
            {status.viewers.toLocaleString()} watching
          </span>
        )}
      </div>

      {/* Quick stats */}
      {session && !(!session.connected && events === 0 && session.total_diamonds === 0) && (
        <div className="grid grid-cols-4 gap-px border-b border-zinc-800 bg-zinc-800">
          <div className="bg-zinc-900 px-2 py-1.5 text-center">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Uptime</div>
            <div className="text-xs font-semibold text-zinc-200">{duration(session.live_seconds)}</div>
          </div>
          <div className="bg-zinc-900 px-2 py-1.5 text-center">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Peak</div>
            <div className="text-xs font-semibold text-zinc-200">{session.peak_viewers ? session.peak_viewers.toLocaleString() : '—'}</div>
          </div>
          <div className="bg-zinc-900 px-2 py-1.5 text-center">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Diamonds</div>
            <div className="text-xs font-semibold text-zinc-200">{session.total_diamonds ? session.total_diamonds.toLocaleString() : '—'}</div>
          </div>
          <div className="bg-zinc-900 px-2 py-1.5 text-center">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Events</div>
            <div className="text-xs font-semibold text-zinc-200">{events ? events.toLocaleString() : '—'}</div>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-1.5 overflow-x-auto border-b border-zinc-800 bg-zinc-950 px-3 py-2 [scrollbar-width:none]">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              filter === f.id
                ? 'bg-zinc-200 text-zinc-900 font-semibold'
                : 'bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Live chat feed */}
      <div className="flex-1 overflow-y-auto px-3 py-3 [scrollbar-width:thin]">
        {filteredChat.length === 0 ? (
          <p className="py-4 text-center text-xs text-zinc-600">
            {chat.length === 0
              ? status?.connected
                ? 'Waiting for chat…'
                : 'Not connected'
              : 'No events matching filter'}
          </p>
        ) : (
          filteredChat.map((event, index) => (
            <div
              key={`${event.type}-${event.user}-${index}`}
              className="mb-1.5 flex items-start gap-1.5"
            >
              <UserAvatar avatar={event.avatar} user={event.user} />
              <Bubble
                align="start"
                variant={event.type === 'gift' ? 'tinted' : event.type === 'follow' || event.type === 'join' ? 'secondary' : 'default'}
                className="max-w-[calc(100%-2rem)]"
              >
                <BubbleContent>
                  {event.type === 'gift' ? <span className="shrink-0 text-amber-400">🎁 </span> : event.type === 'follow' ? <span className="shrink-0 text-pink-400">💖 </span> : event.type === 'like' ? <span className="shrink-0 text-red-400">❤️ </span> : event.type === 'join' ? <span className="shrink-0 text-emerald-400">👋 </span> : null}
                  <span className="shrink-0 font-medium text-zinc-300">{event.user}</span>
                  {event.text && <span className="min-w-0 break-words text-zinc-400"> {event.text}</span>}
                  {event.giftName && <span className="text-zinc-500"> sent {event.giftName}</span>}
                  {event.type === 'like' && <span className="text-zinc-500"> liked the stream</span>}
                  {event.type === 'follow' && <span className="text-zinc-500"> followed</span>}
                  {event.type === 'join' && <span className="text-zinc-500"> joined</span>}
                </BubbleContent>
              </Bubble>
            </div>
          ))
        )}
        <div ref={chatEndRef} />
      </div>
    </div>
  )
}
