/**
 * One platform's overview.
 *
 * `/app/<platform>` used to be the connect form. It is the dashboard now: the
 * platform is picked once, on `/app`, and everything after it is scoped to that
 * choice. Connecting is one action from here, at `/app/<platform>/connect`, so
 * the form is still reachable without being the first thing in the way.
 */

import Dashboard from '@/sections/Dashboard'
import type { StreamProvider } from '@/lib/types'

export default function PlatformDashboard({ provider }: { provider: StreamProvider }) {
  return <Dashboard provider={provider} />
}
