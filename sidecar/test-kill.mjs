/**
 * Kills the app outright while a room is connected.
 *
 * A force-kill runs no shutdown handler at all, so the host never gets to kill
 * its child. The bridge must notice on its own that its stdin pipe closed —
 * otherwise it sits there holding a live TikTok connection that nobody reads.
 */

import { spawn, execSync } from 'node:child_process'

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

const bridgeCount = () =>
  Number(
    execSync('(Get-Process livechat-bridge -ErrorAction SilentlyContinue | Measure-Object).Count', {
      shell: 'powershell.exe',
      encoding: 'utf8',
    }).trim(),
  ) || 0

await evaluate(`(() => {
  const input = document.querySelectorAll('.room-row .input')[0]
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(process.argv[2])})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
// Each room now has its own row and its own Connect button, so the first one is
// addressed by index rather than by class alone. Waited on rather than fired
// straight away: a click landing before React commits the typed value sends an
// empty target to the host.
const enabledDeadline = Date.now() + 10000
while (Date.now() < enabledDeadline) {
  if (await evaluate(`document.querySelectorAll('.room-row .btn-primary')[0]?.disabled === false`)) break
  await new Promise((r) => setTimeout(r, 300))
}
await evaluate(`document.querySelectorAll('.room-row .btn-primary')[0]?.click()`)

for (let n = 0; n < 40; n++) {
  await new Promise((r) => setTimeout(r, 1000))
  if (/Connected/i.test(await evaluate(`document.querySelector('.room-row .status')?.textContent ?? ''`))) break
}
const statusText = await evaluate(`document.querySelector('.room-row .status')?.textContent ?? ''`)
console.log('status:', statusText)
if (bridgeCount() === 0) {
  // TikTok rate limits an IP after a burst of connects. That is a real limit,
  // and an orphan test that cannot run is not evidence of an orphan.
  console.log(`SKIPPED — could not connect: ${statusText}`)
  process.exit(0)
}
console.log('bridges while connected:', bridgeCount())

console.log('killing the app without letting it shut down')
execSync('Stop-Process -Name livechat-app -Force', { shell: 'powershell.exe' })

await new Promise((r) => setTimeout(r, 4000))
const after = bridgeCount()
console.log('bridges 4s after the app was killed:', after)

if (after > 0) {
  console.log('FAIL the bridge outlived the app and is still holding a TikTok connection')
  execSync('Stop-Process -Name livechat-bridge -Force', { shell: 'powershell.exe' })
  process.exit(1)
}
console.log('ok: no orphaned bridge')
process.exit(0)