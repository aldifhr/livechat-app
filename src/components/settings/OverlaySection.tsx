import { useState } from 'react'
import { host } from '../../lib/sidecar'
import {
  clampNumber,
  clampRows,
  OVERLAY_DELAY,
  OVERLAY_MAX_ROWS,
  OVERLAY_SIZE,
  type OverlayStyle,
} from '../../lib/overlay'
import type { ViewSettings } from '../../hooks/useSettings'
import { message, useStillMounted, type SetSetting, type Status } from './shared'
import { Section } from './Section'

interface Props {
  settings: ViewSettings
  set: SetSetting
  /** The handle typed into the toolbar, for a link before a room is connected. */
  roomTarget: string
  /** The connected room's id, so the link can name it directly. */
  roomId: string
}

/**
 * The link that puts this chat on the stream.
 *
 * Holds its own status rather than sharing the dialog's line. That line reads
 * "can I save a key"; this one reads "is there a server for OBS to talk to", and
 * sharing one line means whichever ran last overwrites the other's answer — so a
 * successful model save would wipe the overlay's error, and the user would see a
 * green line under a setting that is not working.
 */
export function OverlaySection({ settings, set, roomTarget, roomId }: Props) {
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' })
  const [url, setUrl] = useState('')
  const stillMounted = useStillMounted()

  /** The styling, as the host wants it: one object rather than six fields. */
  function overlayStyle(): OverlayStyle {
    return {
      size: settings.overlaySize,
      max: settings.overlayMax,
      delay: settings.overlayDelay,
      bg: settings.overlayBg,
      nameColour: settings.overlayNameColour,
      textColour: settings.overlayTextColour,
      font: settings.overlayFont,
    }
  }

  /**
   * Builds the link and puts it on the clipboard.
   *
   * Both in one action on purpose. A button that only built it would leave the
   * one step that actually matters — getting it into OBS — as something to do by
   * hand, right when the link has styling in it that is tedious to retype.
   *
   * Clipboard access is not something the page can count on: the permission is
   * asked for and can be refused, and a webview with no focus never gets it. So
   * the URL is shown as well as copied, and a failure says so rather than leaving
   * a button that looks like it worked.
   */
  async function copyOverlayLink() {
    setStatus({ kind: 'busy', text: 'Building the link…' })
    try {
      // Pass the room id when there is one: the link becomes a bare `?room=<id>`,
      // which is one parameter nothing has to resolve. Falls back to the handle
      // when there is no id yet (not connected), which the page resolves itself.
      const built = await host.overlayUrl(roomTarget, overlayStyle(), roomId || undefined)
      if (!stillMounted.current) return
      setUrl(built)
      try {
        await navigator.clipboard.writeText(built)
        if (!stillMounted.current) return
        setStatus({
          kind: 'ok',
          text: `Copied. Add a Browser source in OBS and paste it in.${roomTarget ? '' : ' Set a handle above first.'}`,
        })
      } catch {
        if (!stillMounted.current) return
        setStatus({ kind: 'error', text: 'Could not reach the clipboard — copy the link below.' })
      }
    } catch (error: unknown) {
      if (!stillMounted.current) return
      setStatus({ kind: 'error', text: message(error) })
    }
  }

  /**
   * Asks whether the backend is actually serving the overlay.
   *
   * The overlay lives on the backend, so the question is "will OBS get the page
   * when it fetches this link" — answered by the backend answering, not by any
   * local server. A button rather than a standing status, because the answer
   * changes with the network and is worth checking right before a stream.
   */
  async function checkOverlay() {
    setStatus({ kind: 'busy', text: 'Checking…' })
    try {
      const running = await host.overlayRunning()
      if (!stillMounted.current) return
      setStatus(
        running
          ? { kind: 'ok', text: 'The overlay is live on the backend — OBS will get it.' }
          : {
              kind: 'error',
              text: 'The backend is not serving the overlay. Check the backend URL, or that the backend is up.',
            },
      )
    } catch (error: unknown) {
      if (!stillMounted.current) return
      setStatus({ kind: 'error', text: message(error) })
    }
  }

  /**
   * Opens the preview in a real browser.
   *
   * The host does it, not `window.open`: the page cannot navigate anywhere under
   * the app's content security policy, and a Preview button that silently does
   * nothing is worse than no button — it reads as the overlay being broken when
   * the overlay is the part that works.
   */
  async function openOverlay(built: string) {
    setStatus({ kind: 'busy', text: 'Opening the preview…' })
    try {
      await host.overlayOpen(built)
      if (!stillMounted.current) return
      setStatus({
        kind: 'ok',
        text: 'Opened in your browser. It looks the same there as it will in OBS.',
      })
    } catch (error: unknown) {
      if (!stillMounted.current) return
      setStatus({ kind: 'error', text: message(error) })
    }
  }

  return (
    <Section title="Stream overlay" section="overlay">
      <p className="modal-hint">
        A chat you can put straight on the stream. Copy the link, add a <strong>Browser</strong> source
        in OBS, paste it in, and leave it. It reads the same chat straight from the backend, so it keeps
        working while this window is closed.
      </p>

      {/* The numbers and colours in a grid — but only the controls, not their
          notes. A long note crammed into a grid cell wraps into a tall ragged
          tower beside its own input; the two notes that need explaining (delay
          and background) are pulled out below and span the full width, so the
          grid stays a tidy row of label-and-control. */}
      <div className="settings-grid">
        <label className="field">
          <span className="field-label">Text size</span>
          <input
            className="input"
            type="number"
            min={OVERLAY_SIZE.min}
            max={OVERLAY_SIZE.max}
            value={settings.overlaySize}
            onChange={(e) =>
              set('overlaySize', clampNumber(e.target.value, OVERLAY_SIZE.min, OVERLAY_SIZE.max, 22))
            }
          />
        </label>

        <label className="field">
          <span className="field-label">Messages on screen</span>
          <input
            className="input"
            type="number"
            min={OVERLAY_MAX_ROWS.min}
            max={OVERLAY_MAX_ROWS.max}
            value={settings.overlayMax}
            onChange={(e) => set('overlayMax', clampRows(e.target.value, 8))}
          />
        </label>

        <label className="field">
          <span className="field-label">Time between messages</span>
          <input
            className="input"
            type="number"
            min={OVERLAY_DELAY.min}
            max={OVERLAY_DELAY.max}
            step={50}
            value={settings.overlayDelay}
            onChange={(e) =>
              set(
                'overlayDelay',
                Math.round(clampNumber(e.target.value, OVERLAY_DELAY.min, OVERLAY_DELAY.max, 500)),
              )
            }
          />
        </label>

        <label className="field">
          <span className="field-label">Name colour</span>
          <input
            className="input overlay-colour"
            type="color"
            value={settings.overlayNameColour}
            onChange={(e) => set('overlayNameColour', e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Text colour</span>
          <input
            className="input overlay-colour"
            type="color"
            value={settings.overlayTextColour}
            onChange={(e) => set('overlayTextColour', e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Background</span>
          <input
            className="input"
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(settings.overlayBg * 100)}
            onChange={(e) => set('overlayBg', clampNumber(e.target.value, 0, 100, 0) / 100)}
          />
        </label>
      </div>

      <div className="overlay-notes">
        <span className="field-note">
          {settings.overlayDelay} ms between messages. A busy room talks faster than anyone reads, so
          without a gap the last {settings.overlayMax} land together and read as a wall.
        </span>
        <span className="field-note">
          {settings.overlayBg === 0
            ? 'No background — the video shows through.'
            : `${Math.round(settings.overlayBg * 100)}% black behind each line.`}
        </span>
      </div>

      <label className="field">
        <span className="field-label">Font</span>
        <input
          className="input"
          placeholder='"Segoe UI", system-ui, sans-serif'
          value={settings.overlayFont}
          onChange={(e) => set('overlayFont', e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <span className="field-note">
          A CSS font stack. A name with spaces in it has to be quoted, the way CSS wants it.
        </span>
      </label>

      <div className="field">
        <span className="field-label">Link for OBS</span>
        <span className="field-row">
          <button className="btn btn-small btn-primary" onClick={copyOverlayLink} disabled={status.kind === 'busy'}>
            {status.kind === 'busy' ? 'Copying…' : 'Copy link'}
          </button>
          <button className="btn btn-small" onClick={checkOverlay} disabled={status.kind === 'busy'}>
            Check server
          </button>
          {url !== '' && (
            <button className="btn btn-small" onClick={() => openOverlay(url)} title="Open it in a browser">
              Preview
            </button>
          )}
        </span>
        <span className="field-note">{status.text}</span>
        {url !== '' && <code className="overlay-url">{url}</code>}
      </div>
    </Section>
  )
}