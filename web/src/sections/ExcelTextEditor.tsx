'use client'

/**
 * Visual editor for the Excel backgrounds.
 *
 * The old form was a wall of `h7`, `r3`, `note2` fields: every value was
 * editable but nobody could tell which one was which without opening the
 * overlay and guessing. This page renders the real SVG as a preview, labels
 * each editable node, and lets a click select the text to change. The URL it
 * builds is still just query parameters — this is an editor for them, not a
 * second copy of the overlay's state.
 */

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'

const OVERLAYS = {
  vertical: '/overlay/background-excel-vertical',
} as const
type Kind = keyof typeof OVERLAYS

const GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Judul dan rumus', keys: ['title', 'subtitle', 'cell', 'formula', 'time'] },
  { title: 'Header tabel', keys: Array.from({ length: 18 }, (_, i) => `h${i + 1}`) },
  { title: 'Kegiatan', keys: Array.from({ length: 6 }, (_, i) => `r${i + 1}`) },
  { title: 'Jam', keys: Array.from({ length: 6 }, (_, i) => `t${i + 1}`) },
  { title: 'Status', keys: Array.from({ length: 6 }, (_, i) => `s${i + 1}`) },
  {
    title: 'Total, catatan, sheet',
    keys: ['total', 'totalTime', 'totalPct', 'note', 'note1', 'note2', 'note3', 'note4', 'sheet1', 'sheet2', 'sheet3', 'sheet4'],
  },
]
const LABELS = Object.fromEntries(
  GROUPS.flatMap((g) => g.keys.map((k, i) => [k, `${g.title}${g.keys.length > 1 ? ` ${i + 1}` : ''}`])),
) as Record<string, string>

export default function ExcelTextEditor({ roomId }: { roomId: string }) {
  const kind: Kind = 'vertical'
  const [svgs, setSvgs] = useState<Partial<Record<Kind, string>>>({})
  const [defaults, setDefaults] = useState<Record<string, string>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [active, setActive] = useState('')
  const [search, setSearch] = useState('')
  const [origin, setOrigin] = useState('')
  const previewRef = useRef<HTMLDivElement>(null)

  useEffect(() => setOrigin(window.location.origin), [])

  // Fetch the served pages, not a hand-maintained copy of their markup: the
  // preview is therefore exactly what OBS will load, including any new data-k
  // added to the SVG later. DOMParser does not execute the page's scripts.
  useEffect(() => {
    let cancelled = false
    for (const [k, path] of Object.entries(OVERLAYS)) {
      fetch(`${path}?room=${encodeURIComponent(roomId)}`)
        .then((r) => r.text())
        .then((html) => {
          if (cancelled) return
          const doc = new DOMParser().parseFromString(html, 'text/html')
          const svg = doc.querySelector('svg')
          const found: Record<string, string> = {}
          doc.querySelectorAll('[data-k]').forEach((el) => {
            found[el.getAttribute('data-k') || ''] = el.textContent || ''
          })
          setSvgs((prev) => ({ ...prev, [k]: svg?.outerHTML || '' }))
          setDefaults((prev) => ({ ...prev, ...found }))
        })
        .catch(() => {})
    }
    return () => { cancelled = true }
  }, [roomId])

  // Reflect the current values and the selection on the preview itself.
  useEffect(() => {
    const root = previewRef.current
    if (!root) return
    root.querySelectorAll('[data-k]').forEach((el) => {
      const key = el.getAttribute('data-k') || ''
      if (Object.prototype.hasOwnProperty.call(values, key)) el.textContent = values[key]
      if (key === active) el.setAttribute('data-active', 'yes')
      else el.removeAttribute('data-active')
    })
  }, [values, active, svgs, kind])

  const query = useMemo(() => {
    const params = new URLSearchParams()
    if (roomId) params.set('room', roomId)
    for (const [key, value] of Object.entries(values)) if (value.trim()) params.set(key, value)
    return params.toString()
  }, [roomId, values])

  const reset = (key: string) => setValues((prev) => {
    const next = { ...prev }
    delete next[key]
    return next
  })

  const keys = Object.keys(defaults).sort()
  const filtered = keys.filter((key) => {
    const q = search.toLowerCase().trim()
    return !q || key.includes(q) || (defaults[key] || '').toLowerCase().includes(q) || (LABELS[key] || '').toLowerCase().includes(q)
  })

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Edit teks Excel</h1>
          <p className="faint tight-caption">
            Klik teks di preview untuk mengubahnya. Kosongkan field untuk memakai teks bawaan.
          </p>
        </div>
        <Link className="btn" href="/dashboard">Kembali</Link>
      </div>

      <div className="excel-editor-grid">
        <div className="panel">
          <div className="excel-preview-scroll">
            <div
              ref={previewRef}
              className={`excel-preview ${kind}`}
              onClick={(event) => {
                const el = (event.target as Element).closest('[data-k]')
                if (el) setActive(el.getAttribute('data-k') || '')
              }}
              dangerouslySetInnerHTML={{ __html: svgs[kind] || '' }}
            />
          </div>
        </div>

        <div className="panel">
          <h3>{active ? 'Ubah teks' : 'Pilih teks di preview'}</h3>
          {active && (
            <div className="field">
              <label htmlFor="excel-active">
                {LABELS[active] || active} — aslinya: <strong>{defaults[active] || '—'}</strong>
              </label>
              <input
                id="excel-active"
                autoFocus
                value={values[active] ?? ''}
                placeholder={defaults[active] || active}
                onChange={(event) => setValues((prev) => ({ ...prev, [active]: event.target.value }))}
              />
              <button className="btn" onClick={() => reset(active)}>Pakai teks bawaan</button>
            </div>
          )}

          <div className="field">
            <label htmlFor="excel-search">Cari teks</label>
            <input id="excel-search" value={search} placeholder="cari kata atau nama…" onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="excel-key-list">
            {filtered.map((key) => (
              <button
                key={key}
                className={`excel-key ${key === active ? 'active' : ''}`}
                onClick={() => setActive(key)}
                title={`${key} — ${defaults[key] || ''}`}
              >
                <span>{values[key] || defaults[key] || key}</span>
                <code>{key}</code>
              </button>
            ))}
            {!filtered.length && <p className="faint">Tidak ada yang cocok.</p>}
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>Link overlay</h3>
        {(Object.entries(OVERLAYS) as [Kind, string][]).map(([k, path]) => (
          <div className="stream-links" key={k}>
            <div className="link-line">
              <span className="link-line-label">Excel {k}</span>
              <code>{origin ? `${origin}${path}?${query}` : `${path}?${query}`}</code>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
