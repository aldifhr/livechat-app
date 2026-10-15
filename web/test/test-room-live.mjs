/**
 * The room picker's ordering and wording, checked without a browser.
 *
 * The bug this is here to catch: both pickers listed every room in store order and
 * defaulted to the first, which is the order they were created in. So the preview
 * opened on an offline room while a live one sat further down the list, and a name
 * alone gave no way to tell which could produce a chat. The fix is a sort and a
 * label — and a sort that is subtly wrong is invisible until somebody notices the
 * picker keeps opening on the wrong room, which is how this was found.
 *
 * Run with: npm test (from web/)
 */

import { labelOf, liveOf, orderForPicker, pickDefaultRoom } from '../src/lib/roomLive.ts'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const room = (id, name) => ({ id, name, username: name, config: {}, createdAt: 0 })

console.log('what a status means')
check('connected is live', liveOf({ connected: true }) === 'live', liveOf({ connected: true }))
check('waiting is waiting', liveOf({ connected: false, waiting: true }) === 'waiting', liveOf({ connected: false, waiting: true }))
// The backend sets both while it polls for a streamer whose live just ended.
check('an ended live that is being waited on is waiting',
  liveOf({ connected: false, liveEnded: true, waiting: true }) === 'waiting')
check('an ended live with no wait is waiting too, not offline',
  liveOf({ connected: false, liveEnded: true }) === 'waiting')
check('a plain disconnect is offline', liveOf({ connected: false }) === 'offline', liveOf({ connected: false }))
// A status that could not be read is not evidence the room is down, but it is also
// not evidence it is up — offline is the honest reading.
check('no status at all is offline', liveOf(undefined) === 'offline', liveOf(undefined))
check('and null is too', liveOf(null) === 'offline', liveOf(null))
// A live room that also carries a stale waiting flag must read live, or a room
// that is streaming would sort below one that is not.
check('connected wins over a stale waiting flag',
  liveOf({ connected: true, waiting: true }) === 'live')

console.log('the words')
check('live says LIVE', labelOf('live') === 'LIVE', labelOf('live'))
check('offline says offline', labelOf('offline') === 'offline', labelOf('offline'))
check('waiting says so rather than claiming to connect',
  labelOf('waiting') === 'offline — waiting', labelOf('waiting'))

console.log('the order a picker reads')
const rooms = [room('a', 'itswyss'), room('b', 'kaizeechiato'), room('c', 'afdhalyusmann')]
const statuses = {
  a: { connected: false },                        // offline, and first in store order
  b: { connected: false, waiting: true },          // waiting
  c: { connected: true, viewers: 2684 },           // live
}
const ordered = orderForPicker(rooms, statuses)
check('live comes first', ordered[0].room.id === 'c', ordered.map((o) => o.room.id).join(','))
check('then waiting', ordered[1].room.id === 'b', ordered.map((o) => o.room.id).join(','))
check('then offline', ordered[2].room.id === 'a', ordered.map((o) => o.room.id).join(','))
check('every room is still there', ordered.length === rooms.length, ordered.length)

console.log('and the order within a group is left alone')
// A sort that reordered equal entries would make the list jump between polls for
// no reason anyone could see.
const twoLive = [room('x', 'first'), room('y', 'second')]
const bothLive = orderForPicker(twoLive, { x: { connected: true }, y: { connected: true } })
check('two live rooms keep their original order',
  bothLive[0].room.id === 'x' && bothLive[1].room.id === 'y',
  bothLive.map((o) => o.room.id).join(','))

console.log('which room a picker opens on')
// Given the *unsorted* list, which is the real situation at the call site in
// `LivePreview` before the sort is applied — and the one where "first" and "first
// live" are different rooms. Against the sorted list they happen to coincide, so a
// test that only used `ordered` would pass even with the live-preference removed.
const unsorted = rooms.map((r) => ({ room: r, live: liveOf(statuses[r.id]) }))
check('the first live one, not the first in store order',
  pickDefaultRoom(unsorted) === 'c', pickDefaultRoom(unsorted))
check('and that is a different room from the first entry',
  unsorted[0].room.id !== pickDefaultRoom(unsorted), `${unsorted[0].room.id} vs ${pickDefaultRoom(unsorted)}`)
// A link from the builder names its room, and that must win or the link opens
// something other than what it says.
check('a requested room wins', pickDefaultRoom(ordered, 'a') === 'a', pickDefaultRoom(ordered, 'a'))
check('a stale requested room is ignored', pickDefaultRoom(ordered, 'gone') === 'c', pickDefaultRoom(ordered, 'gone'))

console.log('when nothing is live')
const allOffline = orderForPicker(rooms, { a: { connected: false }, b: { connected: false }, c: { connected: false } })
// An all-offline list still has rooms worth styling, so the picker must land on
// one rather than on nothing.
check('it falls back to the first room', pickDefaultRoom(allOffline) === 'a', pickDefaultRoom(allOffline))
check('and an empty list gives an empty id', pickDefaultRoom([]) === '', pickDefaultRoom([]))

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
