# StreamKit

Live chat overlays for streaming, plus a dashboard for building and running them.

Two parts, each building from its own directory. **The repo root has no
manifest** — `npm install` at the root does nothing, and that is deliberate.

| Part | What it is | Stack |
|---|---|---|
| `web/convex/` + `backend/` | Backend: Convex state + TikTok bridge | Convex (self-hosted) + Node |
| `web/` | Dashboard: stream list, per-stream pages, overlay builder, giveaway runner | Next.js 16 + React 19 |

## Layout

```
.
├── web/convex/       Convex backend. See "Backend" below.
├── backend/          Node TikTok bridge.
├── web/              Next.js dashboard.
├── shared/           Cross-app TypeScript contracts: overlay, events,
│                    platforms. Imported via the `@shared` alias.
├── deploy/           systemd units + nginx config
└── scripts/          deploy-web.sh, backup-rooms.sh
```

## Backend (StreamKit)

Convex (self-hosted) + a small Node TikTok bridge. The old FastAPI backend
(`api/`) is gone.

| Part | What it is | Stack |
|---|---|---|
| `web/convex/` | Rooms, events, sessions, giveaways, logs | Convex functions (self-hosted) |
| `backend/` | TikTok LIVE socket + overlay WebSocket fan-out | Node + tiktok-live-connector + ws |

Convex Functions cannot hold a long-lived socket, so the bridge exists only to
open the TikTok connection and push every event into Convex mutations
(`events:appendEvent`). Overlay WebSockets are served by the bridge, which polls
Convex for new events and fans them out. All state lives in Convex.

```
web/convex/
├── schema.ts       rooms, events, roomSessions, giveawaySnapshots, logs, metrics
├── rooms.ts        CRUD, status, session, analytics
├── events.ts       appendEvent, trigger, topChatters, health, logs
└── giveaways.ts    snapshot save/get/list/delete (16-char public ids)
backend/
├── server.js       HTTP connect/disconnect + /ws fan-out + TikTok wiring
└── frames.js       TikTok event -> overlay wire frame (the format in shared/events.ts)
```

### Running it

Convex self-hosted runs as `convex-local.service`
(`/opt/convex/convex-local-backend`, data `/var/lib/convex`, env
`/etc/convex/env`, port 3210). The bridge runs as `tiktok-bridge.service`
(port 8003). nginx on `kit-backend.aldifhr.my.id` routes `/` to Convex and
`/ws/` + `/api/room-connect*` to the bridge.

```bash
cd web && npx convex deploy   # needs CONVEX_SELF_HOSTED_URL + CONVEX_SELF_HOSTED_ADMIN_KEY
cd backend && npm install && npm start
```

### API

The dashboard calls `/api/backend/...` on the Next server, which forwards
everything to Convex except the TikTok connect/disconnect paths, which go to
the bridge. The session gate in `web/src/proxy.ts` is the auth; there is no
backend token any more.

| Method | Endpoint | Notes |
|---|---|---|
| `GET` | `/api/rooms`, `/api/rooms/public` | List rooms |
| `POST` | `/api/rooms` | Create room |
| `PATCH`/`DELETE` | `/api/rooms/{id}` | Update / delete room |
| `POST` | `/api/rooms/{id}/config` | Save overlay config |
| `GET` | `/api/rooms/{id}/status`, `/session` | Connection status, session stats |
| `GET` | `/api/giveaways/snapshots`, `/{id}` | Snapshot list / one report (public by id) |
| `POST` | `/api/giveaways/snapshots` | Publish a report (validated by the dashboard route) |
| `DELETE` | `/api/giveaways/snapshots/{id}` | Unpublish |
| `POST` | `/api/room-connect-by-username`, `/room-connect/{id}`, `/connect`, `/disconnect` | TikTok bridge |
| `POST` | `/api/rooms/{id}/trigger`, `/api/hooks/{id}` | Manual trigger / webhook |
| `GET` | `/api/health`, `/api/metrics`, `/api/analytics`, `/api/logs` | Ops |
| `WS` | `/ws/{overlay\|room\|customizer}/{id}` | Event stream (bridge, events from Convex) |

### Env

| Name | Meaning |
|---|---|
| `CONVEX_URL` | Convex deployment URL (server-side, e.g. `http://127.0.0.1:3210`) |
| `CONVEX_ADMIN_KEY` | Convex admin key (server-side, bridge + web) |
| `NEXT_PUBLIC_CONVEX_URL` | Public Convex URL for browsers (`https://kit-backend.aldifhr.my.id`) |
| `BRIDGE_URL` | TikTok bridge URL (default `http://127.0.0.1:8003`) |
| `SIGN_API_KEY` | Euler Stream sign-server key for TikTok connections |
| `BACKEND_ORIGIN` | Public host browsers reach the bridge at |

## Dashboard (web/)

Next.js 16. This is where an operator builds and saves overlay styling, then
copies the link into OBS. It imports `@shared/overlay` — the same style contract
the app uses, not a copy of it.

```bash
cd web
npm install
npm run dev          # :5184
npm run build && npm start
```

### Testing

```bash
cd web && npm test   # 5 suites: credentials, session, style-store, room-live, proxy-allowlist
```

### Pages

| Route | What it is |
|---|---|
| `/` | Landing page, public |
| `/login` | Sign in |
| `/admin` | Redirects to `/admin/dashboard` |
| `/admin/dashboard` | Overview — viewers, state and a live chart across every stream |
| `/admin/streams` | Every stream as one row: handle, state, viewer count |
| `/admin/streams/@handle` | One stream — its OBS links, its name and handle, styling entry point |
| `/admin/overlay` | Overlay builder, with a live inline preview beside the controls. `?room=` |
| `/admin/logs` | Backend log ring, filterable, with Pause |
| `/admin/about` | Service addresses + password change |

A stream's page is addressed by its handle rather than its room id, because that is
the part a person says out loud — and it is re-addressed by a redirect when the
handle is changed from that page. The room id is accepted too, so a link built
before a stream had a handle does not dead-end.

The dashboard has its own gate (`src/proxy.ts`) mirroring the nginx one, so a
lost session gets a login page instead of a console whose API calls all 401.
Sessions are signed with a key derived from both the session secret and the
password hash in force, so changing the password signs everyone out.

The Next server forwards only the backend paths it is allowed to, attaching the
token to `POST`/`PATCH`/`DELETE` and to `GET /api/rooms*`. Everything else 404s on
the web side — it does not become an open proxy.

### Env (web)

All server-side. There are no `NEXT_PUBLIC_*` variables. Copy `.env.example` to
`.env`, or run `npm run secrets` to generate the two secrets and write them for
you.

| Name | Meaning |
|---|---|
| `BACKEND_URL` | Backend origin the server proxies to. |
| `STREAMKIT_TOKEN` | Backend token, attached server-side. Empty shows a "no API token" banner. |
| `STREAMKIT_DASHBOARD_PASSWORD_HASH` | The dashboard password as a bcrypt hash. **Empty = nobody can sign in.** The change-password page rewrites this line in place. |
| `STREAMKIT_DASHBOARD_USER` | Account name, used to label the session. Default `admin`. |
| `STREAMKIT_SESSION_SECRET` | Session signing key. **Empty = no session can be issued or accepted.** |
| `STREAMKIT_SESSION_DAYS` | Session lifetime. Default 7. A non-positive value falls back to 7, not to forever. |
| `STREAMKIT_ENV_FILE` | Where the change-password route writes the new hash. Default `.env` beside the server. |
| `STREAMKIT_DATA_DIR` | Where runtime state (giveaway commitments) lives. Default `.data` beside the server. |
| `PRODUCT_NAME` | Wordmark. Default `StreamKit`. |
| `TAGLINE` | Default `Live chat overlays for streaming.` |

## Overlay

Four pages, one copy of each, all in `web/public/overlay/`:

- `chat-overlay.html`
- `top-chatter.html`
- `cat-overlay.html`
- `like-target.html`

nginx serves them from disk (`/var/www/streamtools`), deliberately bypassing the
app: OBS loads them as a browser source, where a framework runtime is dead
weight, and they have to keep working while the dashboard is restarting. On that
path `__OVERLAY_CONFIG__` is **not** substituted, so all styling arrives over the
socket the page already opens, as a `config` frame.

There used to be a second copy of each page in `api/static/`, kept by hand,
which the backend served with the room's styling baked into the HTML. It was
not worth having: a browser source cannot depend on a server rendering a page
for it, the styling it baked was already arriving over the socket, and the two
copies drifted — the chat pair was nineteen lines apart before this was removed,
with the overlay page test reading the stale twin and failing on a feature that
had already shipped. `api/routes/overlay.py` went with it; `page_config()`
lives in `api/models.py` now, because the socket is the only thing left that
needs it.

`shared/overlay.ts` is the single source for styling: defaults, numeric bounds,
and key translation. There are **four different key vocabularies** here and not
one of them matches — store `overlaySize`/`overlayBg`, link `size`/`bg`,
`resolveStyle()` `size`/`nameColour`, page `size`/`background`.
`styleFromStored()` is the one place that crosses all four.

Styling lives in the room config, not in the link. A link names only the room;
the overlay is told about restyles over the socket it already has open, so the
link is pasted into OBS once and no later restyle touches it. **Precedence
consequence: the saved config beats the query string** — an old link carrying
stale styling will follow the room config once the room has been saved.

## Deploy

One VPS behind nginx.

```bash
scripts/deploy-web.sh    # build web, stage overlays to /var/www, restart, then assert
scripts/backup-rooms.sh  # daily rooms.json copy, 14-day prune
```

| Unit | Role |
|---|---|
| `streamer-api.service` | Backend, loopback only, `User=streamkit` |
| `streamtools-web.service` | Next dashboard from `.next/standalone` |
| `streamkit-rooms-backup.service`/`.timer` | Daily room and giveaway snapshot backup |

nginx holds back part of the surface: `/ws/` and `= /api/room-connect-by-username`
are proxied to the backend **outside the gate**, because OBS cannot carry a
credential and the overlay pages do not need one. Public giveaway snapshot pages
and their validated upload endpoint are also open so viewers can read shared
reports and the dashboard can publish them. Other `/api/` routes and dashboard
pages are gated by `auth_request` to `/api/auth/verify`; `/login` is open and
rate-limited. Overlays are served from disk and never touch the dashboard.

Both services run as `streamkit`, not root. The repo's code stays owned by root
and read-only; the only things `chown`ed to `streamkit` are the two that genuinely
have to be written — the web env file (the change-password route rewrites the hash
line in it) and the room store. The backend's env file is `0640 root:streamkit`:
root still owns it, but the service can read it.

## References

- [CHANGELOG.md](CHANGELOG.md) — what changed and why.
