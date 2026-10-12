'use client'

import { useState } from 'react'
import Rooms from '@/sections/Rooms'
import OverlayBuilder from '@/sections/OverlayBuilder'
import About from '@/sections/About'

type Section = 'rooms' | 'overlay' | 'about'

const ITEMS: { id: Section; label: string; hint: string }[] = [
  { id: 'rooms', label: 'Rooms', hint: 'Streams on the backend' },
  { id: 'overlay', label: 'Overlay builder', hint: 'Style and preview' },
  { id: 'about', label: 'About', hint: 'Addresses and account' },
]

/**
 * The console.
 *
 * One client component rather than a page per section, so moving between tabs is
 * not navigation and the rooms list does not re-fetch. The sections are views of
 * one screen: nobody links to "the overlay tab" without also meaning a room, and
 * a room is what the query string carries.
 *
 * The wordmark and the token flag arrive as props from the server, so nothing here
 * reads the environment.
 */
export default function Admin({
  wordmark,
  tokenConfigured,
  backend,
}: {
  wordmark: [string, string]
  tokenConfigured: boolean
  backend?: string
}) {
  const [section, setSection] = useState<Section>('rooms')
  // A room chosen on the Rooms tab, so "style the overlay" lands on that room
  // rather than making the operator pick it again on the other tab.
  const [roomId, setRoomId] = useState('')
  const [head, tail] = wordmark

  return (
    <div className="admin">
      <aside className="sidebar">
        <span className="wordmark">
          {head}
          {tail && <span>{tail}</span>}
        </span>
        <nav>
          {ITEMS.map((item) => (
            <button
              key={item.id}
              className="side-item"
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <p className="side-note">
          {ITEMS.find((item) => item.id === section)?.hint}
          <br />
          <br />
          The overlay is served over the web, so it keeps working when this dashboard is closed.
        </p>
      </aside>
      <main className="content">
        {!tokenConfigured && (
          <div className="notice error">
            This server has no API token, so creating and connecting rooms will be refused. Set
            STREAMKIT_TOKEN in the environment and restart.
          </div>
        )}
        {section === 'rooms' && (
          <Rooms
            onStyleOverlay={(id) => {
              setRoomId(id)
              setSection('overlay')
            }}
          />
        )}
        {section === 'overlay' && <OverlayBuilder initialRoom={roomId} />}
        {section === 'about' && <About backend={backend} />}
      </main>
    </div>
  )
}