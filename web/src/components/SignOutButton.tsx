'use client'

/**
 * Signing out.
 *
 * A real form, not a button with a fetch: the server answers with a redirect and
 * a cookie that has already expired, and a form POST is the one way to make the
 * browser both follow that redirect and take the new cookie with it. It also
 * works with JavaScript off, which matters on the one page you may need when
 * something else is broken.
 */

export default function SignOutButton() {
  return (
    <form action="/api/auth/logout" method="post">
      <button type="submit" className="side-item">
        Sign out
      </button>
    </form>
  )
}
