#!/usr/bin/env node
/**
 * Same workload for both backends. Run with a URL that speaks the StreamKit
 * RPC contract (POST /rpc, GET /health, /ws/overlay/:room).
 *
 *   STREAMKIT_TOKEN=... node bench/bench.mjs http://127.0.0.1:8004 python results/python.json
 *
 * The script creates a throwaway room, warms up, runs three workloads and
 * deletes the room at the end. It never prints the token.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const [baseInput, label, outFile] = process.argv.slice(2)
if (!baseInput || !label || !outFile) {
  console.error('usage: bench.mjs <base-url> <label> <out.json>')
  process.exit(2)
}
const BASE = baseInput.replace(/\/+$/, '')
const TOKEN = process.env.STREAMKIT_TOKEN || ''
if (!TOKEN) {
  console.error('STREAMKIT_TOKEN is required')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] * 100) / 100
}
const stats = (samples, errors, wallMs, ops) => ({
  ops, errors, wallMs: Math.round(wallMs),
  rps: Math.round((ops / wallMs) * 1000),
  p50: pct(samples, 0.5), p95: pct(samples, 0.95), p99: pct(samples, 0.99),
})

async function rpc(path, args = {}) {
  const response = await fetch(`${BASE}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-streamkit-token': TOKEN },
    body: JSON.stringify({ path, args: { ...args, token: TOKEN } }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 120)}`)
  return text ? JSON.parse(text) : null
}

async function workload(fn, total, concurrency) {
  const samples = []
  let errors = 0
  let next = 0
  const started = performance.now()
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next++
      if (i >= total) return
      const t = performance.now()
      try {
        await fn(i)
        samples.push(performance.now() - t)
      } catch {
        errors++
      }
    }
  })
  await Promise.all(workers)
  return stats(samples, errors, performance.now() - started, total)
}

const result = { label, base: BASE, at: new Date().toISOString(), workloads: {} }

const room = await rpc('rooms:create', { name: `bench-${label}`, provider: 'tiktok' })
const roomId = room.id
console.log(`bench room ${roomId}`)

try {
  await rpc('rooms:publicList')
  for (let i = 0; i < 50; i++) await rpc('rooms:publicList')

  result.workloads.readC1 = await workload(() => rpc('rooms:publicList'), 1000, 1)
  result.workloads.readC32 = await workload(() => rpc('rooms:publicList'), 1000, 32)
  console.log('read workloads done')

  result.workloads.writeC16 = await workload(
    (i) => rpc('events:trigger', { roomId, kind: 'alert', text: `bench-${i}` }),
    500, 16,
  )
  await sleep(500)
  console.log('write workload done')

  const CLIENTS = 20
  const EVENTS = 100
  const sockets = []
  const received = new Array(CLIENTS).fill(0)
  await new Promise((resolve, reject) => {
    let open = 0
    for (let i = 0; i < CLIENTS; i++) {
      const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/overlay/${roomId}`)
      sockets.push(ws)
      ws.onmessage = (event) => {
        try {
          if (JSON.parse(event.data).type === 'alert') received[i]++
        } catch {}
      }
      ws.onopen = () => { if (++open === CLIENTS) resolve() }
      ws.onerror = (e) => reject(new Error(`ws open failed: ${e?.message || 'error'}`))
    }
    setTimeout(() => reject(new Error('ws open timeout')), 5000)
  })

  const t0 = performance.now()
  for (let i = 0; i < EVENTS; i++) {
    await rpc('events:trigger', { roomId, kind: 'alert', text: `fan-${i}` })
  }
  const deadline = t0 + 10_000
  while (performance.now() < deadline && received.some((n) => n < EVENTS)) await sleep(25)
  const fanMs = performance.now() - t0
  const delivered = received.reduce((a, b) => a + b, 0)
  result.workloads.fanout = {
    clients: CLIENTS, events: EVENTS, delivered,
    wallMs: Math.round(fanMs),
    deliveriesPerSec: Math.round((delivered / fanMs) * 1000),
    complete: received.every((n) => n >= EVENTS),
  }
  console.log('fan-out workload done')

  for (const ws of sockets) ws.close()
} finally {
  await rpc('rooms:deleteRoom', { roomId }).catch(() => {})
}

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result.workloads, null, 2))
