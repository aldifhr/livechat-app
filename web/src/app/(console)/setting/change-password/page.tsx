'use client'

import { useRouter } from 'next/navigation'
import PasswordPanel from '@/components/PasswordPanel'

/**
 * Changing the dashboard password, at `/setting/change-password`.
 *
 * The form is not a panel on something else, it is a task with a beginning and an
 * end, and it deserves an address that can be bookmarked. The session key is
 * derived from this password, so changing it signs every device out.
 */
export default function ChangePassword() {
  const router = useRouter()

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Change password</h2>
          <p className="muted">
            The dashboard's own account. The session key is derived from this
            password, so changing it signs every device out — including this one, on
            its next page.
          </p>
        </div>
      </div>

      <div className="panel">
        <PasswordPanel onDone={() => router.push('/dashboard')} />
      </div>
    </>
  )
}
