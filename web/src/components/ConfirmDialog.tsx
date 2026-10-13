'use client'

/**
 * The app's own confirmation dialog.
 *
 * `window.confirm` was the browser's, and it is the wrong tool for a destructive
 * question for three reasons. It cannot be styled, so it looks like the browser
 * rather than the product. It answers with "OK" and "Cancel" rather than naming
 * what is about to happen, so the button that deletes a room says OK. And it can
 * be suppressed — a visitor who once ticked "prevent this page from creating
 * additional dialogs" gets `false` back with no dialog shown at all, which turns
 * a guarded delete into an unguarded one. A confirmation that can silently
 * become "no" is worse than none, because the code reads as if it is guarded.
 *
 * Built on `<dialog>` rather than a styled `<div>`: `showModal()` provides the
 * focus trap, the Escape key, and the inert background for free, and those are
 * exactly the three things a hand-rolled overlay most often gets wrong.
 *
 * The cancel button takes focus, not the confirm. This dialog exists for actions
 * that cannot be undone, and the safe choice is the one that should be reachable
 * without aiming — Enter should back out, not destroy something.
 */

import { useEffect, useRef, type ReactNode } from 'react'

export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  cancelLabel?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    if (open && !dialog.open) {
      dialog.showModal()
      cancelRef.current?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="confirm-title"
      // Fired by Escape. Treated as a cancel rather than letting the dialog close
      // itself, so the parent's `open` state stays the single source of truth —
      // otherwise the element is closed but the state says open and it never
      // reopens.
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
      // A click on the backdrop lands on the <dialog> itself, because the panel
      // inside covers everything else. Closing on it is what people expect of a
      // modal; the click on the panel does not bubble out to here.
      onClick={(event) => {
        if (event.target === ref.current && !busy) onCancel()
      }}
    >
      <div className="dialog-panel">
        <h3 id="confirm-title">{title}</h3>
        <div className="dialog-body">{body}</div>
        <div className="dialog-actions">
          <button ref={cancelRef} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button className="danger-solid" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  )
}
