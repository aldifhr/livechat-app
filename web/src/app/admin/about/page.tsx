import { BACKEND_ORIGIN } from '@/lib/server/backend'
import About from '@/sections/About'

/**
 * Addresses and account.
 *
 * A server component, because the backend address comes from the environment and
 * has no business being read in the browser: it is a fact about this deployment,
 * not something the page needs to compute.
 *
 * The browser-facing origin rather than the loopback one this server fetches
 * with: the gift gallery link below is followed by a person, not by this process.
 */
export default function AboutPage() {
  return <About backend={BACKEND_ORIGIN} />
}