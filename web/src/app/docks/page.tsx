'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/client'
import type { RoomSession, RoomStatus } from '@/lib/types'

const POLL_MS = 15_000
const MAX_CHAT_LINES = 50

type ChatEvent = {
  type: 'comment' | 'gift' | 'like' | 'follow'
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

export default function DocksPage() {
  const [roomId, setRoomId] = useState('')
  const [status, setStatus] = useState<RoomStatus | null>(null)
  const [session, setSession] = useState<RoomSession | null>(null)
  const [chat, setChat] = useState<ChatEvent[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Read room id from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const id = params.get('room') || ''
    setRoomId(id)
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
    const base = location.origin.replace(/^http/, 'ws')
    const url = `${base}/ws/overlay/${encodeURIComponent(roomId)}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onmessage = (event) => {
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
            { type: 'gift', user: frame.user, giftName: frame.giftName || 'gift' },
          ])
        } else if (frame.type === 'follow' && frame.user) {
          setChat((current) => [
            ...current.slice(-MAX_CHAT_LINES + 1),
            { type: 'follow', user: frame.user },
          ])
        }
      } catch {}
    }

    ws.onclose = () => {
      setTimeout(() => {
        if (wsRef.current === ws) wsRef.current = null
      }, 3000)
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [roomId])

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat])

  if (!roomId) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-900 p-4 text-zinc-400">
        <p className="text-center text-sm">Add <code className="text-zinc-300">?room=&lt;room_id&gt;</code> to the URL</p>
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

  return (
    <div className="flex h-full flex-col bg-zinc-900 text-zinc-100">
      {/* Header — viewer count + status */}
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${status?.connected ? 'bg-emerald-400' : status?.connecting ? 'bg-amber-400' : 'bg-zinc-600'}`} />
          <span className="text-xs font-medium text-zinc-300">
            {status?.connected ? 'Live' : status?.connecting ? 'Connecting' : status?.waiting ? 'Waiting' : 'Offline'}
          </span>
        </div>
        {status?.connected && status.viewers != null && (
          <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-xs font-semibold text-emerald-400">
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

      {/* Live chat feed */}
      <div className="flex-1 overflow-y-auto px-2 py-1.5 [scrollbar-width:thin]">
        {chat.length === 0 ? (
          <p className="py-4 text-center text-xs text-zinc-600">
            {status?.connected ? 'Waiting for chat…' : 'Not connected'}
          </p>
        ) : (
          chat.map((event, index) => (
            <div key={`${event.type}-${event.user}-${index}`} className="flex items-start gap-1.5 py-0.5 text-xs leading-relaxed">
              {event.type === 'gift' ? (
                <span className="shrink-0 text-amber-400">🎁</span>
              ) : event.type === 'follow' ? (
                <span className="shrink-0 text-pink-400">💖</span>
              ) : event.type === 'like' ? (
                <span className="shrink-0 text-red-400">❤️</span>
              ) : null}
              <span className="shrink-0 font-medium text-zinc-300">{event.user}</span>
              {event.text && <span className="min-w-0 break-words text-zinc-400">{event.text}</span>}
              {event.giftName && <span className="text-zinc-500">sent {event.giftName}</span>}
            </div>
          ))
        )}
        <div ref={chatEndRef} />
      </div>
    </div>
  )
}
