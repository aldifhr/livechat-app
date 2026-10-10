/**
 * Disconnect and orphan checks against the running app.
 *
 * The disconnect path and the teardown path are the two places a leaked TikTok
 * connection would hide: a leaked bridge keeps receiving events that go nowhere.
 */

import { spawn } from 'node:child_process'

const targets = await (await fetch('http://localhost:9222/json/list')).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
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

const bridgeCount = async () => {
  const out = await new Promise((resolve) => {
    const ps = spawn('powershell', [
      '-NoProfile',
      '-Command',
      '(Get-Process livechat-bridge -ErrorAction SilentlyContinue | Measure-Object).Count',
    ])
    let data = ''
    ps.stdout.on('data', (c) => (data += c))
    ps.on('close', () => resolve(parseInt(data.trim(), 10)))
  })
  return Number.isNaN(out) ? 0 : out
}

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('disconnect')
console.log('  bridges before:', await bridgeCount())
// Each room is its own row with its own buttons, so they are addressed by index
// within the row rather than by class alone.
const rowStatus = () => evaluate(`document.querySelector('.room-row .status')?.textContent ?? ''`)

await evaluate(`(() => {
  const input = document.querySelectorAll('.room-row .input')[0]
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(process.argv[2])})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
// Waited on rather than fired straight away: a click landing before React has
// committed the typed value sends an empty target to the host.
const enabled = await (async () => {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await evaluate(`document.querySelectorAll('.room-row .btn-primary')[0]?.disabled === false`)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
})()
await evaluate(`document.querySelectorAll('.room-row .btn-primary')[0]?.click()`)

const deadline = Date.now() + 40000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000))
  if (/Connected/i.test(await rowStatus())) break
}
const connected = /Connected/i.test(await rowStatus())

if (!connected) {
  // TikTok throttles an IP after repeated connects, which is not a defect in the
  // disconnect path — there is no connection to disconnect.
  console.log(`\nSKIPPED — could not connect: ${await rowStatus()}`)
  console.log(failures === 0 ? 'all passed (connection skipped)' : `\n${failures} failed`)
  socket.close()
  process.exit(failures === 0 ? 0 : 1)
}

check('connected', true, await rowStatus())
check('bridge is running', (await bridgeCount()) > 0)

await evaluate(`document.querySelectorAll('.room-row .btn-danger')[0]?.click()`)
await new Promise((r) => setTimeout(r, 2500))
check('status shows disconnected', /Disconnected/i.test(await rowStatus()), await rowStatus())
check('bridge process is gone', (await bridgeCount()) === 0, `count=${await bridgeCount()}`)
check(
  'connect button returns',
  (await evaluate(`!!document.querySelectorAll('.room-row .btn-primary')[0]`)) === true,
)

console.log(`\n${failures === 0 ? 'all passed' : `${failures} failed`}`)
socket.close()
process.exit(failures === 0 ? 0 : 1)