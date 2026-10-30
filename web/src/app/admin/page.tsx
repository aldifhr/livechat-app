import { redirect } from 'next/navigation'

/** The old console entry point, now the root. */
export default function AdminRedirect() {
  redirect('/dashboard')
}
