/**
 * Live chat bridge for TikTok.
 *
 * Speaks newline-delimited JSON on stdin/stdout so the Tauri Rust side never has
 * to know anything about the protocol. Protocol:
 *
 *   host -> sidecar   {"cmd":"connect","platform":"tiktok","target":"foo"}
 *                     {"cmd":"disconnect","platform":"tiktok"}   // omit for all
 *   sidecar -> host   {"type":"status"|"chat"|"gift"|"like"|"follow"|"share"|"viewers"|"error"|"log"|"ready", ...}
 *
 * `target` is a TikTok username. Every frame carries the `platform` it came from
 * so the UI can label rows without knowing anything about the protocol — a field
 * that is constant today and would not be for a second platform added tomorrow.
 *
 * `stdout` carries protocol only; diagnostics go to stderr, because a stray log
 * line on stdout would be read as a malformed frame.
 */

import { createInterface } from 'node:readline'
import { TikTokLiveConnection } from 'tiktok-live-connector'

/**
 * TikTok substitutes these when a viewer's profile is unavailable or deleted.
 * Passing them through puts a literal "Not found" on screen, so they are dropped
 * the same way stream-kit's backend drops them.
 */
const PLACEHOLDER_NICKNAMES = new Set(['', '?', 'not found', 'unknown', '-', 'null', 'none'])

/** Fields copied verbatim from every per-viewer payload. */
function viewer(user) {
  if (!user) return null
  const nickname = (user.nickname ?? '').trim()
  if (PLACEHOLDER_NICKNAMES.has(nickname.toLowerCase())) return null
  return {
    nickname,
    // TikTok's stable numeric handle. A nickname can change and two people can
    // share one, so anything keying per-viewer state needs this instead.
    id: String(user.id ?? ''),
    avatar: user.avatarThumb?.urlList?.[0] ?? '',
  }
}

/** Strip the leading @ and any profile URL down to a bare handle. */
function normaliseUsername(raw) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return ''
  const fromUrl = trimmed.match(/tiktok\.com\/@([^/?#]+)/i)
  const handle = fromUrl ? fromUrl[1] : trimmed.replace(/^@+/, '')
  return handle.split(/[/?#]/)[0].trim()
}

/**
 * The picture of a gift, or '' when there isn't one to be had.
 *
 * Two places to look, because either can be the only one present. The catalogue
 * entry attached by `enableExtendedGiftInfo` is the fuller of the two, but it is
 * only fetched at connect time — a gift added to the catalogue mid-stream, or a
 * room whose catalogue request failed, arrives with nothing attached. The raw
 * message carries its own image in that case.
 *
 * `http:` is rewritten to `https:` because TikTok's CDN lists plain-http URLs
 * alongside the secure ones, and the app's content security policy allows
 * `https:` only — an image that loads in every other client silently will not
 * load in this one.
 */
function giftImage(gift, extended) {
  const candidates = [
    extended?.image?.urlList,
    extended?.giftImage?.urlList,
    gift?.image?.urlList,
    gift?.icon?.urlList,
  ]

  for (const list of candidates) {
    if (!Array.isArray(list)) continue
    for (const url of list) {
      if (typeof url !== 'string' || !url.startsWith('http')) continue
      return url.replace(/^http:/i, 'https:')
    }
  }
  return ''
}

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

/**
 * Stamps a frame with the platform it came from.
 *
 * Without this the UI cannot tell whose room a message belongs to, which is the
 * whole point of running two at once.
 */
function emit(platform, payload) {
  send({ platform, ...payload })
}

function fail(platform, message) {
  emit(platform, { type: 'error', message })
}

/**
 * Diagnostics go to stderr, never stdout.
 *
 * The host reads every stdout line as a frame, so a log line there is a malformed
 * frame. These are also what the app's log panel shows when the bridge has
 * something to say that is not worth interrupting the chat feed for.
 */
function log(level, message) {
  process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`)
}

/** Every open session, keyed by platform. At most one per platform. */
const sessions = new Map()

/**
 * How many viewers to remember for first-sighting detection.
 *
 * A session in a big room sees tens of thousands of distinct ids; remembering all
 * of them would grow for hours for no benefit, since only arrivals early in a
 * session are interesting.
 */
const MAX_TRACKED_VIEWERS = 20000

/**
 * The usernames a message directs at someone.
 *
 * The field is only known to exist, not what it holds, so this accepts either a
 * list of names or an object keyed by name and yields whatever looks like a
 * handle. Anything else yields nothing rather than guessing.
 */
function mentionTargets(atUser) {
  if (!atUser) return []
  if (Array.isArray(atUser)) {
    return atUser.map((entry) => entry?.uniqueId ?? entry?.nickname ?? entry).filter((v) => typeof v === 'string' && v)
  }
  if (typeof atUser === 'object') return Object.keys(atUser)
  return []
}

/**
 * Emoji images that came with a message.
 *
 * Written defensively because the field's contents have not been seen on a live
 * room yet: only the key is confirmed. Whatever shape turns up is reported once to
 * stderr so it can be pinned down rather than assumed, and an unrecognised shape
 * simply carries nothing — a missing emote image is far better than a broken row.
 */
function emotePayload(emotes, shapesSeen) {
  if (!Array.isArray(emotes) || emotes.length === 0) return {}
  const images = []
  for (const emote of emotes) {
    const url =
      emote?.imageUrl ?? emote?.image_name ?? emote?.url ?? emote?.emoteImageUrl ?? undefined
    if (typeof url === 'string' && url) images.push({ url, id: String(emote?.id ?? '') })
  }
  const shape = emotes.length ? Object.keys(emotes[0] ?? {}).sort().join(',') : 'empty'
  if (!shapesSeen.has(shape)) {
    shapesSeen.add(shape)
    log('info', `first time seeing an emote shaped like: ${shape}`)
  }
  return images.length ? { emotes: images } : {}
}

/** Cancels one platform's session, or all of them when `platform` is omitted. */
function disconnect(platform) {
  const targets = platform ? [platform] : [...sessions.keys()]
  for (const id of targets) {
    const session = sessions.get(id)
    if (!session) continue
    sessions.delete(id)
    session.stop()
    emit(id, { type: 'status', connected: false, message: 'Disconnected' })
    log('info', `${id} session closed`)
  }
  if (targets.length === 0) {
    // Nothing was open, but the UI asked: tell it anyway so a Disconnect press
    // never leaves the button stuck.
    send({ type: 'status', connected: false, message: 'Disconnected' })
  }
}

/** Translate a connector error into something a user can act on. */
function describeError(err) {
  // Matched by class *name* rather than `instanceof`. Bundling can produce a
  // second copy of the library's classes, and an `instanceof` against one copy
  // is silently false for an error thrown by the other — which would drop a user
  // who is simply offline onto a generic failure.
  const isOffline = (e) => e?.name === 'UserOfflineError' || e?.constructor?.name === 'UserOfflineError'
  const isBadHandle = (e) => e?.name === 'InvalidUniqueIdError' || e?.constructor?.name === 'InvalidUniqueIdError'

  // `error` events wrap the real cause in `exception`; a rejected connect()
  // carries it too. The wrapper's own `info` is generic ("Error while
  // connecting"), so it is only read once the causes have been checked.
  const cause = err?.exception ?? err

  if (isOffline(err) || isOffline(cause)) return 'Streamer is not live right now.'
  if (isBadHandle(err) || isBadHandle(cause)) return 'That does not look like a TikTok username.'

  const causeInfo = cause?.info ?? cause?.message
  const text = causeInfo ? String(causeInfo) : ''
  if (/rate limit|429/i.test(text)) {
    return 'Rate limited by TikTok. Wait a minute before reconnecting.'
  }
  if (/Room ID from all sources/i.test(text)) {
    return 'Could not reach the room. The streamer may be offline, or TikTok may be rate limiting this IP.'
  }

  const nested = cause?.cause
  const nestedText = nested ? String(nested?.info ?? nested?.message ?? nested) : ''
  if (nestedText) {
    if (isOffline(nested)) return 'Streamer is not live right now.'
    if (/rate limit|429/i.test(nestedText)) {
      return 'Rate limited by TikTok. Wait a minute before reconnecting.'
    }
    if (/offline|not.*online/i.test(nestedText)) {
      return 'Streamer is not live right now.'
    }
    return nestedText
  }

  if (/^Error while connecting$/i.test(text)) return 'Could not connect to TikTok. Check the username and your connection.'
  return text || 'Unknown error'
}

// Viewers already seen this session, by their stable id.
//
// A nickname is not usable as a key: it can change, and two people can share one.
// Capped so a marathon session cannot grow this without bound.
const seenViewers = new Set()

function firstSighting(who) {
  if (!who?.id || seenViewers.has(who.id)) return false
  if (seenViewers.size >= MAX_TRACKED_VIEWERS) return false
  seenViewers.add(who.id)
  return true
}

/**
 * Reports a viewer the first time they are seen this session.
 *
 * This is the only join signal the app uses. The alternative — the growth of
 * `memberCount` between member frames — was tried and removed: the value drifts
 * up and down constantly, so it produced a "1 joined" row every few seconds, and
 * it can never name anybody. The live count is already on the status bar, so it
 * lost its only advantage as well.
 *
 * Labeled as a first sighting rather than an arrival, because someone whose first
 * message lands after a reconnect would otherwise be counted as new.
 */
function announce(platform, who) {
  if (firstSighting(who)) {
    emit(platform, {
      type: 'join',
      nickname: who.nickname,
      avatar: who.avatar,
      viewerId: who.id,
      timestamp: Date.now(),
    })
  }
}

async function connectTikTok(rawUsername) {
  const platform = 'tiktok'
  const username = normaliseUsername(rawUsername)
  if (!username) {
    fail(platform, 'Enter a TikTok username first.')
    return
  }
  if (sessions.has(platform)) {
    fail(platform, `Already connected to @${sessions.get(platform).label}. Disconnect first.`)
    return
  }

  log('info', `asking TikTok for the room id of @${username}`)
  emit(platform, { type: 'status', connected: false, connecting: true, message: `Connecting to @${username}...` })

  // `enableExtendedGiftInfo` makes the connector fetch the room's gift catalogue
  // during the handshake and attach the matching entry to every gift frame, which
  // is where the gift's image lives. It costs one extra request on the same web
  // client the room info already uses, so it needs no API key.
  const next = new TikTokLiveConnection(username, { enableExtendedGiftInfo: true })
  let reportedFailure = false

  // Registered before connect() so a Disconnect during the handshake has something
  // to tear down — otherwise the connection would survive and keep streaming.
  sessions.set(platform, {
    label: username,
    stop: () => {
      sessions.delete(platform)
      // Forgetting who has been seen means a fresh reconnect re-announces the
      // next people as new, which is honest: as far as this session is concerned
      // they have not been seen before.
      seenViewers.clear()
      next.disconnect().catch(() => {})
    },
  })

  // Deliberately quieter than the status line. The status line already says
  // "Connected to @user", and logging the same fact twice makes the log harder
  // to scan — the log's job is the detail the status line leaves out.
  next.on('connected', () => {
    emit(platform, { type: 'status', connected: true, connecting: false, message: `Connected to @${username}` })
    const title = next.roomInfo?.data?.data?.title?.[0]
    emit(platform, { type: 'room', username, roomId: next.roomId, title: title ?? '' })
  })

  next.on('disconnected', () => {
    log('warn', 'the socket to TikTok closed on its own')
    emit(platform, { type: 'status', connected: false, message: 'Disconnected' })
  })

  // A failed connect() fires `error` and then rejects, so without this the same
  // failure reaches the UI twice. The rejection is the authoritative one — it
  // carries the typed cause — so `error` is swallowed for the current attempt.
  next.on('error', (err) => {
    const message = describeError(err)
    log('error', message)
    if (sessions.has(platform) && !reportedFailure) {
      reportedFailure = true
      fail(platform, message)
    }
  })

  // `content` carries the text. The older `comment` field this library used to
  // expose is absent on 2.x.
  //
  // The extra flags below all ride along on the chat frame rather than becoming
  // events of their own, so the UI can render one row with several attributes
  // instead of the same message arriving several times.
  const shapesSeen = new Set()

  next.on('chat', (msg) => {
    const who = viewer(msg.user)
    const text = (msg.content ?? '').trim()
    if (!who || !text) return
    announce(platform, who)

    // Moderators are already identified by the platform, confirmed against a live
    // payload: `userAttr.isAdmin` and `isSuperAdmin`. Only carried when set, so
    // the common case stays exactly as small as it was.
    const isModerator = msg.user?.userAttr?.isAdmin === true || msg.user?.userAttr?.isSuperAdmin === true

    // TikTok marks a message it has already filtered. Empty on almost everything,
    // so it rides only when set.
    const isFiltered = Boolean(msg.msgProcessFilterK || msg.msgProcessFilterV)

    const mentions = mentionTargets(msg.atUser)

    emit(platform, {
      type: 'chat',
      ...who,
      text,
      timestamp: Number(msg.common?.createTime ?? Date.now()),
      ...(isModerator ? { isModerator: true } : {}),
      ...(isFiltered ? { isFiltered: true } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...emotePayload(msg.emotes, shapesSeen),
    })
  })

  next.on('gift', (msg) => {
    const who = viewer(msg.user)
    const name = msg.gift?.name
    if (!who || !name) return
    // Attached by the connector from the room's gift catalogue; absent for a gift
    // that catalogue did not know about, which is why this is not the only place
    // the picture is looked for.
    const extended = msg.extendedGiftInfo
    const image = giftImage(msg.gift, extended)
    emit(platform, {
      type: 'gift',
      ...who,
      giftName: extended?.describe || name,
      // `repeatCount` is the running combo total for this gift in this streak,
      // not a one-off count, so one gift sent 400 times arrives as 400.
      count: msg.repeatCount ?? 1,
      diamonds: (msg.gift?.diamondCount ?? 0) * (msg.repeatCount ?? 1),
      ...(image ? { giftImage: image } : {}),
      timestamp: Number(msg.common?.createTime ?? Date.now()),
    })
  })

  next.on('like', (msg) => {
    const who = viewer(msg.user)
    if (!who) return
    emit(platform, { type: 'like', ...who, count: msg.count ?? 1, timestamp: Number(msg.common?.createTime ?? Date.now()) })
  })

  // `total` is how many people are in the room now; `totalUser` only ever climbs
  // and is not a live headcount. Measured 2.9M against 27k at the same instant.
  next.on('roomUser', (msg) => {
    // protobuf int64 arrives as a string, so this is coerced rather than trusted.
    emit(platform, { type: 'viewers', count: Number(msg.total ?? 0) })
  })


  // `member` frames are deliberately not turned into join rows. `memberCount` is
  // only how many are in the room at that instant and drifts constantly, so reading it
  // as a delta produced a `1 joined` row every few seconds that named nobody.
  // `announce()` is the only join signal; the live count is already on the status bar.


  // action 1 is a follow, 4 is a repost/share. Verified against a live room.
  next.on('social', (msg) => {
    const who = viewer(msg.user)
    if (!who) return
    if (msg.action === 1) {
      emit(platform, { type: 'follow', ...who, timestamp: Number(msg.common?.createTime ?? Date.now()) })
    } else if (msg.action === 4) {
      emit(platform, { type: 'share', ...who, timestamp: Number(msg.common?.createTime ?? Date.now()) })
    }
  })

  next.on('streamEnd', () => {
    emit(platform, { type: 'status', connected: false, message: 'The stream has ended.' })
    disconnect(platform)
  })

  try {
    await next.connect()
  } catch (err) {
    sessions.delete(platform)
    // `error` fires before the rejection and reports the same failure, so the
    // catch only speaks up when no error event arrived.
    if (!reportedFailure) fail(platform, describeError(err))
  }
}


// Whatever happens below this point is a bug in the bridge rather than something
// a user caused, and an unhandled rejection would otherwise kill the process
// silently — the UI would just stop updating with no explanation. Reported
// through the log channel so it lands in the app's log panel.
process.on('unhandledRejection', (reason) => {
  log('error', `unhandled rejection: ${reason?.stack ?? reason}`)
})
process.on('uncaughtException', (err) => {
  log('error', `uncaught exception: ${err?.stack ?? err}`)
  process.exit(1)
})

// Exported for the error-mapping and username tests; the host never imports
// this module.
export { describeError, normaliseUsername }

// The host owns this process. When its pipe closes — a normal quit, or the host
// being killed outright, which skips every shutdown handler — there is nobody
// left to read a single more frame, and the open connections would otherwise keep
// the event loop alive indefinitely. Exiting here is what stops a force-killed
// host from leaving an orphan holding a live TikTok connection.
const input = createInterface({ input: process.stdin })
input.on('close', () => process.exit(0))

input.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    send({ type: 'error', platform: 'bridge', message: 'Malformed command from host.' })
    return
  }
  switch (msg.cmd) {
    case 'connect': {
      // `platform` defaults to TikTok so an older host still works, and anything
      // else is refused rather than guessed at: a link pasted into the wrong
      // field should say so, not report "streamer not live".
      const platform = msg.platform ?? 'tiktok'
      const target = msg.target ?? msg.username
      if (platform === 'tiktok') await connectTikTok(target)
      else send({ type: 'error', platform: 'bridge', message: `Unknown platform: ${platform}` })
      break
    }
    case 'disconnect':
      disconnect(msg.platform)
      break
    default:
      send({ type: 'error', platform: 'bridge', message: `Unknown command: ${msg.cmd}` })
  }
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

send({ type: 'ready', platform: 'bridge' })
log('info', 'bridge started')
