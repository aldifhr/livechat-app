/**
 * Talks to the Rust host.
 *
 * Every frame the backend produces arrives on one channel; commands are sent back
 * the other way. Nothing in here reaches the network itself: the webview's content
 * security policy forbids it, and the few things that genuinely need the network —
 * the model list, opening a browser, a desktop toast — are the host's business.
 *
 * `SidecarEvent` below is the far side of a seam with nothing spanning it. The
 * producing half is the hand-written `json!` in `to_app_event`
 * (`src-tauri/src/backend.rs`), which emits plain JSON; the consuming half is this
 * union, which claims the shape by casting. No schema, no codegen, no shared type —
 * so the two can disagree about a field name and nothing will object, because each
 * one is only ever checked against itself.
 *
 * That is not hypothetical: `join` declared `viewerId` here while the host sent
 * `id`, so every join arrived with no identity and two viewers arriving inside the
 * collapse window folded into one row. Both sides were tested and both were green.
 *
 * `test/test-wire.mjs` reads this file and `backend.rs` and compares them, so a
 * field added to one without the other fails the suite. Run `npm run test:wire`
 * after touching either side. Adding a genuinely optional field is fine — mark it
 * `?` and the check will not demand the host always send it.
 */

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

/**
 * The reader session a frame belongs to.
 *
 * Stamped by the host on everything the reader loop produces — room frames,
 * status, errors, chat — and absent on frames the host raises about the reader
 * itself, which is what the Stop confirmation is.
 *
 * It exists because a frame can be in flight when Stop is pressed: the host hands
 * it to the webview and returns, so a frame emitted a moment before the Stop is
 * still delivered after it. Without this the app cannot tell that frame from one
 * belonging to the session it is now reading, and the feed grows under a "Not
 * connected" badge. Optional in the type because the frames that have to survive
 * a Stop are exactly the ones without it.
 */
type Sessioned = { session?: number }

/**
 * The host's snapshot of the session it is reading, for a page that just loaded.
 *
 * Not a transition — nothing happened — but the same `status` shape plus the room
 * details a fresh page cannot know. Marked with `snapshot: true` so the app can
 * tell it from a real status frame and apply it whole instead of logging it as an
 * event that never occurred.
 */
type Snapshotted = {
  snapshot?: boolean
  username?: string
  roomId?: string
  title?: string
  viewers?: number | null
}

export type SidecarEvent = Tagged &
  Sessioned &
  Snapshotted &
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
     * A viewer arriving in the room.
     *
     * Carries `id` like every other person-bearing frame. It once declared
     * `viewerId` instead, which nothing on the producing side ever sent — so every
     * join arrived with an undefined id, and two different viewers arriving inside
     * the collapse window folded into one row.
     */
    | {
        type: 'join'
        nickname: string
        id: string
        avatar: string
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
  | 'backend_config_get'
  | 'backend_config_save'
  | 'backend_connect'
  | 'backend_disconnect'
  | 'backend_status'

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

/*
 * The session guard.
 *
 * Every frame the host's reader produces carries the session that produced it.
 * This is where frames enter the app, so this is where a frame from a session
 * that has been stopped is dropped — before the feed, the counters, the status
 * line or any of the alert hooks see it.
 *
 * It has to be here rather than in `useChat` because the feed is not the only
 * consumer: a gift sound, a spoken mention and an auto-reply all read the same
 * frames, and a stopped session must not ring a bell or answer a greeting
 * either. One gate at the door covers all of them.
 *
 * Why a stamp is needed at all: the host hands a frame to the webview and
 * returns, so a frame emitted a moment before Stop is still delivered after it.
 * The host cannot close that window by itself. Stamping lets this side tell
 * which session a frame came from, and the reader is genuinely stopped on the
 * other end — this drops the stragglers, it does not hide a running source.
 */

/** The session being read, or null when nothing is. */
let liveSession: number | null = null

/** The highest session that has been closed. */
let closedSession = 0

/**
 * Closes the session being read, so frames already in flight from it are
 * dropped.
 *
 * Called when Stop is pressed, and again when the host confirms it. Closing it
 * at the click is what makes the feed agree with the toolbar immediately: the
 * button flips to Connect on the press, and without this a frame delivered in
 * the moment between the press and the confirmation would still land under a
 * badge that already says the reading stopped.
 */
export function endSession(): void {
  if (liveSession !== null) closedSession = Math.max(closedSession, liveSession)
  liveSession = null
}

/**
 * Whether a frame belongs to a session worth reading.
 *
 * A frame with no stamp is the host's own — the Stop confirmation, a tray
 * message — and is never gated: those are exactly the frames that have to get
 * through after the session they close has been dropped.
 *
 * A newer session is adopted rather than refused, which is what lets Connect
 * work after a Stop without anything having to re-open the gate: the host
 * numbers sessions in increasing order, so the next one is always above the
 * closed floor.
 */
function accepts(event: SidecarEvent): boolean {
  const session = event.session
  if (typeof session !== 'number') return true
  if (session <= closedSession) return false
  if (liveSession !== null && session < liveSession) return false
  liveSession = session
  return true
}

/** The host saying the reading stopped. */
function isStopConfirmation(event: SidecarEvent): boolean {
  return event.platform === 'bridge' && event.type === 'status' && event.connected === false
}

/**
 * Delivers the host's snapshot of the current session, as if it had just arrived.
 *
 * A reload of the webview throws the frontend away while the Rust process keeps
 * reading, so the new page starts from an idle room and would show "Not connected"
 * and a Connect button over a feed that is still filling. This is how it catches
 * up: `useChat` asks for the snapshot once, and hands it here.
 *
 * Routed through the same guard and the same listener set as a real frame rather
 * than written straight into state, for two reasons. The guard has to learn the
 * session the reader is on, or the first real frame after the reload would look
 * like it came from an unknown session; and the listeners have to see it the same
 * way they see everything else, so there is one path into the app rather than a
 * second one that has to be kept in step by hand.
 */
export function adoptSnapshot(event: SidecarEvent): void {
  // The snapshot describes the session that is running now, so it is adopted
  // rather than gated: `accepts` would refuse it only if its session were already
  // closed, which cannot be true of a snapshot taken after that close.
  liveSession = typeof event.session === 'number' ? event.session : liveSession
  for (const handler of listeners) {
    try {
      handler(event)
    } catch (error: unknown) {
      console.error('a sidecar event handler threw', error)
    }
  }
}

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
      // Dropped here, once, for every consumer. See the session guard above.
      if (!accepts(event)) return
      // The host's own confirmation closes the session too, so the guarantee
      // does not depend on the click having been the thing that asked for the
      // stop — a stop from anywhere lands the same way.
      if (isStopConfirmation(event)) endSession()

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
   * The text is sent to Google to be spoken — that is what a neural voice this good
   * costs, and it is why the setting that enables this is opt-in. The audio comes
   * back as base64 rather than being played in the host, so it goes through the
   * same AudioContext and the same volume control as every other sound.
   *
   * The pace and the language are sent rather than remembered here: which values
   * the voice service actually honours is not a question the page should be
   * answering, so both are named, and the host settles for its own defaults if
   * either is not one it has.
   */
  speak: async (text: string, pace: string, language: string): Promise<string> => {
    const resolved = await resolve()
    const encoded = await resolved.invoke('speak', { text, pace, language })
    return typeof encoded === 'string' && encoded !== '' ? `data:audio/mpeg;base64,${encoded}` : ''
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
   * The connection state right now, for a page that has just started.
   *
   * Returns the host's snapshot as a frame — `null` when the host answers with
   * nothing usable, so a caller can tell "not connected" from "could not ask".
   * The shape is `SidecarEvent`, but it is deliberately not cast to the union
   * here: it carries fields no ordinary frame does (`username`, `roomId`,
   * `viewers`, `snapshot`), and asserting it into a variant that does not declare
   * them is how this seam goes wrong quietly. `useChat` reads what it needs.
   */
  backendStatus: async (): Promise<Record<string, unknown> | null> => {
    const resolved = await resolve()
    const snapshot = await resolved.invoke('backend_status')
    return snapshot && typeof snapshot === 'object' ? (snapshot as Record<string, unknown>) : null
  },
}
