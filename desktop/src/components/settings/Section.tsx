import type { ReactNode } from 'react'

/**
 * One group of settings, collapsed behind its title.
 *
 * The dialog holds nine groups and used to render every one of them open in a
 * single scroll — so reaching the model settings meant scrolling past theme, font,
 * density, panels, feed, sounds and webhook, most of which a user touches once and
 * never again. Each group is a native `<details>`, collapsed by default: the titles
 * are a table of contents you scan at a glance, and opening one hides the other six
 * rather than pushing them further down.
 *
 * Native `<details>` rather than JS state because the open/closed behaviour is the
 * browser's, not something to rebuild: keyboard, screen readers and the disclosure
 * triangle all work without a line of code, and there is no `openSection` state to
 * keep in step.
 *
 * `defaultOpen` keeps the group people return to — Look — in the
 * state most useful on open, while the rarely-touched ones stay shut.
 *
 * The `<summary>` has to stay an immediate child of the `<details>` so the
 * Tailwind open-state variant can rotate its chevron.
 */
export function Section({
  title,
  defaultOpen = false,
  section,
  children,
}: {
  title: string
  defaultOpen?: boolean
  /** Becomes `data-section`, which is how the UI tests find a group. */
  section?: string
  children: ReactNode
}) {
  return (
    <details className="settings-section mx-auto flex w-full max-w-[900px] flex-col gap-2.5 border-t border-app-line pt-1 [&[open]_>_.settings-heading::before]:[transform:rotate(90deg)]" data-section={section} open={defaultOpen}>
      <summary className="settings-heading mt-1 flex cursor-pointer list-none items-center gap-1.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-app-muted hover:text-app-text [&::-webkit-details-marker]:[display:none] [&::before]:[content:'▸'] [&::before]:[font-size:9px] [&::before]:[transition:transform_0.15s_ease]">
        {title}
      </summary>
      <div className="settings-body flex flex-col gap-2.5 pt-1">{children}</div>
    </details>
  )
}
