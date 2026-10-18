import type { Metadata } from 'next'
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("dark font-sans", geist.variable)}>
      <body>{children}</body>
    </html>
  )
}