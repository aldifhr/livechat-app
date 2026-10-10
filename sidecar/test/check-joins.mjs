// Checks whether join rows reach the DOM in the real app, and whether a filter
// is hiding them. Run against a launched exe.
const targets = await (await fetch('http://localhost:9222/json/list')).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
if (!page) {
  console.log('no app window on the debug endpoint')
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  socket.onopen = r
  socket.onerror = j
})
let id = 0
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
  new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    socket.send(JSON.stringify({ id: i, method, params }))
  })
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
  return r.exceptionDetails ? 'THREW ' + r.exceptionDetails.exception?.description : r.result.value
}
await send('Runtime.enable')

const username = process.argv[2] || 'mpl.id.official'

console.log('filter state before connecting')
console.log('  chips:', await ev(`JSON.stringify([...document.querySelectorAll('.toolbar-bottom .chip')].map(c=>c.textContent))`))
console.log('  active:', await ev(`document.querySelector('.chip-active')?.textContent`))

await ev(`(() => {
  const input = document.querySelector('.room-row .input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(username)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await new Promise((r) => setTimeout(r, 1500))
await ev(`document.querySelectorAll('.room-row .btn-primary')[0]?.click()`)
await new Promise((r) => setTimeout(r, 60000))

console.log('after 60s connected')
console.log('  status:', await ev(`document.querySelector('.room-row .status')?.textContent`))
console.log('  active filter:', await ev(`document.querySelector('.chip-active')?.textContent`))
console.log('  total rows:', await ev(`document.querySelectorAll('.row').length`))
console.log('  join rows:', await ev(`document.querySelectorAll('.row-aggregate').length`))
console.log('  join texts:', await ev(`JSON.stringify([...document.querySelectorAll('.row-aggregate .event-label')].map(e=>e.textContent).slice(0,10))`))
console.log('  kinds present:', await ev(`JSON.stringify([...new Set([...document.querySelectorAll('.row')].map(r=>r.className))].slice(0,12))`))

console.log('after switching the filter to Joined')
await ev(`[...document.querySelectorAll('.toolbar-bottom .chip')].find(c => c.textContent.trim().startsWith('Joined'))?.click()`)
await new Promise((r) => setTimeout(r, 800))
console.log('  active:', await ev(`document.querySelector('.chip-active')?.textContent`))
console.log('  rows:', await ev(`document.querySelectorAll('.row').length`))
console.log('  summary:', await ev(`document.querySelector('.summary')?.textContent`))

socket.close()
process.exit(0)