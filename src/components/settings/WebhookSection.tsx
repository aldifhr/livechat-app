import { useCallback, useEffect, useState } from 'react'
import { host } from '../../lib/sidecar'
import { EMPTY_WEBHOOK, EXAMPLE_WEBHOOK_URL, isWebhookReady, type WebhookConfig } from '../../lib/webhook'
import { message, useStillMounted, type Status } from './shared'
import { Section } from './Section'

interface Props {
  status: Status
  setStatus: (status: Status) => void
}

/**
 * Posts gift details to a URL of the user's, so another app can react to them.
 *
 * Saved as it is typed rather than behind a Save button, like every other setting
 * in this dialog: the host reads the config at send time, so a change lands on the
 * next gift with nothing to press. That autosave is why this section owns the
 * config it edits rather than receiving it — the value and the effect that
 * persists it have to live together, or the read and the write drift apart.
 */
export function WebhookSection({ status, setStatus }: Props) {
  const [webhook, setWebhook] = useState<WebhookConfig>(EMPTY_WEBHOOK)
  const [revealToken, setRevealToken] = useState(false)
  const stillMounted = useStillMounted()

  // Read on its own, so a save takes effect on the next gift without reopening the
  // dialog and without a restart.
  useEffect(() => {
    host
      .webhookConfigGet()
      .then((saved) => {
        if (!stillMounted.current) return
        setWebhook(saved)
      })
      .catch(() => {
        // An unconfigured webhook is the default state, not a fault.
      })
  }, [stillMounted])

  useEffect(() => {
    void host.webhookConfigSave(webhook).catch(() => {
      // A read-only config directory is not worth interrupting the dialog over; the
      // test button will say the send failed if it comes to that.
    })
  }, [webhook])

  const setWebhookField = useCallback(<K extends keyof WebhookConfig>(key: K, value: WebhookConfig[K]) => {
    setWebhook((previous) => ({ ...previous, [key]: value }))
  }, [])

  async function testWebhook() {
    setStatus({ kind: 'busy', text: 'Sending a test gift…' })
    try {
      const said = await host.webhookTest()
      if (!stillMounted.current) return
      setStatus({ kind: 'ok', text: said })
    } catch (error: unknown) {
      if (!stillMounted.current) return
      // The host's message verbatim: "404" and "401" are fixed differently, and the
      // user can only fix the one they are told about.
      setStatus({ kind: 'error', text: message(error) })
    }
  }

  return (
    <Section title="Webhook" section="webhook">
      <p className="modal-hint">
        When a gift arrives, its details are posted to the URL below so another app can react — an
        overlay, an alert, a bot. The token is stored on this machine and sent from the app&rsquo;s host,
        never from this window.
      </p>

      <label className="toggle">
        <input
          type="checkbox"
          checked={webhook.enabled}
          onChange={(e) => setWebhookField('enabled', e.target.checked)}
        />
        <span>Send gifts to a webhook</span>
      </label>

      <label className="field">
        <span className="field-label">Webhook URL</span>
        <input
          className="input"
          placeholder={EXAMPLE_WEBHOOK_URL}
          value={webhook.url}
          onChange={(e) => setWebhookField('url', e.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={!webhook.enabled}
        />
        <span className="field-note">
          Where the gift is posted. Left empty, nothing is sent even when the toggle is on.
        </span>
      </label>

      <label className="field">
        <span className="field-label">Webhook token</span>
        <span className="field-row">
          <input
            className="input"
            type={revealToken ? 'text' : 'password'}
            placeholder="optional"
            value={webhook.token}
            onChange={(e) => setWebhookField('token', e.target.value)}
            spellCheck={false}
            autoComplete="off"
            disabled={!webhook.enabled}
          />
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setRevealToken((v) => !v)}
            disabled={!webhook.enabled}
          >
            {revealToken ? 'Hide' : 'Show'}
          </button>
        </span>
        <span className="field-note">
          Sent as an Authorization header, not in the URL — a token in a query string ends up in the
          receiving server&rsquo;s access log. Leave empty to send no header.
        </span>
      </label>

      <div className="modal-actions">
        <span className="modal-spacer" />
        <button
          className="btn btn-small"
          onClick={testWebhook}
          disabled={!webhook.enabled || !isWebhookReady(webhook) || status.kind === 'busy'}
          title="Send one test gift and show what came back"
        >
          HTTP test
        </button>
      </div>
    </Section>
  )
}