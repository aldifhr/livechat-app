// When the host process dies, its pipe to the bridge closes. The bridge must
// exit on that rather than sitting there holding a TikTok connection open with
// nobody reading it — a force-killed app otherwise leaves an orphan behind.
import { spawn } from 'node:child_process'

const exe = process.argv[2] || 'livechat-bridge.exe'
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] })
let frames = 0
child.stdout.on('data', (chunk) => {
  frames += chunk.toString().split('\n').filter(Boolean).length
})

child.stdin.write(JSON.stringify({ cmd: 'connect', username: process.argv[3] }) + '\n')

await new Promise((r) => setTimeout(r, 8000))

// Closing stdin is what the host's death does to this pipe.
child.stdin.end()

// `exitCode` rather than the event: once the process has exited the event has
// already fired, so a listener attached afterwards would never run and the
// timeout would report a dead process as alive.
await new Promise((r) => setTimeout(r, 2500))

console.log('frames received:', frames)
console.log('exit code after stdin close:', child.exitCode)

if (child.exitCode === null) {
  console.log('FAIL: the bridge holds a connection open with no host')
  child.kill()
  process.exit(1)
}
console.log('ok: the bridge exits when its host goes away')
process.exit(0)