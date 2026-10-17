'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/client'
import { RollingNumber } from '@/components/RollingNumber'
import { BubbleChat } from '@/components/BubbleChat'
import { BubbleJoined } from '@/components/BubbleJoined'
import type { RoomSession, RoomStatus } from '@/lib/types'

const POLL_MS = 15_000
const MAX_CHAT_LINES = 50

type ChatEvent = {
  type: 'comment' | 'gift' | 'like' | 'follow' | 'join'
  user: string
  userId?: string
  text?: string
  giftName?: string
  avatar?: string
  time: string
}

function tiktokProfileUrl(userId?: string, user?: string): string {
  const handle = (userId || user || '').trim().replace(/^@+/, '')
  return handle ? `https://www.tiktok.com/@${encodeURIComponent(handle)}` : ''
}

function playChime(type: 'gift' | 'follow' | 'comment') {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AudioContextClass()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    const now = ctx.currentTime
    if (type === 'gift') {
      osc.frequency.setValueAtTime(783.99, now)
      osc.frequency.setValueAtTime(1046.5, now + 0.1)
      gain.gain.setValueAtTime(0.15, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35)
      osc.start(now)
      osc.stop(now + 0.35)
    } else if (type === 'follow') {
      osc.frequency.setValueAtTime(659.25, now)
      gain.gain.setValueAtTime(0.1, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25)
      osc.start(now)
      osc.stop(now + 0.25)
    } else {
      // Soft gentle 'pop' for incoming chat comments
      osc.frequency.setValueAtTime(520, now)
      gain.gain.setValueAtTime(0.05, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1)
      osc.start(now)
      osc.stop(now + 0.1)
    }
  } catch {}
}

// FIFO Queue for Text-to-Speech
const ttsQueue: string[] = []
let isTtsPlaying = false
let activeTtsAudio: HTMLAudioElement | null = null

function clearTtsQueue() {
  ttsQueue.length = 0
  if (activeTtsAudio) {
    activeTtsAudio.pause()
    activeTtsAudio = null
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel()
    } catch {}
  }
  isTtsPlaying = false
}

function playNextTts() {
  if (ttsQueue.length === 0) {
    isTtsPlaying = false
    activeTtsAudio = null
    return
  }

  isTtsPlaying = true
  const text = ttsQueue.shift()!
  const clean = text.slice(0, 180)
  const url = `/api/tts?q=${encodeURIComponent(clean)}`
  const audio = new Audio(url)
  activeTtsAudio = audio

  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    activeTtsAudio = null
    playNextTts()
  }

  audio.onended = finish
  audio.onerror = () => {
    // Fallback suara cewek di browser jika audio terblokir
    if ('speechSynthesis' in window) {
      try {
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.rate = 1.05
        utterance.pitch = 1.25
        const voices = window.speechSynthesis.getVoices()
        const femaleIdVoice = voices.find(
          (v) =>
            (v.lang.startsWith('id') || v.lang.startsWith('ID')) &&
            (v.name.toLowerCase().includes('gadis') ||
              v.name.toLowerCase().includes('siti') ||
              v.name.toLowerCase().includes('female') ||
              v.name.toLowerCase().includes('google')),
        ) || voices.find((v) => v.lang.startsWith('id') || v.lang.startsWith('ID'))
        if (femaleIdVoice) utterance.voice = femaleIdVoice
        utterance.onend = finish
        utterance.onerror = finish
        window.speechSynthesis.speak(utterance)
        return
      } catch {}
    }
    finish()
  }

  const playPromise = audio.play()
  if (playPromise !== undefined) {
    playPromise.catch(() => {
      audio.onerror?.(new Event('error'))
    })
  }
}

function speakText(text: string) {
  if (typeof window === 'undefined') return
  const trimmed = text.trim()
  if (!trimmed) return

  // Batas antrean maksimal 30 pesan agar tidak overload saat live sangat ramai
  if (ttsQueue.length >= 30) {
    ttsQueue.shift()
  }
  ttsQueue.push(trimmed)

  if (!isTtsPlaying) {
    playNextTts()
  }
}

function UserAvatar({
  avatar,
  user,
  profileUrl,
}: {
  avatar?: string
  user: string
  profileUrl?: string
}) {
  const [failed, setFailed] = useState(false)
  const initial = (user.trim()[0] || '?').toUpperCase()

  const avatarCircle = (
    <div className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-300 overflow-hidden ring-1 ring-zinc-700/50 hover:ring-sky-400 transition-all">
      <span>{initial}</span>
      {avatar && !failed && (
        <img
          src={avatar}
          alt=""
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full rounded-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      )}
    </div>
  )

  if (profileUrl) {
    return (
      <a
        href={profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={`Buka @${user} di TikTok`}
        className="shrink-0 rounded-full hover:scale-105 active:scale-95 transition-transform"
      >
        {avatarCircle}
      </a>
    )
  }

  return avatarCircle
}

function BubbleEvent({ event, profileUrl }: { event: ChatEvent; profileUrl?: string }) {
  const isGift = event.type === 'gift'
  const isFollow = event.type === 'follow'

  return (
    <div
      style={{
        backgroundColor: isGift ? '#2a1a08' : isFollow ? '#2a101b' : '#27272a',
        borderColor: isGift ? '#854d0e' : isFollow ? '#9d174d' : '#3f3f46',
      }}
      className="w-fit max-w-[calc(100%-2rem)] min-w-0 rounded-[4px_14px_14px_14px] border px-3 py-1.5 text-xs shadow-sm"
    >
      <div className="flex items-center gap-1.5">
        {profileUrl ? (
          <a
            href={profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: isGift ? '#fcd34d' : isFollow ? '#f472b6' : '#ffffff' }}
            className="shrink-0 font-semibold hover:underline"
            title={`Buka @${event.user} di TikTok`}
          >
            {event.user}
          </a>
        ) : (
          <span
            style={{ color: isGift ? '#fcd34d' : isFollow ? '#f472b6' : '#ffffff' }}
            className="shrink-0 font-semibold"
          >
            {event.user}
          </span>
        )}
        <span style={{ color: '#71717a' }} className="shrink-0 text-[10px] font-normal tabular-nums">
          {event.time}
        </span>
      </div>
      {event.type === 'like' && (
        <p style={{ color: '#a1a1aa' }} className="mt-0.5 m-0 leading-snug">❤️ liked the stream</p>
      )}
      {event.type === 'follow' && (
        <p style={{ color: '#f472b6' }} className="mt-0.5 m-0 font-medium leading-snug">💖 followed</p>
      )}
      {event.type === 'gift' && (
        <p style={{ color: '#fcd34d' }} className="mt-0.5 m-0 font-medium leading-snug">🎁 sent {event.giftName}</p>
      )}
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
  const [viewers, setViewers] = useState<number | null>(null)
  const [session, setSession] = useState<RoomSession | null>(null)
  const [chat, setChat] = useState<ChatEvent[]>([])
  const [filter, setFilter] = useState<FilterType>('all')
  const [search, setSearch] = useState('')
  const [soundEnabled, setSoundEnabled] = useState(false)
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [newCount, setNewCount] = useState(0)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [rooms, setRooms] = useState<Array<{ id: string; username: string; name: string; connected: boolean }>>([])
  const wsRef = useRef<WebSocket | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const feedContainerRef = useRef<HTMLDivElement>(null)
  const filterScrollRef = useRef<HTMLDivElement>(null)
  const isDraggingFilter = useRef(false)
  const filterStartX = useRef(0)
  const filterScrollLeft = useRef(0)
  const filterHasMoved = useRef(false)
  const soundRef = useRef(false)
  const ttsRef = useRef(false)
  const isPausedRef = useRef(false)

  // Sync refs so callbacks have fresh values
  soundRef.current = soundEnabled
  ttsRef.current = ttsEnabled
  isPausedRef.current = isPaused

  // Load sound & tts setting
  useEffect(() => {
    try {
      setSoundEnabled(localStorage.getItem('docks_sound') === '1')
      setTtsEnabled(localStorage.getItem('docks_tts') === '1')
    } catch {}
  }, [])

  const toggleSound = () => {
    setSoundEnabled((prev) => {
      const next = !prev
      try {
        localStorage.setItem('docks_sound', next ? '1' : '0')
      } catch {}
      if (next) playChime('gift')
      return next
    })
  }

  const toggleTts = () => {
    setTtsEnabled((prev) => {
      const next = !prev
      try {
        localStorage.setItem('docks_tts', next ? '1' : '0')
      } catch {}
      if (next) {
        speakText('Text to speech aktif')
      } else {
        clearTtsQueue()
      }
      return next
    })
  }

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
      if (read) {
        setStatus(read)
        if (read.viewers != null) setViewers((curr) => curr ?? (read.viewers as number))
      }
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

  // WebSocket for live chat with automatic reconnection
  useEffect(() => {
    if (!roomId) return
    let disposed = false
    let reconnectTimer: number | null = null

    const params = new URLSearchParams(window.location.search)
    const custom = params.get('ws') || params.get('backend')
    const base = custom
      ? custom.replace(/\/+$/, '').replace(/^http/, 'ws')
      : location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        ? 'wss://kit-backend.aldifhr.my.id'
        : location.origin.replace(/^http/, 'ws')
    const url = `${base}/ws/overlay/${encodeURIComponent(roomId)}`

    function connectWs() {
      if (disposed) return
      console.log('[docks] Connecting WebSocket:', url)
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        console.log('[docks] WebSocket connected to', url)
      }

      ws.onerror = (err) => {
        console.warn('[docks] WebSocket connection error:', err)
      }

      ws.onmessage = (event) => {
        console.log('[docks] WS frame received:', event.data)
        try {
          const frame = JSON.parse(event.data)
          const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          let added = false

          if (frame.type === 'viewers' && typeof frame.count === 'number') {
            setViewers(frame.count)
          } else if (frame.type === 'status') {
            if (typeof frame.viewers === 'number') setViewers(frame.viewers)
          } else if (frame.type === 'comment' && frame.user) {
            setChat((current) => [
              ...current.slice(-MAX_CHAT_LINES + 1),
              { type: 'comment', user: frame.user, userId: frame.userId, text: frame.text, avatar: frame.avatar, time },
            ])
            if (soundRef.current) playChime('comment')
            if (ttsRef.current && frame.text) {
              const textOnly = frame.text.replace(/^@[\w.]+\s*/, '')
              speakText(textOnly || frame.text)
            }
            added = true
          } else if (frame.type === 'gift' && frame.user) {
            setChat((current) => [
              ...current.slice(-MAX_CHAT_LINES + 1),
              { type: 'gift', user: frame.user, userId: frame.userId, giftName: frame.giftName || 'gift', avatar: frame.avatar, time },
            ])
            if (soundRef.current) playChime('gift')
            if (ttsRef.current) {
              speakText(`Terima kasih ${frame.user}, kirim ${frame.giftName || 'gift'}`)
            }
            added = true
          } else if (frame.type === 'follow' && frame.user) {
            setChat((current) => [
              ...current.slice(-MAX_CHAT_LINES + 1),
              { type: 'follow', user: frame.user, userId: frame.userId, avatar: frame.avatar, time },
            ])
            if (soundRef.current) playChime('follow')
            added = true
          } else if (frame.type === 'like' && frame.user) {
            setChat((current) => [
              ...current.slice(-MAX_CHAT_LINES + 1),
              { type: 'like', user: frame.user, userId: frame.userId, avatar: frame.avatar, time },
            ])
            added = true
          } else if (frame.type === 'join' && frame.user) {
            setChat((current) => [
              ...current.slice(-MAX_CHAT_LINES + 1),
              { type: 'join', user: frame.user, userId: frame.userId, avatar: frame.avatar, time },
            ])
            added = true
          }

          if (added && isPausedRef.current) {
            setNewCount((c) => c + 1)
          }
        } catch (err) {
          console.error('[docks] Failed to parse frame:', err)
        }
      }

      ws.onclose = (ev) => {
        console.warn('[docks] WebSocket closed:', ev.code, ev.reason, '- will retry in 4s')
        if (wsRef.current === ws) wsRef.current = null
        if (!disposed) {
          reconnectTimer = window.setTimeout(connectWs, 4000)
        }
      }
    }

    connectWs()

    return () => {
      disposed = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [roomId])

  // Auto-scroll chat only when not paused
  useEffect(() => {
    if (!isPaused) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chat, isPaused])

  const handleScroll = () => {
    const el = feedContainerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (atBottom) {
      setIsPaused(false)
      setNewCount(0)
    } else {
      setIsPaused(true)
    }
  }

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    setIsPaused(false)
    setNewCount(0)
  }

  // Draggable filter bar
  const onFilterMouseDown = (e: React.MouseEvent) => {
    const el = filterScrollRef.current
    if (!el) return
    isDraggingFilter.current = true
    filterHasMoved.current = false
    filterStartX.current = e.pageX - el.offsetLeft
    filterScrollLeft.current = el.scrollLeft
  }

  const onFilterMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingFilter.current) return
    const el = filterScrollRef.current
    if (!el) return
    e.preventDefault()
    const x = e.pageX - el.offsetLeft
    const walk = x - filterStartX.current
    if (Math.abs(walk) > 4) {
      filterHasMoved.current = true
    }
    el.scrollLeft = filterScrollLeft.current - walk
  }

  const onFilterMouseUpOrLeave = () => {
    isDraggingFilter.current = false
  }

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
  const q = search.trim().toLowerCase()
  const filteredChat = chat.filter((event) => {
    if (filter !== 'all' && event.type !== filter) return false
    if (!q) return true
    return (
      event.user.toLowerCase().includes(q) ||
      (event.text && event.text.toLowerCase().includes(q)) ||
      (event.giftName && event.giftName.toLowerCase().includes(q))
    )
  })

  const clearChat = () => {
    setChat([])
    setNewCount(0)
    clearTtsQueue()
  }

  const activeViewers = viewers ?? status?.viewers ?? null

  return (
    <div className="dark flex h-full flex-col bg-zinc-900 text-zinc-100">
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
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              status?.connected
                ? 'bg-[#34d399] shadow-[0_0_8px_#34d399]'
                : status?.connecting
                  ? 'bg-[#fbbf24]'
                  : 'bg-[#52525b]'
            }`}
          />
          <span className="text-xs font-medium text-zinc-300">
            {status?.connected ? 'Live' : status?.connecting ? 'Connecting' : status?.waiting ? 'Waiting' : 'Offline'}
          </span>
        </div>
        {status?.connected && activeViewers != null && (
          <span className="ml-auto rounded-full bg-[#34d399]/15 px-2.5 py-0.5 text-xs font-semibold text-[#34d399]">
            <RollingNumber value={activeViewers} /> watching
          </span>
        )}
        <div className="flex items-center gap-1 ml-auto">
          <button
            type="button"
            onClick={toggleTts}
            title={ttsEnabled ? 'Matikan Google TTS' : 'Aktifkan Google TTS (baca chat, gift & follow)'}
            className={`shrink-0 rounded p-1 text-xs transition-colors ${
              ttsEnabled
                ? 'bg-sky-400/20 text-sky-300 hover:bg-sky-400/30'
                : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
            }`}
            aria-label={ttsEnabled ? 'Matikan TTS' : 'Aktifkan TTS'}
          >
            {ttsEnabled ? '🗣️' : '🔇'}
          </button>
          <button
            type="button"
            onClick={toggleSound}
            title={soundEnabled ? 'Mute alert sounds' : 'Enable alert sounds for chat, gifts & follows'}
            className={`shrink-0 rounded p-1 text-xs transition-colors ${
              soundEnabled
                ? 'bg-amber-400/20 text-amber-300 hover:bg-amber-400/30'
                : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
            }`}
            aria-label={soundEnabled ? 'Mute alert sound' : 'Enable alert sound'}
          >
            {soundEnabled ? '🔔' : '🔕'}
          </button>
        </div>
      </div>

      {/* Quick stats */}
      {session && !(!session.connected && events === 0 && session.total_diamonds === 0) && (
        <div className="grid grid-cols-2 gap-px border-b border-zinc-800 bg-zinc-800">
          <div className="bg-zinc-900 px-2 py-1.5 text-center">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Peak</div>
            <div className="text-xs font-semibold text-zinc-200">
              {session.peak_viewers ? <RollingNumber value={session.peak_viewers} /> : '—'}
            </div>
          </div>
          <div className="bg-zinc-900 px-2 py-1.5 text-center">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Diamonds</div>
            <div className="text-xs font-semibold text-zinc-200">
              {session.total_diamonds ? <RollingNumber value={session.total_diamonds} /> : '—'}
            </div>
          </div>
        </div>
      )}

      {/* Filter and control bar */}
      <div className="border-b border-zinc-800 bg-zinc-950 px-3 py-1.5 space-y-1.5">
        <div className="flex items-center gap-2">
          <div
            ref={filterScrollRef}
            onMouseDown={onFilterMouseDown}
            onMouseMove={onFilterMouseMove}
            onMouseUp={onFilterMouseUpOrLeave}
            onMouseLeave={onFilterMouseUpOrLeave}
            className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto pr-3 [scrollbar-width:none] cursor-grab active:cursor-grabbing select-none [mask-image:linear-gradient(to_right,white_calc(100%-20px),transparent)]"
          >
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  if (!filterHasMoved.current) {
                    setFilter(f.id)
                  }
                }}
                className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors select-none ${
                  filter === f.id
                    ? 'bg-zinc-200 text-zinc-900 font-semibold'
                    : 'bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex items-center pl-1 border-l border-zinc-800 shrink-0">
            <button
              type="button"
              onClick={clearChat}
              title="Clear chat feed"
              aria-label="Clear chat feed"
              className="rounded p-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400 transition-colors"
            >
              🗑️
            </button>
          </div>
        </div>

        {/* Search input */}
        <div className="relative flex items-center">
          <span className="absolute left-2 text-xs text-zinc-500 select-none">🔍</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search username or text..."
            className="w-full rounded bg-zinc-900 border border-zinc-800 pl-6 pr-6 py-1 text-xs text-zinc-200 placeholder:text-zinc-500 outline-none focus:border-zinc-600 focus:bg-zinc-900/90 transition-colors"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 text-xs text-zinc-500 hover:text-zinc-300"
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Live chat feed with auto-scroll pause */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={feedContainerRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-3 py-3 [scrollbar-width:thin]"
        >
          {filteredChat.length === 0 ? (
            <p className="py-4 text-center text-xs text-zinc-600">
              {chat.length === 0
                ? status?.connected
                  ? 'Waiting for chat…'
                  : 'Not connected'
                : search
                  ? `No events matching "${search}"`
                  : 'No events matching filter'}
            </p>
          ) : (
          filteredChat.map((event, index) => {
            const profileUrl = tiktokProfileUrl(event.userId, event.user)
            return (
              <div
                key={`${event.type}-${event.user}-${index}`}
                className="mb-1.5 flex items-start gap-1.5"
              >
                <UserAvatar avatar={event.avatar} user={event.user} profileUrl={profileUrl} />
                {event.type === 'comment' ? (
                  <BubbleChat
                    user={event.user}
                    text={event.text}
                    time={event.time}
                    profileUrl={profileUrl}
                  />
                ) : event.type === 'join' ? (
                  <BubbleJoined
                    user={event.user}
                    time={event.time}
                    profileUrl={profileUrl}
                  />
                ) : (
                  <BubbleEvent event={event} profileUrl={profileUrl} />
                )}
              </div>
            )
          })
          )}
          <div ref={chatEndRef} />
        </div>

        {isPaused && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-zinc-800/95 hover:bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 shadow-xl border border-zinc-700 backdrop-blur transition-all"
          >
            <span>↓</span>
            <span>New messages{newCount > 0 ? ` (${newCount})` : ''}</span>
          </button>
        )}
      </div>
    </div>
  )
}
