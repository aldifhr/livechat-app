/**
 * `/app` is the picker, and the picker is `/`.
 *
 * The two pages became the same thing the moment the landing page stopped being
 * a pitch, and one of them had to go. `/` keeps it, so the site's own address is
 * the front door; `/app` stays as a redirect because it was published and a link
 * someone saved should not 404.
 *
 * `/app/youtube` and `/app/tiktok` are untouched — those are the forms.
 */

import { redirect } from 'next/navigation'

export default function AppIndex(): never {
  redirect('/')
}
