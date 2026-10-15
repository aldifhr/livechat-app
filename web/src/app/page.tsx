import Link from 'next/link'
import { productName, splitWordmark, tagline } from '@/lib/config'
import Reveal, { Rule } from '@/components/Reveal'

// Per request, for the same reason as /admin: the name and the copy come from
// the environment, and a prerendered page would freeze them at build time.
export const dynamic = 'force-dynamic'

/**
 * The two things you put in OBS.
 *
 * Split in two because they are not the same kind of claim. These are the
 * product — two overlays, and a visitor who never signs in can see all of it on
 * this page. Everything under them is a reason to believe the first two.
 *
 * The old page put all four in a four-up grid of identical cards, which gave
 * "Any machine" the same weight as the chat overlay and left the page with no
 * shape at all.
 */
const OVERLAYS = [
  {
    index: '01',
    title: 'Chat overlay',
    body: 'Comments and gifts, styled with your colours and your font. The link is the whole configuration — read it back and you know what OBS was pointed at.',
  },
  {
    index: '02',
    title: 'Top chatters',
    body: 'A leaderboard that counts who actually talked, so the busiest voice in the room is the one on screen.',
  },
]

const REASONS = [
  {
    index: '03',
    title: 'Preview before you go live',
    body: 'The preview is the overlay itself in a box, not a screenshot of it. What you tune is what OBS loads.',
  },
  {
    index: '04',
    title: 'Any machine',
    body: 'The overlay is served over the web, so the stream laptop can restart mid-show without taking the overlay with it.',
  },
]

/**
 * The landing page. A server component: the copy and the product name come from
 * `server-only` config, and this page is the reason that stays true rather than
 * moving to the client.
 *
 * It is not, and is no longer, a page that ships no JavaScript. It ships very
 * little — the only hydrated part is `Reveal`, which owns the entrances and
 * passes the page's markup through — but it ships some, and saying so is more
 * useful than leaving a comment that stopped being true.
 *
 * Motion is `Reveal`'s rather than this page's, for the same reason: a page that
 * imports `motion` is a client page, and a client page cannot read `server-only`
 * config. So the animations live at the boundary and this file stays on the
 * server.
 *
 * One change from the page it replaces: the secondary call to action pointed at
 * `/overlay/chat-overlay`, which is a working address for nobody. With no
 * `?room=` on it that page renders "no handle in this link", so the one thing on
 * this page that promised to show the product working showed a link with a
 * mistake in it. It is now an anchor to the list below, which works.
 */
export default function Landing() {
  const [head, tail] = splitWordmark(productName)

  return (
    <div className="landing flex min-h-full flex-col">
      <header className="flex flex-wrap items-baseline gap-x-8 gap-y-2 border-b border-line-soft px-[clamp(1rem,5vw,4rem)] py-5">
        <span className="text-[1.05rem] font-bold tracking-tight text-text">
          {head}
          {tail && <span className="text-accent">{tail}</span>}
        </span>
        <Link
          href="/admin"
          className="ml-auto text-sm text-dim underline-offset-4 hover:text-text hover:underline"
        >
          Dashboard
        </Link>
      </header>

      <main className="flex-1">
        {/* Two columns at a width and one below it, rather than a centred block at
            every width: the headline and the sales pitch are different lengths and
            stacking them side by side lets each be set at its own size. Centred
            text also has to be re-measured at every breakpoint, which is why the
            line below the headline used to break in a different place on every
            screen it was seen on. */}
        <section className="grid gap-x-16 gap-y-10 px-[clamp(1rem,5vw,4rem)] pt-[clamp(2.5rem,8vw,6rem)] pb-[clamp(2.5rem,6vw,4.5rem)] lg:grid-cols-12">
          <div className="lg:col-span-7">
            <Reveal delay={0}>
              <p className="font-mono text-xs tracking-[0.18em] text-faint uppercase">Live chat overlays</p>
            </Reveal>
            <Reveal delay={0.06}>
              <h1 className="mt-6 max-w-[13ch] text-[clamp(2.5rem,7.5vw,5.25rem)] leading-[0.96] tracking-[-0.035em] text-text text-balance">
                A chat that belongs on the stream.
              </h1>
            </Reveal>
          </div>

          <div className="lg:col-span-5 lg:pt-14">
            <Reveal delay={0.14}>
              {tagline && <p className="text-lg leading-relaxed text-text">{tagline}</p>}
              <p className="mt-4 leading-relaxed text-dim">
                Point OBS at a link, pick your colours, and the comments roll up the screen while you talk. No
                scene to build, no browser source to configure by hand.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
                <Link
                  href="/admin"
                  className="rounded-md bg-accent px-5 py-2.5 font-semibold text-accent-ink transition-colors hover:bg-accent-dim hover:text-accent-ink"
                >
                  Build an overlay
                </Link>
                <a
                  href="#what-it-does"
                  className="text-sm text-faint underline-offset-4 hover:text-dim hover:underline"
                >
                  What it does
                </a>
              </div>
            </Reveal>
          </div>
        </section>

        {/* Hairlines rather than cards. A card is a box drawn around a claim, and
            it gives four claims the same weight — the reason this page had no
            shape. A rule says "this is a different order of thing". */}
        <Rule className="h-px bg-line-soft px-[clamp(1rem,5vw,4rem)]" />

        <section
          id="what-it-does"
          className="scroll-mt-8 px-[clamp(1rem,5vw,4rem)] py-[clamp(2.25rem,5vw,3.5rem)]"
        >
          <div className="grid gap-y-12 md:grid-cols-2 md:gap-x-16">
            {OVERLAYS.map((item, i) => (
              <Reveal key={item.index} inView delay={i * 0.08}>
                <article>
                  <p className="font-mono text-xs text-faint">{item.index}</p>
                  <h2 className="mt-3 text-2xl tracking-tight text-text">{item.title}</h2>
                  <p className="mt-3 leading-relaxed text-dim">{item.body}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </section>

        <Rule className="h-px bg-line-soft px-[clamp(1rem,5vw,4rem)]" />

        <section className="px-[clamp(1rem,5vw,4rem)] py-[clamp(2.25rem,5vw,3.5rem)]">
          <div className="grid gap-y-10 md:grid-cols-2 md:gap-x-16">
            {REASONS.map((item, i) => (
              <Reveal key={item.index} inView delay={i * 0.08}>
                <article className="md:border-l md:border-line-soft md:pl-6">
                  <p className="font-mono text-xs text-faint">{item.index}</p>
                  <h2 className="mt-2 text-base tracking-tight text-text">{item.title}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-dim">{item.body}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </section>
      </main>

      {/* `tagline` rather than the sentence it used to repeat: the footer was the
          one place on the page that could not be changed without an edit, which
          is the opposite of every other word on it. */}
      <footer className="mt-auto flex flex-wrap items-baseline gap-x-4 border-t border-line-soft px-[clamp(1rem,5vw,4rem)] py-5 text-sm text-faint">
        <span>{productName}</span>
        {tagline && <span>{tagline}</span>}
      </footer>
    </div>
  )
}