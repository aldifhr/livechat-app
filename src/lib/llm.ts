/**
 * What an OpenAI-compatible endpoint is, and how a typed one is read.
 *
 * Pure, so the fiddly parts — a URL pasted without a scheme, a saved model the
 * endpoint has stopped offering — are checked without a network or a window. Both
 * of those look trivial and neither is: the first fails as a connection error
 * rather than a typo, and the second silently drops the user's selection.
 */

/** The three fields the host stores. Mirrors `LlmConfig` in src-tauri/src/llm.rs. */
export interface LlmConfig {
  /** Host and path, including the version segment: `https://host/v1`. */
  baseUrl: string
  apiKey: string
  model: string
}

export const EMPTY_CONFIG: LlmConfig = { baseUrl: '', apiKey: '', model: '' }

/** Shown when nothing is configured yet. Not applied to anything. */
export const EXAMPLE_BASE_URL = 'https://your-endpoint.example/v1'

/**
 * A base URL as typed, made into one that can be requested.
 *
 * The scheme is added when it is missing because the common case is a bare
 * `host:port/v1` copied off a terminal, and an endpoint reached that way fails
 * as "could not connect" rather than as the typo it actually is. Trailing
 * slashes come off because the host joins the path itself and a doubled slash
 * is a 404 on some proxies and a redirect on others.
 */
export function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

/** Whether there is enough filled in to be worth spending a request on. */
export function isReady(config: LlmConfig): boolean {
  return normaliseBaseUrl(config.baseUrl) !== '' && config.apiKey.trim() !== ''
}

/**
 * The models to offer, with the saved one always among them.
 *
 * A provider can retire a model between one launch and the next. Dropping it
 * from the list would leave the user's saved selection showing as unset with no
 * explanation, so it is offered anyway — it is still what the app will use.
 */
export function modelOptions(models: string[], current: string): string[] {
  const chosen = current.trim()
  const unique = [...new Set(models.map((m) => m.trim()).filter(Boolean))].sort()
  if (chosen === '' || unique.includes(chosen)) return unique
  return [chosen, ...unique]
}