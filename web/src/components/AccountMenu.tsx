'use client'

/**
 * The account menu: one gear at the bottom of the sidebar, and the things that
 * are about *you* rather than about a stream.
 *
 * Change password and sign out used to be two separate things in two separate
 * places — one a page among the sections, the other a bare button pinned to the
 * bottom of the column. Neither shape is right. A password form is not a section
 * of the console, so listing it beside "Logs" claimed it was; and a bare Sign out
 * with nothing grouped around it is an action with no home, which is what a gear
 * is for.
 *
 * **A `<details>`, not a button and a `useState`.** That is the whole reason this
 * works with JavaScript off, and the reason the sign-out inside it is still a real
 * `<form method="post">` rather than a fetch. The logout route answers with a
 * redirect and an already-expired cookie, and a form POST is the one thing that
 * makes the browser follow that redirect *and* take the new cookie with it. That
 * mattered when it was a standalone button on the one page you might need when
 * something else is already broken, and it still matters now that it is one click
 * deeper. The JavaScript here only adds the two things `<details>` cannot do on
 * its own — Escape, and clicking away — so a browser without it still opens the
 * menu, navigates, and signs out.
 */

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export default function AccountMenu() {
  const details = useRef<HTMLDetailsElement>(null)
  const pathname = usePathname()
  // The gear stands in for the page you are on, since the pages it opens are no
  // longer navigation items. A menu that is open and does not know what it
  // contains is what makes a gear feel decorative.
  const inMenu = pathname.startsWith('/admin/setting')

  // `<details>` toggles itself and nothing else. Escape and an outside click are
  // the two a user expects and it does not do, so they are added here — and added
  // *only* here, so a browser that never runs this still has a working menu.
  useEffect(() => {
    const close = () => details.current?.removeAttribute('open')
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    // Bound to the document rather than to a wrapper, because a click that closes
    // the menu is usually a click somewhere else entirely.
    const onClick = (event: MouseEvent) => {
      if (details.current && !details.current.contains(event.target as Node)) close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('click', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('click', onClick)
    }
  }, [])

  return (
    <details className="account-menu" ref={details}>
      <summary className="side-item" aria-current={inMenu ? 'page' : undefined}>
        <span className="nav-icon" aria-hidden="true">
          ⚙
        </span>
        Account
      </summary>

      <div className="account-menu-panel">
        <Link className="account-menu-item" href="/admin/setting/change-password" onClick={() => details.current?.removeAttribute('open')}>
          <span className="nav-icon" aria-hidden="true">
            ⚿
          </span>
          Change password
        </Link>
        <Link className="account-menu-item" href="/admin/logs" onClick={() => details.current?.removeAttribute('open')}>
          <span className="nav-icon" aria-hidden="true">
            ≡
          </span>
          Backend logs
        </Link>

        {/* Still a form, still a POST. See the note at the top: the logout route
            answers with a redirect, and this is the only thing that makes the
            browser follow it with the new cookie in hand. */}
        <form action="/api/auth/logout" method="post">
          <button type="submit" className="account-menu-item danger">
            <span className="nav-icon" aria-hidden="true">
              ⏻
            </span>
            Sign out
          </button>
        </form>
      </div>
    </details>
  )
}
