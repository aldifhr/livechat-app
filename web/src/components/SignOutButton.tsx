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
    // `signout` is what pins this to the bottom of the sidebar: the column is
    // 100vh tall and the auto margin takes whatever height is left over. Without
    // it the button sat directly under the last navigation item, which is where a
    // menu item goes and not where an action belongs.
    <form className="signout" action="/api/auth/logout" method="post">
      <button type="submit" className="side-item">
        Sign out
      </button>
    </form>
  )
}
