/**
 * The failure path in the installed app.
 *
 * Whatever is happening upstream — the streamer is offline, or TikTok is rate
 * limiting — the user has to end up looking at an explanation, not a spinner and
 * a dead Connect button. Run while nothing is known to be wrong, this asserts the
 * app recovers and stays usable.
 */

const targets = await (await fetch('http://localhost:9222/json/list')).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
if (!page) {
  console.log('FAIL no app window on the debug endpoint')
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  socket.onopen = res
  socket.onerror = rej
})
let nextId = 0
const pending = new Map()
socket.onmessage = (e) => {
  const m = JSON.parse(e.data)
  const r = pending.get(m.id)
  if (r) {
    pending.delete(m.id)
    r(m.result)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) return 'THREW: ' + (r.exceptionDetails.exception?.description ?? '')
  return r.result.value
}
await send('Runtime.enable')

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// Each room is its own row, so the fields and buttons are addressed by index
// within that row rather than by class alone.
const rowStatus = () => evaluate(`document.querySelector('.room-row .status')?.textContent ?? ''`)

async function tryConnect(username) {
  await evaluate(`(() => {
    const input = document.querySelectorAll('.room-row .input')[0]
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(username)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

  // Waited on rather than fired straight away: a click landing before React has
  // committed the typed value sends an empty target to the host.
  const enabled = Date.now() + 10000
  while (Date.now() < enabled) {
    if (await evaluate(`document.querySelectorAll('.room-row .btn-primary')[0]?.disabled === false`)) break
    await new Promise((r) => setTimeout(r, 300))
  }
  await evaluate(`document.querySelectorAll('.room-row .btn-primary')[0]?.click()`)

  // Wait for the attempt to settle one way or the other.
  const deadline = Date.now() + 40000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    const text = await rowStatus()
    if (/Connected/i.test(text) || /not live|Rate limit|Could not/i.test(text)) return text
  }
  return await rowStatus()
}

for (const username of process.argv.slice(2)) {
  console.log(`connecting to @${username}`)
  const text = await tryConnect(username)

  check('the app says something specific', text.trim().length > 0, JSON.stringify(text))
  check('no raw stack or library internals leak', !/\bat\s+\w+\s+\(/.test(text), text)

  if (/Connected/i.test(text)) {
    console.log('  (this streamer is live, so the failure path cannot be exercised)')
    await evaluate(`document.querySelectorAll('.room-row .btn-danger')[0]?.click()`)
    await new Promise((r) => setTimeout(r, 2000))
    continue
  }

  check(
    'the status badge shows the error state',
    // The class list carries the row modifier too, so it is matched rather than
    // compared exactly.
    /(^|\s)status-error(\s|$)/.test(await evaluate(`document.querySelector('.room-row .status')?.className ?? ''`)),
    await evaluate(`document.querySelector('.room-row .status')?.className`),
  )
  check(
    'the Connect button comes back',
    (await evaluate(`!!document.querySelectorAll('.room-row .btn-primary')[0]`)) === true,
  )
  check(
    'the input is usable again',
    (await evaluate(`document.querySelectorAll('.room-row .input')[0].disabled === false`)) === true,
  )
}

console.log(`\n${failures === 0 ? 'all passed' : `${failures} failed`}`)
socket.close()
process.exit(failures === 0 ? 0 : 1)