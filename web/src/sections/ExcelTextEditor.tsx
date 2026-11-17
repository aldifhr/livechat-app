'use client'

/**
 * Text editor for the two Excel meme backgrounds.
 *
 * The overlays take their copy from query parameters — no build, no deploy, no
 * stored style to keep in sync. This page is only a form that writes those
 * parameters and shows the resulting OBS links. Empty fields are left out, so
 * the overlay falls back to its own default text.
 */

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'

const GROUPS: { title: string; fields: { key: string; label: string }[] }[] = [
  {
    title: 'Judul dan rumus',
    fields: [
      { key: 'title', label: 'Judul file' },
      { key: 'subtitle', label: 'Subtitle' },
      { key: 'cell', label: 'Sel aktif' },
      { key: 'formula', label: 'Rumus' },
    ],
  },
  {
    title: 'Header tabel',
    fields: [
      { key: 'h1', label: 'Header 1' }, { key: 'h2', label: 'Header 2' },
      { key: 'h3', label: 'Header 3' }, { key: 'h4', label: 'Header 4' },
      { key: 'h5', label: 'Header 5' }, { key: 'h6', label: 'Header 6' },
      { key: 'h7', label: 'Header 7' }, { key: 'h8', label: 'Header 8' },
      { key: 'h9', label: 'Header 9' }, { key: 'h10', label: 'Header 10' },
      { key: 'h11', label: 'Header 11' }, { key: 'h12', label: 'Header 12' },
      { key: 'h13', label: 'Header 13' }, { key: 'h14', label: 'Header 14' },
      { key: 'h15', label: 'Header 15' }, { key: 'h16', label: 'Header 16' },
      { key: 'h17', label: 'Header 17' }, { key: 'h18', label: 'Header 18' },
    ],
  },
  {
    title: 'Baris kegiatan, jam, status',
    fields: [
      ...Array.from({ length: 6 }, (_, i) => ({ key: `r${i + 1}`, label: `Kegiatan ${i + 1}` })),
      ...Array.from({ length: 6 }, (_, i) => ({ key: `t${i + 1}`, label: `Jam ${i + 1}` })),
      ...Array.from({ length: 6 }, (_, i) => ({ key: `s${i + 1}`, label: `Status ${i + 1}` })),
    ],
  },
  {
    title: 'Total, catatan, sheet',
    fields: [
      { key: 'total', label: 'Label total' },
      { key: 'totalTime', label: 'Nilai jam' },
      { key: 'totalPct', label: 'Persentase' },
      ...Array.from({ length: 4 }, (_, i) => ({ key: `note${i + 1}`, label: `Catatan ${i + 1}` })),
      { key: 'note', label: 'Catatan vertikal' },
      ...Array.from({ length: 4 }, (_, i) => ({ key: `sheet${i + 1}`, label: `Tab sheet ${i + 1}` })),
    ],
  },
]

export default function ExcelTextEditor({ roomId }: { roomId: string }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [origin, setOrigin] = useState('')

  useEffect(() => setOrigin(window.location.origin), [])

  const query = useMemo(() => {
    const params = new URLSearchParams()
    if (roomId) params.set('room', roomId)
    for (const [key, value] of Object.entries(values)) {
      if (value.trim()) params.set(key, value)
    }
    return params.toString()
  }, [roomId, values])

  const links = [
    { label: 'Excel horizontal', path: '/overlay/background-excel' },
    { label: 'Excel vertikal', path: '/overlay/background-excel-vertical' },
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Edit teks Excel</h1>
          <p className="faint tight-caption">
            Kosongkan field untuk memakai teks bawaan. Salin link di bawah ke browser source OBS atau TikTok LIVE Studio.
          </p>
        </div>
        <Link className="btn" href="/dashboard">Kembali</Link>
      </div>

      {GROUPS.map((group) => (
        <div className="panel" key={group.title}>
          <h3>{group.title}</h3>
          <div className="field-row">
            {group.fields.map((field) => (
              <div className="field" key={field.key}>
                <label htmlFor={`excel-${field.key}`}>{field.label}</label>
                <input
                  id={`excel-${field.key}`}
                  value={values[field.key] ?? ''}
                  onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                  placeholder={field.key}
                />
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="panel">
        <h3>Link overlay</h3>
        {links.map((link) => {
          const url = `${origin}${link.path}?${query}`
          return (
            <div className="stream-links" key={link.path}>
              <div className="link-line">
                <span className="link-line-label">{link.label}</span>
                <code>{url}</code>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
