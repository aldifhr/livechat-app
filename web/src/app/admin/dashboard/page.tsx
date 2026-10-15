import Dashboard from '@/sections/Dashboard'

/**
 * Every stream at once, at /admin/dashboard.
 *
 * Its own address rather than a panel on the streams page, because it is a
 * different question: that page asks "what is configured", this one asks "what is
 * happening". An operator who is about to go live wants the second without
 * scrolling past the first, and an operator with four streams wants the other
 * three summarised rather than hunted for.
 */
export default function DashboardPage() {
  return <Dashboard />
}