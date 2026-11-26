'use client'

/**
 * Visual editor for the vertical Excel background.
 *
 * The overlay builds part of its grid in JavaScript, so parsing the HTML with
 * DOMParser misses half the editable text. The preview is therefore a real
 * iframe: the page runs exactly as OBS will load it, and on load we attach a
 * click handler to every [data-k] node inside its document. The overlay's own
 * socket connect is disabled in the preview (empty baseUrl) so the editor does
 * not open a second live connection.
 */

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'

const OVERLAY_PATH = '/overlay/background-excel-vertical'

const GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Judul dan rumus', keys: ['title', 'subtitle', 'cell', 'formula', 'time'] },
  { title: 'Header tabel', keys: ['h1', 'h2', 'h3', 'h4'] },
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
  const [doc, setDoc] = useState('')
  const [defaults, setDefaults] = useState<Record<string, string>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [active, setActive] = useState('')
  const [search, setSearch] = useState('')
  const [origin, setOrigin] = useState('')
  const frameRef = useRef<HTMLIFrameElement>(null)
  const pickRef = useRef<(key: string) => void>(() => {})

  pickRef.current = (key: string) => setActive(key)

  useEffect(() => setOrigin(window.location.origin), [])

  // Fetch the served page, not a hand-maintained copy. Disable the two things
  // that would fight the editor: the live socket and the status-flip timer.
  useEffect(() => {
    let cancelled = false
    fetch(`${OVERLAY_PATH}?room=${encodeURIComponent(roomId)}`)
      .then((r) => r.text())
      .then((html) => {
        if (cancelled) return
        const preview = html
          .replace(/<script id="overlay-config"[^>]*>[\s\S]*?<\/script>/, '<script id="overlay-config" type="application/json">{"baseUrl":""}</script>')
          .replace('  setInterval(function () {', '  if (false) setInterval(function () {')
          .replace('</head>', '<style>#live-note{display:none!important}</style></head>')
        setDoc(preview)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [roomId])

  function apply(d: Document) {
    d.querySelectorAll('[data-k]').forEach((el) => {
      const key = el.getAttribute('data-k') || ''
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        el.textContent = values[key]
        if (key === 'time') el.removeAttribute('data-live')
      }
      ;(el as HTMLElement).style.outline = key === active ? '3px solid #ff3e00' : ''
    })
  }

  useEffect(() => {
    if (frameRef.current?.contentDocument) apply(frameRef.current.contentDocument)
  }, [values, active, doc])

  function wire() {
    const d = frameRef.current?.contentDocument
    if (!d || !d.querySelector('svg')) return
    const found: Record<string, string> = {}
    d.querySelectorAll('[data-k]').forEach((el) => {
      const key = el.getAttribute('data-k') || ''
      found[key] = el.textContent || ''
      ;(el as HTMLElement).style.cursor = 'pointer'
      el.addEventListener('click', () => pickRef.current(key))
    })
    setDefaults(found)
    apply(d)
  }

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
            <iframe
              ref={frameRef}
              className="excel-frame"
              title="Excel overlay preview"
              srcDoc={doc}
              onLoad={wire}
              sandbox="allow-scripts allow-same-origin"
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
        <div className="stream-links">
          <div className="link-line">
            <span className="link-line-label">Excel vertikal</span>
            <code>{origin ? `${origin}${OVERLAY_PATH}?${query}` : `${OVERLAY_PATH}?${query}`}</code>
          </div>
        </div>
      </div>
    </div>
  )
}
