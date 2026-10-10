/**
 * The log channel.
 *
 * Diagnostics go to stderr and frames to stdout, because the host reads every
 * stdout line as a frame — a stray log line there is a malformed frame. These
 * tests assert the two never mix, because that separation is what makes the
 * in-app log trustworthy rather than noise.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BRIDGE = fileURLToPath(new URL('index.mjs', import.meta.url))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Runs the bridge and collects stdout and stderr separately. */
function run(username, waitMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    child.stdout.on('data', (c) => out.push(c.toString()))
    child.stderr.on('data', (c) => err.push(c.toString()))
    child.stdin.write(JSON.stringify({ cmd: 'connect', username }) + '\n')
    setTimeout(() => {
      child.kill()
      resolve({ out: out.join(''), err: err.join('') })
    }, waitMs)
  })
}

const offline = await run('bellapoarch', 9000)

console.log('stream separation')
check('stdout carries only JSON frames', offline.out.trim().split('\n').every((l) => {
  try {
    JSON.parse(l)
    return true
  } catch {
    return false
  }
}), offline.out)
check('no log lines leak into stdout', !/INFO|ERROR|WARN/.test(offline.out), offline.out)
check('stderr carries log lines', offline.err.trim().length > 0, offline.err)
check('the bridge announced itself on start', /bridge started/.test(offline.err), offline.err)
check('stderr lines start with a timestamp', offline.err.trim().split('\n').every((l) => /^\d{4}-\d{2}-\d{2}T/.test(l)), offline.err)

console.log(`\n${failures === 0 ? 'all passed' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)