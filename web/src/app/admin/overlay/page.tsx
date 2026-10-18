import { redirect } from 'next/navigation'

/**
 * The old overlay builder address.
 *
 * The customizers moved under each stream — /admin/streams/@handle/overlay/chat —
 * because styling belongs to a stream, so there is no builder page here any more.
 * This redirect keeps links and bookmarks made before the move working.
 */
export default function OverlayRedirect() {
  redirect('/admin/streams')
}
