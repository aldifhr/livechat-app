/**
 * Talks to the Rust host.
 *
 * Every frame the backend produces arrives on one channel; commands are sent back
 * the other way. Nothing in here reaches the network itself: the webview's content
 * security policy forbids it, and the few things that genuinely need the network —
 * the model list, opening a browser, a desktop toast — are the host's business.
 */

import type { LlmConfig } from './llm'
import type { WebhookConfig, WebhookGift } from './webhook'
import type { ModerationVerdict } from './ai'
import type { OverlayStyle } from './overlay'
import type { BackendConfig } from './backend'

type EventHandler = (event: SidecarEvent) => void

/**
 * Which room a frame came from.
 *
 * `bridge` is for messages about the bridge itself rather than a room. Present on
 * every frame because the two platforms run at once and the UI has to be able to
 * say which room a row or a failure belongs to.
 */
export type Platform = 'tiktok'
export type FramePlatform = Platform | 'bridge'

type Tagged = { platform: FramePlatform }

export type SidecarEvent = Tagged &
  (
    | {
        type: 'chat'
        nickname: string
        id: string
        avatar: string
        text: string
        timestamp: number
        /** Written by the app, not a viewer — an auto-reply. Injected locally. */
        isBot?: boolean
        /** TikTok marked this viewer as a room moderator. */
        isModerator?: boolean
        /** TikTok has filtered this message itself. */
        isFiltered?: boolean
        /** Usernames the message is directed at. */
        mentions?: string[]
        /** Emoji images sent alongside the text. */
        emotes?: { url: string; id: string }[]
      }
    | {
        type: 'gift'
        nickname: string
        id: string
        avatar: string
        giftName: string
        count: number
        diamonds: number
        timestamp: number
        /** Picture of the gift. Omitted entirely when the platform sent none. */
        giftImage?: string
      }
    | { type: 'like'; nickname: string; id: string; avatar: string; count: number; timestamp: number }
    | { type: 'follow'; nickname: string; id: string; avatar: string; timestamp: number }
    | { type: 'share'; nickname: string; id: string; avatar: string; timestamp: number }
    /**
     * A viewer seen for the first time this session.
     *
     * TikTok sends no join event — only `memberCount`, a headcount that drifts and
     * names nobody — so this is built from a first chat message instead.
     */
    | {
        type: 'join'
        nickname: string
        avatar: string
        viewerId: string
        timestamp: number
      }
    | { type: 'viewers'; count: number }
    | {
        type: 'status'
        connected: boolean
        connecting?: boolean
        /**
         * The streamer stopped, rather than the connection dropping.
         *
         * Both stop events arriving, and the feed alone cannot tell them apart.
         * This is what lets the app say "live ended" instead of reconnecting to a
         * handle that has gone quiet, which reads as a hung app.
         */
        liveEnded?: boolean
        message: string
      }
    | { type: 'room'; username: string; roomId: string; title: string }
    | { type: 'error'; message: string }
    /** A diagnostic line from the bridge, surfaced in the app's log panel. */
    | { type: 'log'; level: LogLevel; message: string }
    | { type: 'ready' }
  )

export type LogLevel = 'info' | 'warn' | 'error'

/** Every `#[tauri::command]` the host exposes. Must match src-tauri/src/main.rs. */
type HostCommand =
  | 'minimize_to_tray'
  | 'set_always_on_top'
  | 'notify'
  | 'open_stream'
  | 'speak'
  | 'pick_sound_file'
  | 'webhook_config_get'
  | 'webhook_config_save'
  | 'webhook_test'
  | 'webhook_send'
  | 'llm_models'
  | 'llm_moderate'
  | 'llm_autoreply'
  | 'llm_test'
  | 'llm_config_get'
  | 'llm_config_save'
  | 'llm_config_clear'
  | 'backend_config_get'
  | 'backend_config_save'
  | 'backend_connect'
  | 'backend_disconnect'
  | 'overlay_url'
  | 'overlay_open'
  | 'overlay_running'

/**
 * How the UI reaches the host.
 *
 * Injected rather than imported directly so the UI can be driven without a
 * window: the tests supply a transport that records commands and pushes events
 * by hand, which is what lets them run headless instead of needing the app
 * launched with a debug port.
 */
export interface Transport {
  /** Subscribe to host events. Returns an unsubscribe function. */
  listen(handler: (event: SidecarEvent) => void): Promise<() => void>
  invoke(command: HostCommand, args?: Record<string, unknown>): Promise<unknown>
}

/**
 * A file path turned into something a webview can load.
 *
 * A webview cannot `fetch` an absolute filesystem path — the request never
 * leaves the page. `convertFileSrc` rewrites it onto the asset protocol, which
 * the host serves after the pick registered the file in its scope. Used for a
 * custom sound file, which lives on disk rather than in the bundle.
 */
export async function fileUrl(path: string): Promise<string> {
  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core')
    return convertFileSrc(path)
  } catch {
    // A headless run, or a host without the API: the path itself is the best
    // answer there is, and the player's own guard turns a failed load into
    // silence rather than an error.
    return path
  }
}

/** Set by tests before anything calls `attach`. */
let transport: Transport | null = null

export function setTransport(next: Transport | null): void {
  transport = next
}

/** The real one, loaded on demand so a headless run never touches Tauri. */
async function tauriTransport(): Promise<Transport> {
  const [{ listen }, { invoke }] = await Promise.all([
    import('@tauri-apps/api/event'),
    import('@tauri-apps/api/core'),
  ])
  return {
    listen: async (handler) => {
      const unlisten = await listen<SidecarEvent>('sidecar-event', (event) => handler(event.payload))
      return unlisten
    },
    invoke: async (command, args) => {
      // Returned, not merely awaited: without this the promise settles with
      // `undefined` and every command that returns something — the saved config,
      // the model list — reads as empty rather than as a failure.
      return invoke(command, args)
    },
  }
}

const listeners = new Set<EventHandler>()

/** Resolved once, so a later `setTransport` cannot swap it out mid-session. */
let active: Promise<Transport> | null = null

function resolve(): Promise<Transport> {
  // An injected transport wins even after `active` was populated, so a headless
  // run can set it before the first call rather than having to unset Tauri.
  if (transport) return Promise.resolve(transport)
  active ??= tauriTransport()
  // Cleared on failure for the same reason `attaching` is: a rejected transport
  // kept in `active` is the identical latch, one layer down.
  active.catch(() => {
    active = null
  })
  return active
}

/**
 * Shared across every `attach`, so it cannot be null while a registration is
 * already in flight.
 */
let attaching: Promise<void> | null = null

export async function attach(onEvent?: EventHandler): Promise<void> {
  if (onEvent) listeners.add(onEvent)
  if (attaching) return attaching

  // The promise itself is the guard, not its result. Two windows — or two
  // components on one mount — both reach the first `await` before either has
  // registered a listener, and a plain null check lets both through: the
  // transport then has two subscribers and delivers every frame twice.
  attaching = (async () => {
    const resolved = await resolve()
    await resolved.listen((event) => {
      // One throwing handler must not take the rest of them down with it. The
      // loop used to be bare, so an exception in an early subscriber aborted it
      // and every handler after it silently stopped seeing frames — which looks
      // exactly like the feed having stopped working.
      for (const handler of listeners) {
        try {
          handler(event)
        } catch (error: unknown) {
          console.error('a sidecar event handler threw', error)
        }
      }
    })
  })()

  // Cleared on failure, so a rejected attach does not latch: the promise stayed
  // assigned, every later `attach` returned the same rejection, and no listener
  // was ever registered — an empty app with no error anywhere. All five call
  // sites ignore this promise, so nothing else would have cleared it.
  attaching.catch(() => {
    attaching = null
  })

  return attaching
}

/**
 * Removes one subscriber.
 *
 * `attach` adds to a module-level set that outlives the component that added to
 * it, so a component that re-subscribes — on a setting change, say — leaks its
 * old handler every time it does.
 */
export function detachHandler(handler: EventHandler): void {
  listeners.delete(handler)
}

/**
 * Deliver an event to the current listeners as if it arrived from the host.
 *
 * Used by the auto-reply, which answers a greeting by writing a chat row that the
 * feed then shows like any other. Routing it through the same listener set the real
 * frames use means the reply is one code path with a real message — same shape,
 * same renderer, same counters bypass — instead of a second door into the feed
 * that has to be kept in step by hand.
 *
 * Synchronous on purpose: a reply to a greeting should land in the same frame the
 * viewer's message did, not a tick later, or it reads as a separate event rather
 * than an answer.
 */
export function emitLocal(event: SidecarEvent): void {
  for (const handler of listeners) {
    try {
      handler(event)
    } catch (error: unknown) {
      console.error('a sidecar event handler threw', error)
    }
  }
}

export const host = {
  /** Hides the window; the stream keeps being read and the tray brings it back. */
  minimizeToTray: async () => {
    const resolved = await resolve()
    await resolved.invoke('minimize_to_tray')
  },
  setAlwaysOnTop: async (onTop: boolean) => {
    const resolved = await resolve()
    await resolved.invoke('set_always_on_top', { onTop })
  },
  /** A desktop toast, raised by the host rather than by the webview. */
  notify: async (title: string, body: string) => {
    const resolved = await resolve()
    await resolved.invoke('notify', { title, body })
  },
  /**
  /**
   * Opens the stream in the default browser.
   *
   * There is no video player in this app and there is not going to be one: TikTok
   * serves its live video over a signed URL the bridge cannot get without a key
   * nobody here has. The host validates the URL against the one host it is willing
   * to open before it does anything with it.
   */
  openStream: async (url: string) => {
    const resolved = await resolve()
    await resolved.invoke('open_stream', { url })
  },
  /**
   * Reads a line of chat aloud with the neural voice, and returns the audio as a
   * data URL ready to play.
   *
   * The text is sent to Microsoft to be spoken — that is what a neural voice this
   * good costs, and it is why the setting that enables this is opt-in. The audio
   * comes back as base64 rather than being played in the host, so it goes through
   * the same AudioContext and the same volume as every other sound.
   */
  speak: async (text: string): Promise<string> => {
    const resolved = await resolve()
    const encoded = await resolved.invoke('speak', { text })
    return typeof encoded === 'string' && encoded !== '' ? `data:audio/mpeg;base64,${encoded}` : ''
  },
  /**
   * The stored webhook settings.
   *
   * Read from disk rather than sent in, so the token travels from the config file
   * to the socket and never through the page that asked for the send.
   */
  webhookConfigGet: async (): Promise<WebhookConfig> => {
    const resolved = await resolve()
    const config = (await resolved.invoke('webhook_config_get')) as Partial<WebhookConfig> | null | undefined
    return {
      enabled: config?.enabled === true,
      url: typeof config?.url === 'string' ? config.url : '',
      token: typeof config?.token === 'string' ? config.token : '',
    }
  },
  webhookConfigSave: async (config: WebhookConfig): Promise<void> => {
    const resolved = await resolve()
    await resolved.invoke('webhook_config_save', { config })
  },
  /**
   * Sends one test gift and reports what came back.
   *
   * The only webhook call whose result the user sees — "saved" is not evidence a URL
   * was right, and there is no other way to find out from a settings box.
   */
  webhookTest: async (): Promise<string> => {
    const resolved = await resolve()
    const said = await resolved.invoke('webhook_test')
    return typeof said === 'string' ? said : 'Sent.'
  },
  /**
   * Sends one gift to the configured webhook.
   *
   * The gift is the argument; the URL and the token are not. They are read from disk
   * in the host, so a credential handed to the page in order to be used is a
   * credential the page can leak.
   */
  webhookSend: async (gift: WebhookGift): Promise<void> => {
    const resolved = await resolve()
    await resolved.invoke('webhook_send', { gift })
  },
  /**
   * Opens a file picker and returns the chosen sound file's path.
   *
   * Empty string on cancel. The picker lives in the host because a webview cannot
   * open a native dialog on its own, and the path — not the bytes — comes back so
   * the file is read only when it actually plays.
   */
  pickSoundFile: async (): Promise<string> => {
    const resolved = await resolve()
    const path = await resolved.invoke('pick_sound_file')
    return typeof path === 'string' ? path : ''
  },
  /**
   * The models an OpenAI-compatible endpoint offers.
   *
   * Outbound requests are the host's job: the webview's content security policy
   * forbids it from reaching any other origin, which is exactly right for a key
   * that must not end up in the page.
   */
  llmModels: async (baseUrl: string, apiKey: string): Promise<string[]> => {
    const resolved = await resolve()
    const models = await resolved.invoke('llm_models', { baseUrl, apiKey })
    return Array.isArray(models) ? models.filter((m): m is string => typeof m === 'string') : []
  },
  /**
   * Asks the model what it makes of a batch of messages.
   *
   * The endpoint, the key and the model are not arguments: the host reads them
   * from its own config, so a credential is never handed back to the page in
   * order to be used. What the page does send is the batch it chose, already
   * numbered — deciding which messages are worth judging is a reading decision,
   * and it belongs where the feed is.
   *
   * `count` is sent alongside the lines rather than left for the host to count.
   * The host caps it at what it was actually given, which is what makes an index
   * outside the batch impossible to act on: the worst a confused model can do is
   * name a row that was in front of it.
   */
  llmModerate: async (messages: string[], rules: string): Promise<ModerationVerdict[]> => {
    const resolved = await resolve()
    const verdicts = await resolved.invoke('llm_moderate', { messages, rules, count: messages.length })
    // Narrowed field by field rather than trusted: `invoke` is typed `unknown`
    // because it is the transport, not this contract, and a host that answered
    // with something else entirely must not have the feed index into it.
    if (!Array.isArray(verdicts)) return []
    return verdicts.flatMap((verdict) => {
      const entry = verdict as Partial<ModerationVerdict> | null
      if (typeof entry?.index !== 'number' || !Number.isInteger(entry.index) || entry.index < 0) return []
      return [
        {
          index: entry.index,
          label: typeof entry.label === 'string' ? entry.label : 'flagged',
          reason: typeof entry.reason === 'string' ? entry.reason : '',
        },
      ]
    })
  },
  /**
   * Asks the model whether it has anything to say about the room.
   *
   * `null` is an answer, not a failure: the model is asked for it by name, and
   * `null` is what comes back most of the time. A host that rejected the request
   * throws instead, which is how the two stay apart.
   */
  llmAutoReply: async (context: string[], topic: string, persona: string): Promise<string | null> => {
    const resolved = await resolve()
    const reply = await resolved.invoke('llm_autoreply', { context, topic, persona })
    // Anything that is not a non-empty string is silence. The host only ever
    // answers with one of the two, but the two must not collapse into each other
    // here: posting an empty row is worse than posting nothing.
    return typeof reply === 'string' && reply.trim() !== '' ? reply.trim() : null
  },
  /**
   * Asks the model one trivial question and returns what it said.
   *
   * The check for whether the LLM works, which nothing else in the app answers.
   * Fetching the model list proves the address and the key; a completion is a
   * different request, and a proxy that lists models and then refuses to answer
   * them passes one check and fails the other.
   *
   * The endpoint, the key and the model are read host-side for the same reason as
   * everywhere else: a credential should not be handed back to the page in order
   * to be used.
   */
  llmTest: async (): Promise<string> => {
    const resolved = await resolve()
    const answer = await resolved.invoke('llm_test')
    return typeof answer === 'string' ? answer : ''
  },
  llmConfigGet: async (): Promise<LlmConfig> => {
    const resolved = await resolve()
    // `invoke` is typed `unknown` because it is the transport, not this contract;
    // every field is narrowed before use so a host that answered with something
    // else entirely yields an empty config rather than a crash.
    const config = (await resolved.invoke('llm_config_get')) as Partial<LlmConfig> | null | undefined
    return {
      baseUrl: typeof config?.baseUrl === 'string' ? config.baseUrl : '',
      apiKey: typeof config?.apiKey === 'string' ? config.apiKey : '',
      model: typeof config?.model === 'string' ? config.model : '',
    }
  },
  llmConfigSave: async (config: LlmConfig): Promise<void> => {
    const resolved = await resolve()
    await resolved.invoke('llm_config_save', { config })
  },
  llmConfigClear: async (): Promise<void> => {
    const resolved = await resolve()
    await resolved.invoke('llm_config_clear')
  },
  /**
   * The stored backend settings.
   *
   * Read on demand rather than at mount: this is a file on disk, and there is no
   * reason to pay for that on every launch of an app whose default source is
   * still the local bridge.
   */
  backendConfigGet: async (): Promise<BackendConfig> => {
    const resolved = await resolve()
    const config = (await resolved.invoke('backend_config_get')) as Partial<BackendConfig> | null | undefined
    return {
      baseUrl: typeof config?.baseUrl === 'string' ? config.baseUrl : '',
      username: typeof config?.username === 'string' ? config.username : '',
    }
  },
  backendConfigSave: async (config: BackendConfig): Promise<void> => {
    const resolved = await resolve()
    await resolved.invoke('backend_config_save', { config })
  },
  /**
   * Reads from the backend instead of the local bridge.
   *
   * Returns as soon as the socket pump is spawned. Connecting, retrying and
   * eventually giving up all happen in the host, and none of them should hold up
   * the click; what it has to say comes back as frames on the same channel the
   * bridge uses, which is the whole reason nothing downstream has to change.
   */
  backendConnect: async (config: BackendConfig): Promise<void> => {
    const resolved = await resolve()
    await resolved.invoke('backend_connect', { config })
  },
  /** Stops reading from the backend. */
  backendDisconnect: async (): Promise<void> => {
    const resolved = await resolve()
    await resolved.invoke('backend_disconnect')
  },
  /**
   * The link to paste into OBS, with the styling carried in it.
   *
   * Built host-side because two of its parts are not the page's: the backend
   * address is a file on disk and the handle is whatever was typed into the
   * toolbar. Both of those would otherwise have to be kept in step with a second
   * copy in the frontend, and a link pointing at a different backend than the app
   * is reading is a link that shows an empty chat for reasons nobody can see.
   */
  overlayUrl: async (
    username: string,
    style: OverlayStyle,
    roomId?: string,
  ): Promise<string> => {
    const resolved = await resolve()
    // `roomId` makes the link a bare `?room=<id>`: the host emits just that when a
    // room id is in hand, because naming the room by id is one nothing has to
    // resolve and nothing can drift away from.
    const url = await resolved.invoke('overlay_url', { username, style, roomId: roomId ?? null })
    return typeof url === 'string' ? url : ''
  },
  /**
   * Opens the overlay page in the user's browser.
   *
   * Through the host rather than `window.open`, which does nothing here: the
   * webview is under a content security policy that does not let the page
   * navigate anywhere, and a page asking for a new window is not something the
   * platform grants it. The host checks the address is its own overlay before
   * handing it to the OS — the same reason `openStream` checks before opening
   * anything, though here the rule is the loopback port rather than a host list.
   */
  overlayOpen: async (url: string): Promise<void> => {
    const resolved = await resolve()
    await resolved.invoke('overlay_open', { url })
  },
  /**
   * Whether the overlay server is answering.
   *
   * `false` means either that it is not running or that something else has the
   * port — both of which a streamer needs to know before a stream rather than
   * during one, which is why this is asked rather than assumed.
   */
  overlayRunning: async (): Promise<boolean> => {
    const resolved = await resolve()
    return await resolved.invoke('overlay_running') === true
  },
}