import { useState } from 'react'
import { host } from '../../lib/sidecar'
import { EXAMPLE_BASE_URL, modelOptions, normaliseBaseUrl, type LlmConfig } from '../../lib/llm'
import { message, useStillMounted, type Status } from './shared'
import { Section } from './Section'

interface Props {
  config: LlmConfig
  savedModel: LlmConfig
  models: string[]
  setConfigField: <K extends keyof LlmConfig>(key: K, value: LlmConfig[K]) => void
  setSaved: (saved: LlmConfig) => void
  forget: () => void
  setModelList: (found: string[]) => void
  status: Status
  setStatus: (status: Status) => void
  /** Whether an endpoint and key are both filled in, decided once for the dialog. */
  ready: boolean
  onClose: () => void
}

/**
 * The model endpoint: where it is, what it is called, and the key to reach it.
 *
 * The only section that renders the shared status line, which reads oddly until you
 * know why: sounds and webhook both report through the same line, and this one is
 * open by default so it is where a message lands. It is also where the dialog's
 * most consequential actions live — saving and forgetting a key — so the result of
 * any of them belongs next to the button that caused it.
 *
 * The saved values come from `useLlmConfig` rather than being held here, because
 * the AI answers section needs the same "is a model configured" answer and two
 * copies of this state could disagree between a keystroke and the re-render after
 * it.
 */
export function ModelSection({
  config,
  savedModel,
  models,
  setConfigField,
  setSaved,
  forget,
  setModelList,
  status,
  setStatus,
  ready,
  onClose,
}: Props) {
  const [revealKey, setRevealKey] = useState(false)
  const stillMounted = useStillMounted()

  async function fetchModels() {
    setStatus({ kind: 'busy', text: 'Asking the endpoint what it has…' })
    try {
      const found = await host.llmModels(normaliseBaseUrl(config.baseUrl), config.apiKey.trim())
      if (!stillMounted.current) return
      setModelList(found)
      setStatus(
        found.length === 0
          ? { kind: 'error', text: 'The endpoint answered, but listed no models.' }
          : { kind: 'ok', text: `${found.length} model${found.length === 1 ? '' : 's'} available.` },
      )
    } catch (error: unknown) {
      if (!stillMounted.current) return
      // The host's message verbatim: "could not reach host" and "API key required"
      // are the two things that actually go wrong, and the user can only fix the
      // one they are told about.
      setStatus({ kind: 'error', text: message(error) })
    }
  }

  async function saveModel() {
    const saved = { ...config, baseUrl: normaliseBaseUrl(config.baseUrl), apiKey: config.apiKey.trim() }
    setStatus({ kind: 'busy', text: 'Saving…' })
    try {
      await host.llmConfigSave(saved)
      if (!stillMounted.current) return
      setSaved(saved)
      setStatus({ kind: 'ok', text: 'Saved.' })
    } catch (error: unknown) {
      if (!stillMounted.current) return
      setStatus({ kind: 'error', text: message(error) })
    }
  }

  /**
   * Asks the model one trivial question and shows the answer.
   *
   * For "is my LLM working", which nothing else in the app answers. Fetching the
   * model list proves the address and the key; a completion is a different
   * request, and a proxy that lists models and then refuses to answer them passes
   * one of those checks and fails the other. With the ask panel gone there was no
   * way left to see a model say anything without switching a live feature on and
   * reading the log for it.
   *
   * Reads the *saved* settings rather than the fields, because that is what the
   * features use. Testing what is in the form would answer a different question
   * from the one being asked, and would say yes while moderation quietly failed
   * against an unsaved key.
   *
   * Says what is missing instead of failing obscurely: the three ways this cannot
   * work are an unset endpoint, an unset model, and an endpoint that will not
   * answer, and only the host knows which.
   */
  async function testModel() {
    setStatus({ kind: 'busy', text: 'Asking the model…' })
    // Said before the call rather than after: someone who has just typed a new key
    // and pressed this is testing the *old* one, and a green result while they are
    // looking at the new key is the most misleading thing this dialog can do.
    const unsaved = normaliseBaseUrl(config.baseUrl) !== savedModel.baseUrl
      || config.apiKey.trim() !== savedModel.apiKey
      || config.model !== savedModel.model
    try {
      const answer = await host.llmTest()
      if (!stillMounted.current) return
      const said = answer.trim() === '' ? 'it answered with nothing' : answer.trim()
      setStatus({
        kind: 'ok',
        text: `The saved model answered: ${said}${unsaved ? ' — but you have unsaved changes above.' : ''}`,
      })
    } catch (error: unknown) {
      if (!stillMounted.current) return
      setStatus({
        kind: 'error',
        text: `The model did not answer — ${message(error)}${unsaved ? ' (it tested the saved settings, not these fields)' : ''}`,
      })
    }
  }

  async function forgetModel() {
    setStatus({ kind: 'busy', text: 'Forgetting…' })
    try {
      await host.llmConfigClear()
      if (!stillMounted.current) return
      forget()
      setStatus({ kind: 'ok', text: 'Forgotten. The key is gone from disk.' })
    } catch (error: unknown) {
      if (!stillMounted.current) return
      setStatus({ kind: 'error', text: message(error) })
    }
  }

  const options = modelOptions(models, config.model)

  return (
    <Section title="Model" defaultOpen>
      <p className="modal-hint">
        Any OpenAI-compatible endpoint. The key is stored on this machine, never in the page, and every
        request is made by the app&rsquo;s host rather than this window.
      </p>

      <label className="field">
        <span className="field-label">Base URL</span>
        <input
          className="input"
          placeholder={EXAMPLE_BASE_URL}
          value={config.baseUrl}
          onChange={(e) => setConfigField('baseUrl', e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field-label">API key</span>
        <span className="field-row">
          <input
            className="input"
            type={revealKey ? 'text' : 'password'}
            placeholder="sk-…"
            value={config.apiKey}
            onChange={(e) => setConfigField('apiKey', e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <button className="btn btn-small" onClick={() => setRevealKey((v) => !v)}>
            {revealKey ? 'Hide' : 'Show'}
          </button>
        </span>
      </label>

      <label className="field">
        <span className="field-label">Model</span>
        <span className="field-row">
          <select
            className="input"
            value={config.model}
            onChange={(e) => setConfigField('model', e.target.value)}
            disabled={options.length === 0}
          >
            {options.length === 0 && <option value="">Fetch the list first</option>}
            {options.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <button className="btn btn-small" onClick={fetchModels} disabled={!ready || status.kind === 'busy'}>
            Fetch models
          </button>
        </span>
      </label>

      {status.text !== '' && (
        <p className={`modal-status modal-status-${status.kind}`}>{status.text}</p>
      )}

      <div className="modal-actions">
        <button className="btn btn-small" onClick={forgetModel} disabled={status.kind === 'busy'}>
          Forget
        </button>
        <button
          className="btn btn-small"
          onClick={testModel}
          disabled={status.kind === 'busy'}
          title="Ask the model one question and show what it answers"
        >
          {status.kind === 'busy' ? 'Working…' : 'Test model'}
        </button>
        <span className="modal-spacer" />
        <button className="btn btn-small" onClick={onClose}>
          Close
        </button>
        <button className="btn btn-primary btn-small" onClick={saveModel} disabled={status.kind === 'busy'}>
          Save model
        </button>
      </div>
    </Section>
  )
}