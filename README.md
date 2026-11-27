# StreamKit

Live chat overlays for streaming, plus a dashboard for building and running them.

Two parts, each building from its own directory. **The repo root has no
manifest** — `npm install` at the root does nothing, and that is deliberate.

| Part | What it is | Stack |
|---|---|---|
| `api_rs/` | Backend: Postgres state, TikTok watcher, overlay sockets | Rust + Axum + PostgreSQL |
| `web/` | Dashboard: stream list, per-stream pages, overlay builder | Next.js 16 + React 19 |

## Layout

```
.
├── api_rs/           The only backend. See "Backend" below.
├── backend/          Retired Node bridge (reference only).
├── web/              Next.js dashboard.
├── shared/           Cross-app TypeScript contracts: overlay, events,
│                    platforms. Imported via the `@shared` alias.
├── deploy/           systemd units + nginx config
└── scripts/          deploy-web.sh, backup-rooms.sh
```

## Backend (StreamKit)

One Rust process owns everything: rooms, events, sessions and logs live in
PostgreSQL; the same process holds the TikTok socket and the overlay WebSocket
fan-out. Convex and the Node bridge are gone; the historical benchmark result
from the earlier Python implementation is kept in `bench/results/` only as
evidence of the migration decision.

| Part | What it is | Stack |
|---|---|---|
| `api_rs/src/main.rs` | RPC, control endpoints, WS fan-out, TikTok watcher | Axum + tokio-postgres + piratetok-live-rs |
| `bench/` | Workload + comparison + smoke check | Node |

The Next.js gateway still speaks the old function names (`rooms:list`,
`events:recentForRoom`, ...) through `POST /rpc`, so no client helper had to be
rewritten. Room IDs were kept during migration, so existing OBS links still
work.

```
api_rs/
├── src/main.rs    everything: RPC dispatch, watcher, sockets, SQL
└── Cargo.toml
bench/
├── bench.mjs      workload against the running backend
├── compare.mjs    turns two results into a comparison table
├── smoke-connect.mjs  verifies a handle connect really stores a room
└── contract-check.mjs  checks every gateway route + WS frame shape
```

### Running it

`streamkit-rust.service` runs the release binary on `127.0.0.1:8004` with
`/etc/streamkit/backend.env` (database URL + API token). nginx on
`kit-backend.aldifhr.my.id` routes `/`, `/ws/` and `/api/room-connect*` to it.
The dashboard sets `STREAMKIT_API_URL` (defaults to `http://127.0.0.1:8004`).

```bash
cd api_rs
cargo test --release
cargo build --release

cd ../bench
STREAMKIT_TOKEN=... node bench.mjs http://127.0.0.1:8004 rust results/rust.json
node compare.mjs   # needs results/python.json and results/rust.json
STREAMKIT_SESSION=... node contract-check.mjs http://127.0.0.1:5184
```

### API

The dashboard calls `/api/backend/...` on the Next server, which forwards
everything to the Rust backend through `POST /rpc`, including the TikTok
connect/disconnect paths. The session gate in `web/src/proxy.ts` is the browser
auth; the Rust service additionally requires `STREAMKIT_TOKEN` on all
privileged calls.

| Method | Endpoint | Notes |
|---|---|---|
| `GET` | `/api/rooms`, `/api/rooms/public` | List rooms |
| `POST` | `/api/rooms` | Create room |
| `PATCH`/`DELETE` | `/api/rooms/{id}` | Update / delete room |
| `POST` | `/api/rooms/{id}/config` | Save overlay config |
| `GET` | `/api/rooms/{id}/status`, `/session` | Connection status, session stats |
| `POST` | `/api/room-connect-by-username`, `/room-connect/{id}`, `/connect`, `/disconnect` | TikTok watcher |
| `POST` | `/api/rooms/{id}/trigger`, `/api/hooks/{id}` | Manual trigger / webhook |
| `GET` | `/api/health`, `/api/metrics`, `/api/analytics`, `/api/logs` | Ops |
| `WS` | `/ws/{overlay\|room\|customizer}/{id}` | Event stream (Rust backend) |

### Env

| Name | Meaning |
|---|---|
| `CONVEX_URL` | Convex deployment URL (server-side, e.g. `http://127.0.0.1:3210`) |
| `CONVEX_ADMIN_KEY` | Convex admin key (server-side, bridge + web) |
| `NEXT_PUBLIC_CONVEX_URL` | Public Convex URL for browsers (`https://kit-backend.aldifhr.my.id`) |
| `BRIDGE_URL` | Backend URL used by the Next gateway (default `http://127.0.0.1:8004`) |
| `SIGN_API_KEY` | Euler Stream sign-server key for TikTok connections |
| `BACKEND_ORIGIN` | Public host browsers reach the backend at |

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
cd web && npm test   # credentials, session, style-store, room-live, proxy-allowlist, event/overlay contracts
```

The cursor pagination check needs a live Convex deployment, so it is a
separate script rather than part of `npm test`:

```bash
cd web
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 STREAMKIT_TOKEN=... \
  node scripts/test-cursor-pagination.mjs
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

All server-side, except the public Convex URL the browser socket needs. Copy the
root `.env.example` to `.env` (or set the same names in your process manager), or
run `npm run secrets` to generate the two secrets and write them for you. The
VPS runs the web service from systemd with `/etc/streamkit/env` as its
`EnvironmentFile`; that file is the authoritative one in production.

| Name | Meaning |
|---|---|
| `BACKEND_ORIGIN` | Browser-facing Convex origin, baked into overlay pages. |
| `STREAMKIT_TOKEN` | Backend token, attached server-side. Empty shows a "no API token" banner. |
| `STREAMKIT_DASHBOARD_PASSWORD_HASH` | The dashboard password as a bcrypt hash. **Empty = nobody can sign in.** The change-password page rewrites this line in place. |
| `STREAMKIT_DASHBOARD_USER` | Account name, used to label the session. Default `admin`. |
| `STREAMKIT_SESSION_SECRET` | Session signing key. **Empty = no session can be issued or accepted.** |
| `STREAMKIT_SESSION_DAYS` | Session lifetime. Default 7. A non-positive value falls back to 7, not to forever. |
| `STREAMKIT_ENV_FILE` | Where the change-password route writes the new hash. Default `.env` beside the server. |
| `STREAMKIT_DATA_DIR` | Where runtime state lives. Default `.data` beside the server. |
| `STREAMKIT_TTS_LANG` | Google TTS language for docks. Default `id`. |
| `BRIDGE_URL` / `CONVEX_URL` | Loopback origins for the Node bridge and self-hosted Convex. |
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

The overlay pages are served by Next (`/overlay/[name]`), which bakes the
public origin into the page; styling itself arrives over the socket as a
`config` frame, translated by `pageConfig()` in `backend/frames.js` — the one
place that knows the stored names and the page names.

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
scripts/backup-rooms.sh  # daily Convex export, 14-day prune
```

| Unit | Role |
|---|---|
| `convex-local.service` | Convex self-hosted backend, port 3210 |
| `tiktok-bridge.service` | Node TikTok bridge + WS fan-out, port 8003 |
| `streamtools-web.service` | Next dashboard from `.next/standalone` |
| `streamkit-rooms-backup.service`/`.timer` | Daily Convex export backup |

nginx holds back part of the surface: `/ws/` and `= /api/room-connect-by-username`
are proxied to the backend **outside the gate**, because OBS cannot carry a
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
