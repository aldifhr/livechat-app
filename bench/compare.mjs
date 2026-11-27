import { readFileSync, writeFileSync } from 'node:fs'

const load = (name) => JSON.parse(readFileSync(new URL(`./results/${name}.json`, import.meta.url), 'utf8'))
const py = load('python').workloads
const rs = load('rust').workloads

const rows = [
  ['read c=1 (RPS)', 'readC1', 'rps'],
  ['read c=1 p50 (ms)', 'readC1', 'p50'],
  ['read c=32 (RPS)', 'readC32', 'rps'],
  ['read c=32 p95 (ms)', 'readC32', 'p95'],
  ['write c=16 (RPS)', 'writeC16', 'rps'],
  ['write c=16 p50 (ms)', 'writeC16', 'p50'],
  ['fan-out deliveries/s', 'fanout', 'deliveriesPerSec'],
]

const out = []
for (const [label, workload, field] of rows) {
  const a = py[workload][field]
  const b = rs[workload][field]
  const lowerIsBetter = field.includes('p50') || field.includes('p95')
  const delta = lowerIsBetter ? (a - b) / a : (b - a) / a
  out.push({ metric: label, python: a, rust: b, changePct: Math.round(delta * 1000) / 10 })
  console.log(`${label.padEnd(24)} python=${String(a).padStart(8)} rust=${String(b).padStart(8)} ${lowerIsBetter ? 'lower' : 'higher'} ${Math.abs(Math.round(delta * 1000) / 10)}%`)
}

writeFileSync(new URL('./results/comparison.json', import.meta.url), JSON.stringify({ rows: out }, null, 2) + '\n')
