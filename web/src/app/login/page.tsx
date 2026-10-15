import { productName, splitWordmark, tagline } from '@/lib/config'
import LoginForm from '@/components/LoginForm'

// Per request: the product name comes from the environment, and a prerendered
// page would freeze whatever it was at build time.
export const dynamic = 'force-dynamic'

/**
 * What the product does, in the few facts a streamer needs before typing a
 * password. Written here rather than fetched, so the page still says what this
 * is when the dashboard behind it is down.
 */
const POINTS = [
  'Point OBS at one link — comments, gifts and joins roll on screen.',
  'Style it once: your colours, your font, your speed.',
  'It keeps running while this dashboard is closed.',
]

/**
 * Where a request without a session is sent.
 *
 * Two halves rather than a card floating in an empty frame: the left says what
 * this is, the right is the way in. A lone form on a black page reads as a
 * staging page; the same form beside the product reads as its front door. The
 * left half is dropped on a narrow screen, where it would only push the form off
 * the edge.
 *
 * A server component, so the wordmark comes from the environment like it does on
 * every other page and `next` is sanitised here rather than trusted by the
 * browser.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const next = safeNext(params.next)
  const [head, tail] = splitWordmark(productName)

  return (
    <main className="login">
      <section className="login-brand">
        <span className="wordmark login-lockup">
          {head}
          {tail && <span>{tail}</span>}
        </span>

        <div className="login-pitch">
          <h2>Live chat that looks like it belongs on stream.</h2>
          {tagline && <p className="muted flush-top">{tagline}</p>}
          <ul className="login-points">
            {POINTS.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>

        {/* The one thing worth saying before a password is typed: the overlays
            are NOT behind it. A streamer who assumed their OBS link was
            protected by this page would be wrong, and this is the only place
            they look. */}
        <p className="faint login-foot">
          Your overlays stay public — OBS cannot type a password. Only this dashboard is behind one.
        </p>
      </section>

      <section className="login-panel">
        <div className="login-card">
          {/* Shown only when the brand half is dropped, so the form is never
              anonymous about whose sign-in it is. */}
          <span className="wordmark login-lockup-sm">
            {head}
            {tail && <span>{tail}</span>}
          </span>
          <h1>Sign in</h1>
          <p className="muted flush-top">Enter the dashboard password to manage rooms and overlays.</p>
          <LoginForm next={next} />
        </div>
      </section>
    </main>
  )
}

/**
 * The address to land on after signing in.
 *
 * Only a path on this site is accepted. A `next` that could name another host
 * would make this page an open redirect: a link to the real login that drops the
 * visitor on somebody else's copy of it, with their password.
 */
function safeNext(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/admin/dashboard'
  return raw
}
