/**
 * Drives the installed app through the DevTools protocol.
 *
 * The one thing unit tests cannot cover is the whole loop: a click in the
 * webview -> a Tauri command -> the bridge process -> TikTok -> events back into
 * the DOM. This does exactly that against a live room.
 *
 * Needs WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 and a
 * running instance of the app.
 */

const ENDPOINT = 'http://localhost:9222/json/list'
const USERNAME = process.argv[2]

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const targets = await (await fetch(ENDPOINT)).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
if (!page) {
  console.log('FAIL no app window found on the debug endpoint')
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})

let nextId = 0
const pending = new Map()
socket.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  const resolver = pending.get(msg.id)
  if (resolver) {
    pending.delete(msg.id)
    resolver(msg.result)
  }
}

function send(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve) => {
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

/** Evaluate in the page and return the value, throwing on a page-side error. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'page error')
  }
  return result.result.value
}

await send('Runtime.enable')

console.log('initial state')
check('app renders the empty prompt', (await evaluate(`document.querySelector('.empty-title')?.textContent ?? ''`)) === 'No messages yet')
check('connect button is disabled with no username', await evaluate(`document.querySelectorAll('.room-row .btn-primary')[0]?.disabled === true`))

console.log('enter a username and connect')
await evaluate(`(() => {
  const input = document.querySelector('.room-row .input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(USERNAME)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)

const typed = await evaluate(`document.querySelector('.room-row .input').value`)
check('username reached React state', typed === USERNAME, typed)
check('connect button is now enabled', (await evaluate(`document.querySelectorAll('.room-row .btn-primary')[0]?.disabled === false`)) === true)

await evaluate(`document.querySelectorAll('.room-row .btn-primary')[0].click()`)

console.log('waiting for the room')
const deadline = Date.now() + 45000
let status = ''
let rows = 0
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500))
  status = await evaluate(`document.querySelector('.room-row .status')?.textContent ?? ''`)
  rows = await evaluate(`document.querySelectorAll('.row').length`)
  if (rows > 3 && /Connected/i.test(status)) break
  // TikTok throttles an IP after a burst of connects. Stop here rather than run
  // every remaining assertion against a room that is not going to open.
  if (/rate limit|not live|Could not/i.test(status)) break
}

if (!/Connected/i.test(status)) {
  console.log(`\nSKIPPED — could not connect to @${process.argv[2]}: ${status}`)
  console.log('(TikTok rate limits an IP after repeated connects; wait a few minutes)')
  console.log('(the checks above still ran, so this is not a pass)')
  socket.close()
  process.exit(1)
}

check('status reports connected', /Connected/i.test(status), status)
check('messages arrived in the DOM', rows > 0, `rows=${rows}`)
// The viewer count arrives on its own cadence from TikTok, often a few seconds
// after the first chat, so it gets its own wait rather than being sampled the
// instant chat appears.
let viewersText = ''
const viewersDeadline = Date.now() + 30000
while (Date.now() < viewersDeadline) {
  viewersText = await evaluate(`document.querySelector('.room-row .status')?.textContent ?? ''`)
  if (/watching/.test(viewersText)) break
  await new Promise((r) => setTimeout(r, 1000))
}
// Separators are locale-dependent: en-US writes 44,589, id-ID writes 44.589.
check('viewer count is shown', /watching/.test(viewersText), viewersText)

const firstRow = await evaluate(`(() => {
  const row = document.querySelector('.row')
  if (!row) return null
  return {
    nickname: row.querySelector('.nickname')?.textContent ?? '',
    text: row.querySelector('.text')?.textContent ?? row.querySelector('.event')?.textContent ?? '',
    avatar: !!row.querySelector('.avatar'),
  }
})()`)
check('a row has a name', Boolean(firstRow?.nickname), JSON.stringify(firstRow))
check('a row has content', Boolean(firstRow?.text), JSON.stringify(firstRow))

console.log('filters')
await evaluate(`[...document.querySelectorAll('.chip')].find((c) => c.textContent.startsWith('Chat'))?.click()`)
await new Promise((r) => setTimeout(r, 600))
check('chat filter keeps the list non-empty', (await evaluate(`document.querySelectorAll('.row').length`)) > 0)
check('chat filter removes gift rows', (await evaluate(`document.querySelectorAll('.row-gift').length`)) === 0)

await evaluate(`(() => {
  const input = document.querySelector('.input-search')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'zzzzz-no-such-name')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await new Promise((r) => setTimeout(r, 600))
check('a search with no matches empties the list', (await evaluate(`document.querySelectorAll('.row').length`)) === 0)
check('the empty prompt returns', (await evaluate(`!!document.querySelector('.empty')`)) === true)

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
socket.close()
process.exit(failures === 0 ? 0 : 1)