import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { productName, tagline } from '@/lib/server/config'
import './globals.css'
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});


// Read on the server, so the title is a per-deployment setting rather than
// something written into a bundle at build time.
export const metadata: Metadata = {
  title: productName,
  description: tagline,
}

/**
 * The theme cookie: `light`, `dark`, or `system`.
 *
 * Read on the server so the first paint is already the right mode — a class set
 * only by a client effect is a flash of the wrong theme on every navigation.
 *
 * The inline script below is the single authority on the class, and it runs
 * before the body paints. The server cannot resolve `system` (the OS preference
 * lives in the browser) and it also cannot see a cookie that a *later* navigation
 * changes without a full reload, so rather than have the server and the script
 * each guess and disagree — which is a hydration mismatch on `<html>` — the
 * script owns the decision and the server only provides the class for the
 * no-JavaScript case.
 */
const THEME_COOKIE = 'streamkit_theme'

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies()
  const theme = jar.get(THEME_COOKIE)?.value
  // A best-effort class for the no-JavaScript case. When the script runs it
  // overwrites this to the correct value; `suppressHydrationWarning` below is
  // what lets the two differ without React reporting it.
  const initialDark = theme === 'dark'

  return (
    <html
      lang="en"
      className={cn('font-sans', geist.variable, initialDark && 'dark')}
      suppressHydrationWarning
    >
      <head>
        {/* Runs before the body paints, and is the one thing that decides the
            class. With no cookie it follows the OS; with one it obeys it. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]+)/);var t=m?decodeURIComponent(m[1]):'system';var d=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  )
}
