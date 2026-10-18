import { BACKEND } from '@/lib/server/backend'
import About from '@/sections/About'

/**
 * Addresses and account.
 *
 * A server component, because the backend address comes from the environment and
 * has no business being read in the browser: it is a fact about this deployment,
 * not something the page needs to compute.
 */
export default function AboutPage() {
  return <About backend={BACKEND} />
}