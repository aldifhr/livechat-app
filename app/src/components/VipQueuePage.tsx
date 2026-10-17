import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { FeedItem } from '../types'

type QueueStatus = 'waiting' | 'playing' | 'done'
interface VipEntry {
  handle: string
  status: QueueStatus
}

const STORAGE_KEY = 'livechat.vip-mabar-queue'

function cleanHandle(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase()
}

function loadQueue(): VipEntry[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is VipEntry =>
      Boolean(entry)
      && typeof entry.handle === 'string'
      && /^[a-z0-9._]{1,24}$/i.test(entry.handle)
      && ['waiting', 'playing', 'done'].includes(entry.status),
    )
  } catch {
    return []
  }
}

export function VipQueuePage({ items }: { items: FeedItem[] }) {
  const [queue, setQueue] = useState<VipEntry[]>(loadQueue)
  const [handle, setHandle] = useState('')
  const active = queue.some((entry) => entry.status === 'playing')
  const latestChatByHandle = useMemo(() => {
    const latest = new Map<string, FeedItem>()
    for (const item of items) {
      if (item.kind !== 'chat') continue
      const id = cleanHandle(item.id)
      if (id) latest.set(id, item)
    }
    return latest
  }, [items])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(queue))
    } catch {
      // Queue remains usable for this session if local storage is unavailable.
    }
  }, [queue])

  function addVip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const handles = [...new Set(handle.split(/[\n,]+/).map(cleanHandle).filter((value) => /^[a-z0-9._]{1,24}$/i.test(value)))]
    if (handles.length === 0) return
    setQueue((current) => {
      const existing = new Set(current.map((entry) => entry.handle))
      return [...current, ...handles.filter((value) => !existing.has(value)).map((value) => ({ handle: value, status: 'waiting' as const }))]
    })
    setHandle('')
  }

  function updateStatus(target: string, status: QueueStatus) {
    setQueue((current) => current.map((entry) => {
      if (status === 'playing' && entry.status === 'playing') return { ...entry, status: 'waiting' }
      return entry.handle === target ? { ...entry, status } : entry
    }))
  }

  return (
    <main className="page-view flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
      <header className="mx-auto w-full max-w-[760px]">
        <h1 className="m-0 text-xl font-semibold">VIP Mabar Queue</h1>
        <p className="mb-0 mt-1 text-xs text-app-muted">Manage your invited players and keep their chat messages handy.</p>
      </header>

      <section className="mx-auto flex w-full max-w-[760px] flex-col gap-3 rounded-xl border border-app-line bg-app-panel p-4">
        <form className="flex flex-wrap items-stretch gap-2" onSubmit={addVip}>
          <textarea
            className="input min-h-10 min-w-0 flex-1 resize-y rounded-lg border border-app-line bg-app-bg px-3 py-2 text-app-text outline-none focus:border-app-accent"
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            placeholder="TikTok username"
            aria-label="VIP TikTok usernames"
            rows={2}
          />
          <button className="btn btn-primary self-center rounded-lg bg-app-accent px-4 py-2 font-semibold text-app-bg disabled:opacity-50" type="submit" disabled={!handle.trim()}>
            Add VIP
          </button>
        </form>
        <p className="m-0 text-[11px] text-app-muted">Queue order follows the list. Only one person can be marked as currently playing.</p>
      </section>

      <section className="mx-auto flex w-full max-w-[760px] flex-col gap-2" aria-label="VIP mabar queue">
        <div className="flex items-center justify-between px-1 text-xs text-app-muted">
          <span>{queue.filter((entry) => entry.status === 'waiting').length} waiting · {queue.filter((entry) => entry.status === 'playing').length} playing</span>
          {queue.some((entry) => entry.status === 'done') && (
            <button className="text-app-muted underline underline-offset-2 hover:text-app-text" type="button" onClick={() => setQueue((current) => current.filter((entry) => entry.status !== 'done'))}>Clear done</button>
          )}
        </div>
        {queue.length === 0 ? (
          <div className="rounded-xl border border-dashed border-app-line p-8 text-center text-sm text-app-muted">Add the VIP players you want to invite for mabar.</div>
        ) : queue.map((entry, index) => {
          const latest = latestChatByHandle.get(entry.handle)
          const statusLabel = entry.status === 'playing' ? 'Playing now' : entry.status === 'done' ? 'Finished' : 'Waiting'
          return (
            <article key={entry.handle} className="flex flex-wrap items-center gap-3 rounded-xl border border-app-line bg-app-panel px-3 py-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-app-bg text-xs tabular-nums text-app-muted">{index + 1}</span>
              <div className="min-w-[120px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">@{entry.handle}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${entry.status === 'playing' ? 'bg-app-green/15 text-app-green' : 'bg-app-bg text-app-muted'}`}>{statusLabel}</span>
                </div>
                <p className="mb-0 mt-1 truncate text-xs text-app-muted">{latest?.text || 'No chat message seen this session.'}</p>
              </div>
              {entry.status === 'waiting' && (
                <button className="btn btn-small rounded-lg border border-app-line px-3 py-1.5 text-xs disabled:opacity-40" type="button" disabled={active} onClick={() => updateStatus(entry.handle, 'playing')}>Invite to play</button>
              )}
              {entry.status === 'playing' && (
                <button className="btn btn-small rounded-lg border border-app-line px-3 py-1.5 text-xs" type="button" onClick={() => updateStatus(entry.handle, 'done')}>Mark done</button>
              )}
              {entry.status === 'done' ? (
                <button className="btn btn-small rounded-lg border border-app-line px-3 py-1.5 text-xs" type="button" onClick={() => updateStatus(entry.handle, 'waiting')}>Requeue</button>
              ) : null}
              <button className="rounded-lg px-2 py-1.5 text-xs text-app-muted hover:text-app-accent" type="button" aria-label={`Remove @${entry.handle}`} onClick={() => setQueue((current) => current.filter((item) => item.handle !== entry.handle))}>Remove</button>
            </article>
          )
        })}
      </section>
    </main>
  )
}
