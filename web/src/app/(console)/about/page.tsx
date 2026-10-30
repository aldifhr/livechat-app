import { BACKEND } from '@/lib/server/backend'
import About from '@/sections/About'

/**
 * Addresses and account, at `/about`.
 *
 * A server component, because the backend address comes from the environment and
 * has no business being read in the browser.
 */
export default function AboutPage() {
  return <About backend={BACKEND} />
}
