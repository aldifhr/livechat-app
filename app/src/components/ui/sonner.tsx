import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

import { cn } from "@/lib/utils"

/**
 * Sonner's stock wrapper reads the theme from `next-themes`. This app is Vite,
 * not Next, and it has no light/dark split to report — the two looks here are
 * `default` and `brutalism`, applied as Tailwind classes on the app root rather
 * than as a colour scheme at all. So there is nothing for `next-themes` to say
 * that this app does not already know, and adopting it would mean shipping a
 * second theme mechanism that disagrees with the first.
 *
 * The variables below are the reason none of that wiring is needed: they read the
 * app's own palette, which is set as arbitrary properties on the app root and so
 * already follows whichever look is selected.
 */
const Toaster = ({ className, ...props }: ToasterProps) => {
  return (
    <Sonner
      className={cn("toaster group", className)}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--panel)",
          "--normal-text": "var(--text)",
          "--normal-border": "var(--line)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }