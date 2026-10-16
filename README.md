# StreamKit

Live chat overlays for streaming, plus a desktop app for watching the chat.

Three parts, each building from its own directory. **The repo root has no
manifest** — `npm install` at the root does nothing, and that is deliberate.

| Part | What it is | Stack |
|---|---|---|
| `backend/` | Live chat API + serves the overlay pages | FastAPI + TikTokLive |
| `web/` | Dashboard: stream list, overlay builder, preview | Next.js 16 + React 19 |
| `app/` | Desktop viewer for the operator | Tauri + React |

> **No TikTok process on the user's PC.** The desktop app reads the backend in
> this repo over `WS /ws/room/{id}` and translates its frames into the shape the
> UI expects. If the backend is down the app cannot read chat — that is a choice,
> so run the backend.

## Layout

```
.
├── backend/          FastAPI. See "Backend" below.
├── web/              Next.js dashboard.
├── app/              Tauri desktop app.
│   ├── src/          React (Vite)
│   ├── src-tauri/    Rust host: WebSocket client, frame mapper, tray, TTS
│   ├── test/         13 `.mjs` suites (own runner, not Vitest/Jest)
│   └── scripts/      Python diagnostics (WS frame dump, viewer probe)
├── shared/overlay.ts The overlay styling contract. Single source, imported
│                    by app (via the `@shared` alias) and web.
├── deploy/           systemd units + nginx config
├── scripts/          deploy-web.sh, backup-rooms.sh
└── docs/             Design specs
```

## Backend (StreamKit)

FastAPI + TikTokLive for live chat rooms. Real-time WebSocket, token auth,
multi-room. It serves its own overlay pages so it can stand alone without `web/`.

```
backend/
├── main.py           app object, lifespan, middleware, /ws, connect/trigger/hooks
├── models.py         pydantic request models + styling keys
├── store.py          rooms.json — atomic + lock
├── hub.py            WebSocket hub
├── events.py         Event type, to_wire, emit_config
├── eventlog.py       Counters & leaderboard, per-room
├── protocols.py      Protocol registry
├── watchdog.py       Liveness watchdog
├── logging_setup.py  The one logger
├── routes/
│   ├── auth.py       Token gate + exemptions
│   ├── rooms.py      Room CRUD + config
│   ├── overlay.py    Overlay pages, config baked into the HTML
│   └── ops.py        /health, /metrics, /gifts
├── sources/          TikTokLive adapter
├── static/           overlay.html, topchatter.html, gifts/
├── config/           Runtime state (git-ignored)
└── tests/            17 suites
```

### Running it

`main.py` does flat imports (`import store`, `from sources import …`), so it has
to run with `backend/` as the working directory:

```bash
python3.12 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cd backend && .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### Testing

No pytest. `run_all.py` runs each `test_*.py` as a subprocess with its own
temporary config dir per suite.

```bash
python backend/tests/run_all.py
```

### Diagnostics

Not tests — utilities that deliberately live outside `tests/` so they are not
counted as suites.

```bash
python app/scripts/dump_ws_frames.py
python app/scripts/measure_broadcast.py
python app/scripts/probe_live_viewers.py
python app/scripts/validate_live_city.py
```

### API

Every write needs the `X-StreamKit-Token` header. So does `GET /api/rooms*` — it
hands back every streamer's handle and overlay config to anyone who finds the
host. `/health`, `/metrics`, the overlay pages, and the WebSocket stay open.

| Method | Endpoint | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/rooms` | token | List rooms |
| `POST` | `/api/rooms` | token | Create room (needs `name`) |
| `GET` | `/api/rooms/{id}` | token | One room's record |
| `PATCH` | `/api/rooms/{id}` | token | Change `name` / `username` |
| `DELETE` | `/api/rooms/{id}` | token | Delete room |
| `POST` | `/api/rooms/{id}/config` | token | Save config (replaces, does not merge) |
| `GET` | `/api/rooms/{id}/status` | token | Connection status |
| `POST` | `/api/connect` | token | Connect to a room |
| `POST` | `/api/room-connect/{id}` | **exempt** | Username from the room's stored config |
| `POST` | `/api/room-connect-by-username` | **exempt** | Room created on demand from a handle |
| `POST` | `/api/disconnect` | token | Disconnect |
| `POST` | `/api/rooms/{id}/trigger` | token | Manual trigger (test gift) |
| `POST` | `/api/hooks/{id}` | token | Webhook for outside integrations |
| `GET` | `/health` | — | Status + uptime. Per-room map only for token holders |
| `GET` | `/metrics` | — | Runtime counters |
| `GET` | `/overlay`, `/overlay/chat-overlay` | — | Chat overlay page |
| `GET` | `/topchatter`, `/overlay/top-chatter` | — | Leaderboard overlay page |
| `GET` | `/gifts` | — | Gift sticker gallery |
| `WS` | `/ws/{client_type}/{id}` | — | Event stream |

`client_type` is `room` (desktop app) or `overlay` (HTML pages). A socket that
just attached receives a `{"type":"config"}` frame before the status snapshot.

### Auth

The token goes **only** in the `X-StreamKit-Token` header and must match
`STREAMKIT_TOKEN`. `?token=` in a query string was removed: a query string lands
in access logs, `Referer`, and browser history, so a token that travels there is
a token that leaks everywhere. If a client cannot send a header, that is a
reason to use an exempt route, not a reason to add a second path.

**The gate fails closed.** If `STREAMKIT_TOKEN` is unset, every write is refused
with 401 — not opened up. This differs from the earlier version that accepted
every write when the env was empty, which turned a deploy that lost its env file
into an open API while every other layer still looked protected. Opt into dev
mode explicitly with `STREAMKIT_AUTH_DISABLED=true`, and the backend warns at
boot that all writes are open.

The gate decides **by method**, not from a path list: a new mutating route is
protected from the moment it is added, rather than from the day someone remembers
to add it. `GET /api/rooms*` is gated too because it leaks the list of handles
and overlay configs, and no working caller reads it without a credential.

Two exempt writes:

- `POST /api/room-connect/{id}` — the username is read from the room's stored
  config, not from the caller, so there is nothing to forge.
- `POST /api/room-connect-by-username` — a handle is the only thing asked for.
  This route creates the room if it does not exist, which is what `AUTO_ROOM_LIMIT`
  bounds (20 auto-created rooms by default) so an unauthenticated caller cannot
  exhaust resources.

Both are matched per path segment, not `startswith`, so a route with a longer
name (`/api/room-connect-admin`) does not inherit the exemption.

### Env (backend)

| Name | Meaning |
|---|---|
| `STREAMKIT_TOKEN` | The write token. Empty = every write 401s. |
| `STREAMKIT_AUTH_DISABLED` | `true` disables auth. Development only. |
| `STREAMKIT_CONFIG_DIR` | Where `rooms.json` lives. Default `backend/config`. Created automatically. |
| `STREAMKIT_LOG_LEVEL` | Root log level. Default `INFO`. |
| `STREAMKIT_ALLOWED_ORIGINS` | CORS allow-list, comma-separated. Defaults to the dashboard origin only. |

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
cd web && npm test   # 3 suites: htpasswd, session, style-store
```

### Pages

| Route | What it is |
|---|---|
| `/` | Landing page, public |
| `/login` | Sign in |
| `/admin` | **Streams** — one card per stream, each with both overlay links and Copy buttons |
| `/admin/overlay` | Overlay builder, with a live inline preview beside the controls. `?room=` |
| `/admin/about` | Service addresses + password change |

The dashboard has its own gate (`src/proxy.ts`) mirroring the nginx one, so a
lost session gets a login page instead of a console whose API calls all 401.
Sessions are signed with a key derived from both the session secret and the
htpasswd hash, so changing the password signs everyone out.

The Next server forwards only the backend paths it is allowed to, attaching the
token to `POST`/`PATCH`/`DELETE` and to `GET /api/rooms*`. Everything else 404s on
the web side — it does not become an open proxy.

### Env (web)

All server-side. There are no `NEXT_PUBLIC_*` variables.

| Name | Meaning |
|---|---|
| `BACKEND_URL` | Backend origin the server proxies to. |
| `OVERLAY_ORIGIN` | Where overlay pages are served from. Defaults to `BACKEND_URL`. |
| `STREAMKIT_TOKEN` | Backend token, attached server-side. Empty shows a "no API token" banner. |
| `STREAMKIT_HTPASSWD` | Path to the htpasswd file. |
| `STREAMKIT_DASHBOARD_USER` | Account name inside that file. Default `admin`. |
| `STREAMKIT_SESSION_SECRET` | Session signing key. **Empty = no session can be issued or accepted.** |
| `STREAMKIT_SESSION_DAYS` | Session lifetime. Default 7. A non-positive value falls back to 7, not to forever. |
| `PRODUCT_NAME` | Wordmark. Default `StreamKit`. |
| `TAGLINE` | Default `Live chat overlays for streaming.` |

## Desktop app

```bash
cd app
npm install
npm run tauri:dev      # development
npm run tauri:build    # installer
```

### Tests

```bash
cd app && npm test              # typecheck + 11 suite scripts (15 .mjs files)
cd app/src-tauri && cargo test  # 48 tests: frame mapper, TTS, sound
```

No test framework — plain `.mjs` with a `check()` helper, exiting non-zero on
failure. `test-ui.mjs` runs the real React components in jsdom with the Tauri
transport faked.

`test:wire` is the contract between the Rust host (`to_app_event`) and the
TypeScript app (the `SidecarEvent` union). The two are joined by anything except
one file: the first writes plain JSON, the second claims its shape with a cast.
That suite reads both files and compares them.

### Voice

Speech is opt-in, and every setting that reaches it is — the text is sent to a
voice service to be spoken, which is the price of a neural voice that does not
sound like a screen reader.

| Setting | What it does |
|---|---|
| Read chat aloud | Speaks every incoming message |
| Say gifts | Announces each gift with the same voice |
| Say mentions | Speaks the sender when a message names you |
| Language | The only thing on this service that picks a voice |
| Reading pace | Slow / Normal / Fast |
| Volume | 0–100%, applied to the audio locally |
| ▶ Test the voice | Speaks a sample in the chosen language, and says whether it worked |

Language, pace and volume are one block shown while any of the three toggles is
on, because they are the same mouth. Chat, gifts and mentions cannot be given
different voices — they are one `Audio` element, and two would talk over each
other.

The engine is Google's translate read-aloud endpoint: no key, no account, and one
voice per language. A `voice=` parameter sent to it is ignored and returns
byte-identical audio, so there is no voice picker to offer and pitch and random
voice are not reachable without a different engine. The Tester exists mostly
because of that: it is the only way to check a setting before a live starts
rather than during one.

## Overlay

Two pages, each with **two byte-identical copies**:

- `backend/static/overlay.html` ≡ `web/public/overlay/chat-overlay.html`
- `backend/static/topchatter.html` ≡ `web/public/overlay/top-chatter.html`

Not by accident. nginx serves both from disk (`/var/www/streamtools`) so OBS
keeps working while the dashboard is restarting — and on that path
`__OVERLAY_CONFIG__` is **not** substituted, so all styling arrives via the query
string and the live `config` frame. The backend serves the same files with the
config already baked into the HTML, as a second surface that stands alone.

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
| `streamkit-rooms-backup.service`/`.timer` | Daily room store backup |

nginx holds back part of the surface: `/ws/` and `= /api/room-connect-by-username`
are proxied to the backend **outside the gate**, because OBS cannot carry a
credential and the overlay pages do not need one. The rest of `/api/` and the
pages are gated by `auth_request` to `/api/auth/verify`; `/login` is open and
rate-limited. Overlays are served from disk and never touch the dashboard.

Both services run as `streamkit`, not root. The repo's code stays owned by root
and read-only; the only things `chown`ed to `streamkit` are the two that genuinely
have to be written — the password file and the room store. The env files are
`0640 root:streamkit`: root still owns them, but the service can read them.

## References

- [CHANGELOG.md](CHANGELOG.md) — what changed and why.
- [`docs/superpowers/specs/2026-10-14-streamkit-console-redesign-design.md`](docs/superpowers/specs/2026-10-14-streamkit-console-redesign-design.md)
  — the console redesign spec: why styling moved into the room config, and those
  four key vocabularies.
