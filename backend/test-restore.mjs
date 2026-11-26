import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8')
const checks = [
  ['connect records the user intent', "m('rooms:setDesired', { roomId, desired: true })"],
  ['disconnect clears the intent', "m('rooms:setDesired', { roomId, desired: false })"],
  ['stream end clears the intent', "m('rooms:setDesired', { roomId, desired: false }).catch(() => {})"],
  ['boot restores rooms marked desired', 'if (!room.desired || !room.username) continue'],
  ['boot calls the normal connect path', 'await connectRoom(room.id, room.username)'],
]
for (const [label, needle] of checks) {
  if (!source.includes(needle)) throw new Error(`missing: ${label}`)
  console.log(`ok  ${label}`)
}
