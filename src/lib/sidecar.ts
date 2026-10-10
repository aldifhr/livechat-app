/**
 * Talks to the Rust host.
 *
 * Every frame the backend produces arrives on one channel; commands are sent back
 * the other way. Nothing in here reaches the network itself: the webview's content
 * security policy forbids it, and the few things that genuinely need the network —
 * the model list, opening a browser, a desktop toast — are the host's business.
 */

import type { LlmConfig } from './llm'
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
    | { type: 'status'; connected: boolean; connecting?: boolean; message: string }
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
  | 'window_label'
  | 'set_overlay_visible'
  | 'set_overlay_click_through'
  | 'notify'
  | 'open_stream'
  | 'llm_models'
  | 'llm_config_get'
  | 'llm_config_save'
  | 'llm_config_clear'
  | 'backend_config_get'
  | 'backend_config_save'
  | 'backend_connect'
  | 'backend_disconnect'

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
      await invoke(command, args)
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
  return active
}

let resolvedUnlisten: (() => void) | null = null

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
    resolvedUnlisten = await resolved.listen((event) => {
      for (const handler of listeners) handler(event)
    })
  })()

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

export function detach(): void {
  resolvedUnlisten?.()
  resolvedUnlisten = null
  attaching = null
  listeners.clear()
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
  /**
   * Which window this frontend is running in.
   *
   * The two windows load the same bundle and render different things, and the
   * bundle has to know which it is before it renders. Asked of the host rather
   * than read off `getCurrentWindow()` so the webview needs no window permission
   * just to find out its own name.
   */
  windowLabel: async (): Promise<string> => {
    const resolved = await resolve()
    const label = await resolved.invoke('window_label')
    return typeof label === 'string' ? label : 'main'
  },
  setOverlayVisible: async (visible: boolean) => {
    const resolved = await resolve()
    await resolved.invoke('set_overlay_visible', { visible })
  },
  /** Turns the overlay into a hole in the desktop: clicks fall through to it. */
  setOverlayClickThrough: async (on: boolean) => {
    const resolved = await resolve()
    await resolved.invoke('set_overlay_click_through', { on })
  },
  /** A desktop toast, raised by the host rather than by the webview. */
  notify: async (title: string, body: string) => {
    const resolved = await resolve()
    await resolved.invoke('notify', { title, body })
  },
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
}