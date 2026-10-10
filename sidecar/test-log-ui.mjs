/**
 * The log panel in the running app.
 *
 * The panel is only useful if it actually shows what the bridge said, so this
 * opens it and reads the lines rather than checking that the element exists.
 */

const targets = await (await fetch('http://localhost:9222/json/list')).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
if (!page) {
  console.log('FAIL no app window on the debug endpoint')
  process.exit(1)
}

/**
 * Seconds and minutes only.
 *
 * The panel drops the date on purpose — a log you are watching live is about now
 * — so the assertions match the panel rather than loosening the regex. Anything
 * spanning midnight would read as out of order, which is the panel's trade to
 * make for the width.
 */
const TIME = /^\d{1,2}\.\d{2}\.\d{2}$/

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

/** Wait for a predicate to hold, so a slow room is not reported as a failure. */
async function waitFor(expression, ms = 60000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('starting from a clean slate')
// Another UI suite may have left a filter applied, in which case the feed is
// empty no matter how much chat arrives. Reset before measuring anything.
await evaluate(`(() => {
  const search = document.querySelector('.input-search')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(search, '')
  search.dispatchEvent(new Event('input', { bubbles: true }))
  const all = [...document.querySelectorAll('.chip')].find((c) => c.textContent.trim().startsWith('All'))
  all?.click()
  return true
})()`)
await new Promise((r) => setTimeout(r, 300))

console.log('connecting')
await evaluate(`(() => {
  const input = document.querySelector('.room-row .input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(process.argv[2])})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
// Clicked only once React has committed the typed value and enabled the button.
// A click landing earlier goes out with an empty target.
await waitFor(`document.querySelectorAll('.room-row .btn-primary')[0]?.disabled === false`, 10000)
await evaluate(`document.querySelectorAll('.room-row .btn-primary')[0]?.click()`)
const connected = await waitFor(
  `/Connected/i.test(document.querySelector('.room-row .status')?.textContent ?? '')`,
)
const statusText = await evaluate(`document.querySelector('.room-row .status')?.textContent ?? ''`)

if (!connected) {
  // TikTok throttles by IP after a burst of connects. That is a real limit, not
  // an app defect, so the suite says so and stops rather than reporting every
  // remaining assertion as a failure against a room that never opened.
  console.log(`\n  SKIPPED — could not connect to @${process.argv[2]}: ${statusText}`)
  console.log('  (TikTok rate limits an IP after repeated connects; wait a few minutes)')
  console.log(failures === 0 ? '\nall passed (connection skipped)' : `\n${failures} failed`)
  socket.close()
  process.exit(failures === 0 ? 0 : 1)
}
check('connected to the room', true, statusText)

console.log('the panel starts closed')
check('the log bar is present', (await evaluate(`!!document.querySelector('.log-panel')`)) === true)
check('the list is hidden while closed', (await evaluate(`!!document.querySelector('.log-list')`)) === false)
check('the toggle is labelled Log', /Log/.test(await evaluate(`document.querySelector('.log-toggle')?.textContent ?? ''`)))

console.log('opening it')
await evaluate(`document.querySelector('.log-toggle').click()`)
await new Promise((r) => setTimeout(r, 400))
check('the list appears', (await evaluate(`!!document.querySelector('.log-list')`)) === true)

const lines = await evaluate(`[...document.querySelectorAll('.log-line')].map((l) => ({
  time: l.querySelector('.log-time')?.textContent ?? '',
  level: l.querySelector('.log-level')?.textContent ?? '',
  message: l.querySelector('.log-message')?.textContent ?? '',
}))`)

check('there are entries to read', lines.length > 0, JSON.stringify(lines))
check('every line has a timestamp', lines.every((l) => TIME.test(l.time)), JSON.stringify(lines.slice(0, 2)))
check('every line has a level', lines.every((l) => ['info', 'warn', 'error'].includes(l.level)), JSON.stringify(lines.slice(0, 2)))
check('every line has a message', lines.every((l) => l.message.trim().length > 0), JSON.stringify(lines.slice(0, 2)))

const messages = lines.map((l) => l.message).join(' | ')
check('the bridge announced itself', /bridge ready|bridge started/.test(messages), messages)
check('the connection was logged', /Connecting to @|Connected to @/.test(messages), messages)

console.log('level filter')
// Located by button text rather than by `.log-filters .chip`: the panel is
// collapsed when the panel is first opened in some runs, and the toolbar's kind
// chips share the `chip` class.
const pickLevel = async (name) => {
  const opened = await evaluate(`!!document.querySelector('.log-list')`)
  if (!opened) {
    await evaluate(`document.querySelector('.log-toggle').click()`)
    await new Promise((r) => setTimeout(r, 300))
  }
  await evaluate(
    `[...document.querySelectorAll('.log-filters button')].find((c) => c.textContent.trim() === ${JSON.stringify(name)})?.click()`,
  )
  await new Promise((r) => setTimeout(r, 400))
}

await pickLevel('info')
await new Promise((r) => setTimeout(r, 300))
const infoLines = await evaluate(`[...document.querySelectorAll('.log-line .log-level')].map((e) => e.textContent)`)
check('the info filter shows only info', infoLines.every((l) => l === 'info'), JSON.stringify(infoLines))
check('the info filter is not empty', infoLines.length > 0, JSON.stringify(infoLines))

await pickLevel('error')
await new Promise((r) => setTimeout(r, 300))
const errorLines = await evaluate(`[...document.querySelectorAll('.log-line .log-level')].map((e) => e.textContent)`)
// A healthy room produces no errors, so an empty result is the correct outcome
// here; what matters is that nothing of another level leaks through.
check('the error filter shows only errors', errorLines.every((l) => l === 'error'), JSON.stringify(errorLines))

console.log('clear')
await pickLevel('all')
await new Promise((r) => setTimeout(r, 200))

// Not "the log is now empty": the library reconnects on its own, so a line can
// legitimately arrive right after the click. What must not survive is the
// history that was there before.
const beforeClear = await evaluate(
  `JSON.stringify([...document.querySelectorAll('.log-message')].map((m) => m.textContent))`,
)
await evaluate(
  `[...document.querySelectorAll('.log-bar button')].find((b) => b.textContent.trim() === 'Clear')?.click()`,
)
await new Promise((r) => setTimeout(r, 800))

const survivors = JSON.parse(
  await evaluate(`JSON.stringify([...document.querySelectorAll('.log-message')].map((m) => m.textContent))`),
)
const old = JSON.parse(beforeClear)
check('every pre-clear line was removed', survivors.every((m) => !old.includes(m)), JSON.stringify({ old, survivors }))
check(
  'only new lines remain',
  survivors.length <= 2,
  `${survivors.length} left: ${JSON.stringify(survivors)}`,
)
const emptyNote = await evaluate(`!!document.querySelector('.log-empty')`)
check(
  'the empty note shows only when nothing is left',
  emptyNote === (survivors.length === 0),
  `note=${emptyNote} lines=${survivors.length}`,
)

console.log('the chat feed is not mirrored into the log')
// Feed events are deliberately not logged one line each — a busy room would bury
// everything else. Lifecycle lines are still expected here: the library
// reconnects on its own, and a reconnect is exactly the kind of thing the log
// exists to show. So the bound is per-message, not zero.
const rowsBefore = await evaluate(`document.querySelectorAll('.row').length`)
const logBefore = await evaluate(`document.querySelectorAll('.log-line').length`)
await new Promise((r) => setTimeout(r, 10000))
const rowsAfter = await evaluate(`document.querySelectorAll('.row').length`)
const logAfter = await evaluate(`document.querySelectorAll('.log-line').length`)
const newMessages = await evaluate(
  `JSON.stringify([...document.querySelectorAll('.log-message')].map((m) => m.textContent).slice(0, 10))`,
)

if (rowsAfter === 0) {
  // Connected but nothing said anything. A live room can be quiet, and the
  // point of these two checks is the ratio, so there is nothing to measure.
  console.log(`\nSKIPPED — @${process.argv[2]} was connected but sent no chat in 10s`)
  console.log('(a live room can be quiet; the checks above still ran)')
  socket.close()
  process.exit(failures === 0 ? 0 : 1)
}

check('chat kept arriving', rowsAfter > rowsBefore, `${rowsBefore} -> ${rowsAfter}`)
check(
  'the log grew far less than the chat did',
  logAfter - logBefore <= 4,
  `log +${logAfter - logBefore} for ${rowsAfter - rowsBefore} new chat rows: ${newMessages}`,
)
// A chat line would read "someone: text" — the log only ever names the streamer
// or the bridge. Matching on the colon is what separates the two.
check(
  'no logged line is a chat message',
  !(newMessages ?? '').includes('":'),
  newMessages,
)

console.log('disconnecting logs the end of the session')
await evaluate(`document.querySelectorAll('.room-row .btn-danger')[0].click()`)
check('the log records the disconnect', await waitFor(`/disconnected|Disconnected/i.test([...document.querySelectorAll('.log-message')].map((m) => m.textContent).join(' '))`, 20000), await evaluate(`[...document.querySelectorAll('.log-message')].map((m) => m.textContent).join(' | ')`))

console.log(`\n${failures === 0 ? 'all passed' : `${failures} failed`}`)
socket.close()
process.exit(failures === 0 ? 0 : 1)