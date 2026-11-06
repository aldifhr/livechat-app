// Wire-frame translation for TikTok LIVE events.
//
// This is the Node replacement for api/events.py: every TikTok event becomes
// the same frame shape the overlays and dashboard already consume
// (shared/events.ts). Keep the kinds in step with that union —
// web/test/test-event-contract.mjs reads this file to pin it.

export const FRAME_KINDS = [
  'comment',
  'gift',
  'like',
  'join',
  'follow',
  'intro',
  'notice',
  'subscription',
  'poll',
  'viewers',
  'share',
  'alert',
  'status',
  'error',
  'config',
]

const PLACEHOLDER = new Set(['', '?', 'not found', 'unknown', '-', 'null', 'none'])

export function displayName(user) {
  const name = (user?.nickname || '').trim()
  if (!name || PLACEHOLDER.has(name.toLowerCase())) return null
  return name
}

export function userId(user) {
  // tiktok-live-connector v2: the @handle is `displayId`, the stable numeric
  // id is `id`. Older shapes used uniqueId/userId.
  return (user?.displayId || user?.uniqueId || user?.userId || user?.id || '').toString().trim()
}

export function avatarUrl(user) {
  // v2 proto: avatarMedium/avatarThumb/avatarLarge are ImageModel { urlList }.
  for (const model of [user?.avatarMedium, user?.avatarThumb, user?.avatarLarge, user?.avatar]) {
    const url = model?.urlList?.[0] || (Array.isArray(model) ? model[0] : null)
    if (url) return String(url)
  }
  // Older connector shapes.
  const pic = user?.profilePicture || user?.profile_picture || {}
  return pic.url || pic['url'] || ''
}

function named(user) {
  const name = displayName(user)
  return { user: name, userId: userId(user) || name, avatar: avatarUrl(user) }
}

// Stored config keys -> the names an overlay page reads (models.py page_config).
export const OVERLAY_STYLE_KEYS = {
  overlaySize: 'size',
  overlayNameColour: 'nameColour',
  overlayTextColour: 'textColour',
  overlayBg: 'background',
  overlayMax: 'max',
  overlayDelay: 'delay',
  overlayFont: 'font',
  overlayPosition: 'position',
  overlayMaxWidth: 'maxWidth',
  overlayBubbleOpacity: 'bubbleOpacity',
  overlayGiftColour: 'giftColour',
  overlayTitle: 'title',
  overlayTitleColour: 'titleColour',
  catPalette: 'pal',
  catChonk: 'chonk',
  likeTarget: 'likeTarget',
  likeTitle: 'likeTitle',
  likeSize: 'likeSize',
  likeBarColour: 'likeBarColour',
  likeTextColour: 'likeTextColour',
  likePosition: 'likePosition',
}

export function pageConfig(config) {
  if (!config || typeof config !== 'object') return {}
  const out = {}
  for (const [stored, page] of Object.entries(OVERLAY_STYLE_KEYS)) {
    if (config[stored] !== undefined) out[page] = config[stored]
  }
  return out
}

// Gift streaks: TikTok sends repeat_count as a cumulative total. The python
// backend kept per-user streak state to turn that into a per-frame delta;
// here we track the last cumulative count per (user, gift).
const streaks = new Map()
export function streakStep(key, repeatCount, diamondCount, repeatEnd) {
  const cumulative = Number(repeatCount || 0)
  const diamonds = Number(diamondCount || 0)
  if (!cumulative || !diamonds) return null
  const last = streaks.get(key) || 0
  const count = cumulative > last ? cumulative - last : cumulative
  if (repeatEnd) streaks.delete(key)
  else streaks.set(key, cumulative)
  return { count: Math.max(1, count), value: Math.max(0, count) * diamonds }
}

export function toFrame(kind, event) {
  const user = event?.user
  switch (kind) {
    case 'comment': {
      const n = named(user)
      if (!n.user) return null
      const frame = { type: 'comment', ...n, text: event.comment || '' }
      const mentions = [
        ...new Set(
          (event.mentionUsers || event.mention_users || [])
            .map((u) => u?.uniqueId || u?.username || '')
            .filter(Boolean),
        ),
      ]
      if (!mentions.length && event.atUser) {
        const h = event.atUser.uniqueId || event.atUser.username
        if (h) mentions.push(h)
      }
      if (mentions.length) frame.mentions = mentions
      if (user?.isModerator || user?.moderator) frame.isModerator = true
      return frame
    }
    case 'like': {
      const n = named(user)
      if (!n.user) return null
      return { type: 'like', ...n, count: Number(event.likeCount ?? event.count ?? 1), totalLikes: Number(event.totalLikeCount ?? event.total ?? 0) }
    }
    case 'gift': {
      const n = named(user)
      if (!n.user || !event.gift) return null
      const giftId = event.gift.id ?? event.giftId ?? 0
      const step = streakStep(`${n.userId}:${giftId}`, event.repeatCount, event.gift.diamondCount ?? event.gift.diamond_count, event.repeatEnd)
      if (!step) return null
      const frame = {
        type: 'gift',
        ...n,
        giftName: event.gift.name || 'Gift',
        count: step.count,
        value: step.value,
      }
      const img = event.gift.image?.url || event.gift.imageUrl || event.extendedGiftInfo?.image?.url
      if (img) frame.giftImage = img
      return frame
    }
    case 'join': {
      const n = named(user)
      if (!n.user) return null
      return { type: 'join', ...n, viewers: Number(event.memberCount ?? 0) }
    }
    case 'follow': {
      const n = named(user)
      if (!n.user) return null
      return { type: 'follow', ...n }
    }
    case 'share': {
      const n = named(user)
      if (!n.user) return null
      return { type: 'share', ...n, count: Number(event.shareCount ?? event.usersJoined ?? 1) }
    }
    case 'viewers':
      return { type: 'viewers', count: Number(event.totalUserCount ?? event.total ?? event.totalUser ?? 0) }
    case 'intro': {
      const n = named(user)
      if (!n.user) return null
      return { type: 'intro', ...n, title: event.description || event.content || '' }
    }
    case 'subscription': {
      const n = named(user)
      if (!n.user) return null
      return { type: 'subscription', ...n, months: Number(event.subMonth ?? 0), isSend: !!event.isSend, isCustom: !!event.isCustom }
    }
    case 'notice': {
      const text = (event.content || '').trim()
      if (!text) return null
      const frame = { type: 'notice', text }
      const name = displayName(user)
      if (name) frame.user = name
      if (event.source) frame.source = event.source
      return frame
    }
    case 'poll': {
      const content = event.startContent || event.endContent || event.content
      if (!content) return null
      const question = content.title || ''
      if (!question) return null
      const options = (content.optionList || content.options || [])
        .map((o) => o.displayContent || o.title || '')
        .filter((s) => s.trim())
      return { type: 'poll', pollId: String(event.pollId || ''), question, options, state: String(event.messageType || '') }
    }
    default:
      return null
  }
}

export function statusFrame({ connected, message, connecting = false, liveEnded = false, waiting = false }) {
  const frame = { type: 'status', connected, message }
  if (connecting) frame.connecting = true
  if (liveEnded) frame.liveEnded = true
  if (waiting) frame.waiting = true
  return frame
}
