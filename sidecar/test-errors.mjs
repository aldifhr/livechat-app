/**
 * Error-mapping and username-parsing tests.
 *
 * These strings are the only explanation a user ever gets for a failed
 * connection, so each one is pinned to the failure it is meant to describe. A
 * regression here is invisible until a real user hits that exact failure.
 *
 * Importing the module runs its top level, which spawns the bridge's own stdin
 * reader — harmless here, since nothing is ever written to it.
 */

import { describeError, normaliseUsername } from './index.mjs'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

console.log('username normalisation')
eq('plain handle', normaliseUsername('mpl.id.official'), 'mpl.id.official')
eq('leading @', normaliseUsername('@khaby.lame'), 'khaby.lame')
eq('several @', normaliseUsername('@@khaby.lame'), 'khaby.lame')
eq('surrounding space', normaliseUsername('  khaby.lame  '), 'khaby.lame')
eq('live url', normaliseUsername('https://www.tiktok.com/@khaby.lame/live'), 'khaby.lame')
eq('url without scheme', normaliseUsername('tiktok.com/@khaby.lame'), 'khaby.lame')
eq('url with a trailing path', normaliseUsername('https://www.tiktok.com/@khaby.lame?lang=en'), 'khaby.lame')
eq('empty', normaliseUsername(''), '')
eq('only whitespace', normaliseUsername('   '), '')
eq('only an @', normaliseUsername('@'), '')
eq('non-string', normaliseUsername(undefined), '')

console.log('error mapping')
// The library wraps its cause one or two levels deep depending on whether the
// failure arrived as an event or as a rejection, so both shapes are exercised.
class FakeOffline extends Error {
  constructor() {
    super('offline')
    this.name = 'UserOfflineError'
  }
}
const offline = new FakeOffline()

eq('offline, thrown directly', describeError(offline), 'Streamer is not live right now.')
eq('offline, wrapped by the event emitter', describeError({ info: 'Error while connecting', exception: offline }), 'Streamer is not live right now.')
eq('bad handle', describeError({ name: 'InvalidUniqueIdError' }), 'That does not look like a TikTok username.')
eq(
  'rate limit by cause name',
  describeError({ name: 'SignatureRateLimitError', reason: 'Rate Limited', message: '[Rate Limited] (rate_limit_account_hour) Too many connections started, try again later.' }),
  'Rate limited by TikTok. Wait a minute before reconnecting.',
)
eq(
  'rate limit by message text',
  describeError({ info: 'HTTP 429 rate limit' }),
  'Rate limited by TikTok. Wait a minute before reconnecting.',
)
eq(
  'room unreachable',
  describeError({ info: 'Failed to retrieve Room ID from all sources.' }),
  'Could not reach the room. The streamer may be offline, or TikTok may be rate limiting this IP.',
)
eq(
  'bare wrapper text',
  describeError({ info: 'Error while connecting' }),
  'Could not connect to TikTok. Check the username and your connection.',
)
eq(
  'nested cause wins over the wrapper',
  describeError({ info: 'Error while connecting', exception: { message: 'websocket closed (1006)' } }),
  'websocket closed (1006)',
)
eq('nothing to go on', describeError({}), 'Unknown error')
eq('null error', describeError(null), 'Unknown error')

console.log('no message leaks raw internals')
for (const input of [{}, null, { info: 'Error while connecting' }, offline]) {
  const message = describeError(input)
  check(
    `message for ${JSON.stringify(input?.info ?? input?.name ?? input)} is human`,
    message.length > 0 && !message.includes('   |   '),
    message,
  )
}

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)