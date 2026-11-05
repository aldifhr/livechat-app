#!/usr/bin/env node
/*
 * Legacy data importer for the Convex cutover.
 *
 * Usage:
 *   1. Export existing rooms from the old FastAPI service (historical):
 *      curl -H "x-streamkit-token: $STREAMKIT_TOKEN" "$BACKEND/api/rooms"
 *        | jq -c '.rooms[]' > rooms.jsonl
 *   2. Import into Convex:
 *      npx convex import --table rooms rooms.jsonl
 *
 * Run this against /var/lib/streamkit/rooms.json to produce
 * web/scripts/rooms.convex.jsonl, then:
 *
 *   npx convex import --table rooms scripts/rooms.convex.jsonl
 *
 * Event and metrics tables should be treated as ephemeral live state: only
 * the room catalogue and giveaway snapshots need a durable migration.
 */
import { readFileSync, writeFileSync } from 'node:fs'
const input = process.argv[2] || 'rooms.jsonl'
const output = process.argv[3] || 'rooms.convex.jsonl'
const rows = readFileSync(input, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const converted = rows.map(room => ({
  name: room.name || room.username || 'Untitled',
  username: room.username || '',
  provider: room.provider || 'tiktok',
  config: room.config || {},
  createdAt: room.createdAt ? Math.round(Number(room.createdAt) * 1000) : Date.now(),
  connected: false,
}))
writeFileSync(output, converted.map(row => JSON.stringify(row)).join('\n') + '\n')
console.log(`Wrote ${converted.length} room rows to ${output}`)
