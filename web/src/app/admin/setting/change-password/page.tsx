'use client'

import { useRouter } from 'next/navigation'
import PasswordPanel from '@/components/PasswordPanel'

/**
 * Changing the dashboard password, on its own address.
 *
 * It lived on the About page, and when About came out of the navigation the
 * ability went with it — `PasswordPanel` had no other caller, so the one thing an
 * operator must always be able to do was reachable only by typing a URL. It moved
 * to the overview for a while, which put a password form under a viewer chart on a
 * page that is read while a stream is running.
 *
 * A page of its own is the honest shape for it. The form is not a panel on
 * something else, it is a task with a beginning and an end, and it deserves an
 * address that can be bookmarked and sent to whoever holds the account.
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
        <PasswordPanel onDone={() => router.push('/admin/dashboard')} />
      </div>
    </>
  )
}
