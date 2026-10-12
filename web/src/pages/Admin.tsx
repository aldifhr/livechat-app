/**
 * The admin console.
 *
 * A shell with a sidebar and three sections rather than a router: the sections are
 * tabs, and a tab that changes the URL would mean every one of them needs its own
 * history entry for no benefit — nobody links to "the overlay tab" without also
 * meaning a particular room, and that is what the URL is for once a room is
 * open.
 */

import { useState } from 'react'
import Sidebar, { type Section } from '../components/Sidebar'
import TokenGate from '../components/TokenGate'
import Rooms from '../sections/Rooms'
import OverlayBuilder from '../sections/OverlayBuilder'
import About from '../sections/About'

export default function Admin() {
  const [section, setSection] = useState<Section>('rooms')

  return (
    <div className="admin">
      <Sidebar section={section} onSelect={setSection} />
      <main className="content">
        <TokenGate />
        {section === 'rooms' && <Rooms onOpenOverlay={() => setSection('overlay')} />}
        {section === 'overlay' && <OverlayBuilder />}
        {section === 'about' && <About />}
      </main>
    </div>
  )
}