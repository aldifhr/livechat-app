import type { Metadata } from 'next'
import { productName, tagline } from '@/lib/config'
import './globals.css'

// Read on the server, so the title is a per-deployment setting rather than
// something written into a bundle at build time.
export const metadata: Metadata = {
  title: productName,
  description: tagline,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}