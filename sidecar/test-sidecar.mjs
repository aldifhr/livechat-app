/**
 * Sidecar tests.
 *
 * The username parsing and error mapping are the two places where a wrong answer
 * is invisible until it reaches a user, so both are pinned here against the real
 * sidecar process rather than a copy of its logic.
 *
 *   node sidecar/test-sidecar.mjs            # offline-safe tests only
 *   node sidecar/test-sidecar.mjs @someuser  # also connects for 20s
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

// Resolved from this file, not from cwd, so the suite runs the same whether it is
// started in `sidecar/` or from the repo root.
const BRIDGE = fileURLToPath(new URL('index.mjs', import.meta.url))

let failures = 0

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Runs the sidecar, feeds it commands, and collects everything it emits. */
function runSidecar(username, waitMs) {
  return new Promise((resolve) => {
const child = spawn(process.execPath, [BRIDGE], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
    const events = []
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        events.push(JSON.parse(line))
      } catch {
        // A non-JSON line on stdout is itself a defect: the Rust side reads every
        // stdout line as a frame, so anything else is a malformed frame.
        events.push({ type: 'UNPARSEABLE', raw: line })
      }
    })
    child.stdin.write(JSON.stringify({ cmd: 'connect', username }) + '\n')
    setTimeout(() => {
      child.kill()
      resolve(events)
    }, waitMs)
  })
}

console.log('username normalisation')
{
  const child = spawn(process.execPath, [BRIDGE], { stdio: ['pipe', 'pipe', 'inherit'] })
  const events = []
  createInterface({ input: child.stdout }).on('line', (l) => events.push(JSON.parse(l)))
  child.stdin.write(JSON.stringify({ cmd: 'connect', username: '   ' }) + '\n')
  await new Promise((r) => setTimeout(r, 600))
  child.kill()
  const err = events.find((e) => e.type === 'error')
  check('blank username is refused', Boolean(err), JSON.stringify(events))
  check('blank username never opens a room', !events.some((e) => e.type === 'room'))
}

console.log('malformed input')
{
  const child = spawn(process.execPath, [BRIDGE], { stdio: ['pipe', 'pipe', 'inherit'] })
  const events = []
  createInterface({ input: child.stdout }).on('line', (l) => events.push(JSON.parse(l)))
  child.stdin.write('not json at all\n')
  child.stdin.write(JSON.stringify({ cmd: 'nonsense' }) + '\n')
  await new Promise((r) => setTimeout(r, 700))
  child.kill()
  const errors = events.filter((e) => e.type === 'error').map((e) => e.message)
  check('bad JSON is reported', errors.some((m) => /Malformed/.test(m)), JSON.stringify(errors))
  check('unknown command is reported', errors.some((m) => /Unknown command/.test(m)), JSON.stringify(errors))
  check('bridge survives bad input', events.some((e) => e.type === 'ready'))
}

const live = process.argv[2]
if (live) {
  console.log(`live room: @${live}`)
  const events = await runSidecar(live, 22000)
  const byType = {}
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1

  check('no unparseable stdout lines', !events.some((e) => e.type === 'UNPARSEABLE'), JSON.stringify(events.filter((e) => e.type === 'UNPARSEABLE')))
  check('bridge announced ready', byType.ready === 1)
  check('room was opened', byType.room === 1, JSON.stringify(byType))
  check('a connecting status came first', events.some((e) => e.type === 'status' && e.connecting === true))
  check('connected status arrived', events.some((e) => e.type === 'status' && e.connected === true))

  const chats = events.filter((e) => e.type === 'chat')
  check('chat arrived', chats.length > 0, `got ${chats.length}`)
  check(
    'every chat carries user, text and time',
    chats.every((c) => c.nickname && c.text && Number.isFinite(c.timestamp)),
    JSON.stringify(chats[0]),
  )
  check('no placeholder nicknames', !chats.some((c) => /^(not found|\?|unknown|-|null|none)$/i.test(c.nickname)))
  check('avatars are absolute urls', chats.every((c) => c.avatar === '' || c.avatar.startsWith('https://')))

  const gifts = events.filter((e) => e.type === 'gift')
  check(
    'gifts carry a name, count and diamonds',
    gifts.every((g) => g.giftName && Number.isFinite(g.count) && Number.isFinite(g.diamonds)),
    JSON.stringify(gifts[0]),
  )

  const viewers = events.filter((e) => e.type === 'viewers')
  check('viewer counts are numbers, not strings', viewers.every((v) => typeof v.count === 'number'), JSON.stringify(viewers[0]))
  check('viewer counts are positive', viewers.every((v) => v.count > 0), JSON.stringify(viewers[0]))

  check('no duplicate error for one failure', events.filter((e) => e.type === 'error').length <= 1)

  console.log('\n  counts:', JSON.stringify(byType))
} else {
  console.log('\n(pass a live @username to also test a real room)')
}

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)