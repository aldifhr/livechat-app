"""StreamKit API — routes only.

Persistence lives in `store`, WebSocket bookkeeping in `hub`, and the shape of
everything that reaches a browser in `events`. This module is the HTTP surface
and nothing else; the split exists so that adding a widget or an event source
does not mean editing the file that owns routing.
"""

import asyncio
import json
import os
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse



import events
import eventlog
import logbuffer
import store
import tasks
import wsguard
from watchdog import LivenessWatchdog
from hub import hub, CLIENT_TYPES as HUB_CLIENT_TYPES
from metrics import metrics as _metrics
from sources import TikTokAdapter

#: Module-level logger. Bootstrapped in `logging_setup`: one place, one handler,
#: one level. Every route module gets the same logger through it rather than
#: re-importing main and risking a setup-order cycle.
from logging_setup import logger

#: What a room's styling defaults to when nobody has set any.
#:
#: An empty dict is the correct default, and it is stated here rather than
#: inlined so the three places that need one cannot drift into disagreeing
#: about what "no config" is.
#
# It used to hold a theme id. The theme is gone from the frontend, so the key was
# dead weight that every record carried and every summary repeated.
DEFAULT_ROOM_CONFIG: dict[str, Any] = {}


# --------------------------------------------------------------------------
# live connections
# --------------------------------------------------------------------------

#: room_id -> source. One live room per room, whatever asked for it.
#: Values are TikTokAdapter, which implements EventAdapter.
sources: dict[str, TikTokAdapter] = {}

#: Serialises replacing one room's source. `_connect_room` has to `await` the old
#: source's `stop()` before it can put the new one in place, and an `await` in the
#: middle of that sequence is a hole two concurrent requests fall through: both
#: read no source, both build one, and the second assignment silently orphans the
#: first — whose task, socket and handlers then stay live for the life of the
#: process, emitting a duplicate copy of every event into the same room. The
#: route that reaches this is unauthenticated, so the race is remotely triggerable.
_sources_lock = asyncio.Lock()


#: Started once for the process. A watchdog that started per lifespan cycle would
#: leave a thread behind every reload.
liveness = LivenessWatchdog()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Before anything else that can log, so the ring catches the boot sequence —
    # which is where a misconfiguration says so, and the one part of log a
    # restarted process cannot otherwise be asked about.
    logbuffer.install()

    # And again here rather than only at import: uvicorn configures its own
    # handlers when the server starts, which is before it imports this module —
    # but a deployment that runs this app some other way (a test, a worker) may
    # not have them yet at import time. Idempotent, so the second call is free.
    wsguard.install_log_scrub()

    # Re-aim every room that was pointed at a room when the process last went
    # down.
    #
    # A restart used to leave every live stream dead until somebody noticed and
    # called the reconnect endpoint by hand. The channel is already stored per
    # room — it is what the editor writes — so nothing new is needed here, only
    # for it to be acted on at boot. A room that fails to come back is logged and
    # left alone: it must not stop the others, and it must not crash the API.
    await restore_sources()

    # Before anything else, because a deploy with no token looks exactly like a
    # deploy with a broken client from the outside: every write 401s, and nothing
    # else says why.
    warn_if_auth_unsatisfiable()

    # Track process start time for /health uptime reporting
    import time
    app.state.started_at = time.time()

    # Watched from a thread, because the failure it exists for is one the loop
    # cannot report: a backend that stops yielding answers nothing and writes
    # nothing, and the only evidence available is a stack taken from outside it.
    liveness.start()

    # The watchdog measures the loop's lag from outside it; this folds that
    # measurement into the metrics `/metrics` reads. Sampled rather than
    # per-beat because the number is for a dashboard, not for a control loop,
    # and a task that wakes five times a minute is not load.
    tasks.spawn(_sample_loop_lag(), name="loop-lag-sampler")

    yield
    # Graceful shutdown sequence:
    # 1. Stop all TikTok sources first (stop accepting new events)
    for source in list(sources.values()):
        try:
            await asyncio.wait_for(source.stop(), timeout=10)
        except asyncio.TimeoutError:
            logger.error("Source %s did not stop within 10s", getattr(source, "username", "unknown"))
        except Exception as e:
            logger.error("Error stopping source: %s", e)
    sources.clear()

    # 2. Close all WebSocket connections with normal close code 1000
    for client_id, ws in list(hub.active.items()):
        try:
            await ws.close(code=1000, reason="backend shutdown")
        except Exception:
            logger.warning("Failed to cleanly close WebSocket %s", client_id[:8])
        hub.disconnect(client_id)

    # 3. Wait for the work this process started. The sources are stopped and the
    # sockets are closed, so anything still running is an observer draining a
    # queue nobody will read — it gets cancelled and awaited rather than left to
    # finish into a process that is already on its way out.
    await tasks.shutdown()

    liveness.stop()


async def _sample_loop_lag() -> None:
    """Fold the watchdog's loop-lag measurement into `/metrics`, periodically."""
    while True:
        await asyncio.sleep(5.0)
        gap = liveness.max_gap
        if gap > _metrics.loop_lag_max:
            _metrics.loop_lag_max = gap


async def restore_sources() -> list[str]:
    """Reconnect every room with a stored channel. Returns what came back."""
    restored: list[str] = []
    try:
        records = await store.all_rooms_async()
    except Exception as exc:  # noqa: BLE001 — a bad config file must not stop the API
        logger.warning("could not read stored rooms for restore: %s", exc)
        return restored

    for room_id, record in records.items():
        username = str(record.get("username", "") or "").strip().lstrip("@")
        if not username:
            continue
        provider = str(record.get("provider", "") or "tiktok")
        try:
            await _connect_room(room_id, username, provider=provider)
            restored.append(f"{room_id}@{username}")
        except Exception as exc:  # noqa: BLE001 — one room must not block the rest
            logger.warning("could not restore %s (%s): %s", room_id, username, exc)
    if restored:
        logger.info("restored %d source(s) on boot: %s", len(restored), ", ".join(restored))
    return restored


#: Whether `/docs`, `/openapi.json` and `/redoc` answer at all.
#:
#: They used to answer to anyone, and they map every route — including the ones
#: the token protects, with their full request and response shapes. That is a
#: free reconnaissance page bolted onto a deployed API. Off unless a deploy asks
#: for it with `STREAMKIT_DOCS=true`, which is the local-development case and
#: nothing else.
_DOCS = os.environ.get("STREAMKIT_DOCS", "").strip().lower() in {"1", "true", "yes", "on"}

app = FastAPI(
    title="StreamKit",
    lifespan=lifespan,
    docs_url="/docs" if _DOCS else None,
    openapi_url="/openapi.json" if _DOCS else None,
    redoc_url="/redoc" if _DOCS else None,
)


# --------------------------------------------------------------------------
# store failures as HTTP answers
#
# The store raises two things a route should not have to translate: a write that
# did not reach disk, and a ceiling the by-username route hit. Both used to be
# raw exceptions that became a 500 with a traceback in the journal, which reads
# as a bug in the handler rather than as the disk being full.
@app.exception_handler(store.StorageError)
async def storage_error_handler(request: Request, exc: store.StorageError) -> JSONResponse:
    """503: the write did not land. The mutation is kept in memory, not rolled back.

    Keeping it is deliberate and is pinned by `tests/test_store.py`: for a store
    that rewrites one whole file, the next write that succeeds persists the
    change, so rolling back would throw a streamer's new room away to a
    transient disk error. What the caller is told is the same either way — the
    write did not land — and 503 is the honest answer to that.
    """
    return JSONResponse(status_code=503, content={"detail": "storage unavailable; change not saved"})


@app.exception_handler(store.AutoRoomQuotaError)
async def auto_room_quota_handler(request: Request, exc: store.AutoRoomQuotaError) -> JSONResponse:
    """429: the by-username route is at its ceiling on auto-created rooms.

    Logged here rather than in the route, because this is now the one place a
    refusal can happen. It used to be logged in the route that also had to undo
    the room it had just created; with the ceiling inside the store's critical
    section there is nothing to undo and one place to say so.
    """
    logger.warning("room-connect-by-username refused: %s", exc)
    return JSONResponse(status_code=429, content={"detail": str(exc)})


# --------------------------------------------------------------------------
# authorisation
#
# Auth helpers live in `routes/auth` so main.py keeps its surface area as
# routing only.
from routes.auth import (
    TOKEN_REJECTED_DETAIL,
    is_exempt_write_path,
    is_public_read_path,
    is_sensitive_read_path,
    token_is_valid,
    warn_if_auth_unsatisfiable,
)


@app.middleware("http")
async def guard_mutations(request: Request, call_next):
    """Reject unauthenticated writes, and unauthenticated reads of room data.

    A method check rather than a path list, so a new mutating route is protected
    the moment it is added instead of the day someone remembers to add it. The
    WebSocket path is exempt because it is not an HTTP request in the first
    place.

    `/api/rooms*` reads carry the same token: they answer with every streamer's
    handle and overlay config, and no working caller reads them without a
    credential (see `is_sensitive_read_path`). `/health` and `/metrics` stay open
    for an orchestrator, but `/health` withholds the per-room map from an
    unauthenticated caller.

    `/api/rooms/public` is the exception: it answers with id, handle and
    name only — no config, no styling, no session — and exists so the OBS
    docks browser source can list rooms without a credential. Same rule as
    `/api/room-connect-by-username` above: nothing there can be used to
    reach anything the token would protect.

    /api/room-connect/{id} is exempt because the username comes from the room's
    own stored config — not from the caller — so there is nothing to forge.

    The rejection is returned rather than raised: an HTTPException thrown from
    middleware is not routed through the exception handlers, so it would surface
    as an unhandled error instead of a 401.
    """
    method = request.method
    guarded = method in ("POST", "PATCH", "PUT", "DELETE") or (
        method == "GET" and is_sensitive_read_path(request.url.path)
    )
    if guarded:
        # room-connect is config-scoped (username from the stored room, never
        # from the caller) — exempt it from the token gate.
        # /api/rooms/public is a safe read (id, handle, name only) needed by
        # the OBS docks browser source.
        if not is_exempt_write_path(request.url.path) and not is_public_read_path(request.url.path) and not token_is_valid(request):
            return JSONResponse(
                status_code=401,
                content={"detail": TOKEN_REJECTED_DETAIL},
            )
    return await call_next(request)


# Registered after the guard above, so CORS ends up the *outer* layer and the
# 401 it returns carries the headers a browser needs to read it. In the other
# order the guard is outermost and its 401 crosses the wire without any CORS
# headers, which a browser reports as an opaque network failure rather than the
# 401 it is — so the real reason for the refusal never reaches the page.
#
# The list is explicit rather than "*". The only browser that talks to this API
# cross-origin is an overlay page: it is served from the frontend host and posts
# a handle to /api/room-connect-by-username to resolve it. Everything else
# reaches the backend server-side — the dashboard through its Next proxy — so
# nothing else needs a CORS grant at all.
# A wildcard would also let any page on the internet read this API's responses
# from a victim's browser, which is a permission nothing here asks for.
#
# Overridable so a deployment that moves the frontend domain does not have to
# edit code: STREAMKIT_ALLOWED_ORIGINS is a comma-separated list.
#
# Both frontend hosts are in the default because both serve overlay pages — the
# Vercel one and the VPS one. An overlay resolves its room with a cross-origin
# POST, so a host missing from this list gets a page that loads and then never
# connects, which reads as a dead overlay rather than a CORS problem.
def _allowed_origins() -> list[str]:
    raw = os.environ.get("STREAMKIT_ALLOWED_ORIGINS", "").strip()
    if raw:
        return [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
    return ["https://streamtools.aldifhr.my.id", "https://livechat.aldifhr.my.id"]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)


# Room CRUD lives in its own router, bound to live process state at startup.
from routes.rooms import bind_state, router as rooms_router  # noqa: E402

bind_state(sources, _sources_lock, DEFAULT_ROOM_CONFIG)
app.include_router(rooms_router)


# --------------------------------------------------------------------------
# live connection
# --------------------------------------------------------------------------


# Live connection routes (room-connect, connect, disconnect, status) live in
# `routes/live`. State is bound from this module so the handler layer reaches
# the real source map and hub without importing `main`.
from routes.live import (  # noqa: E402
    bind_state as bind_live_state,
)
from routes.live import router as live_router  # noqa: E402

bind_live_state(sources, _sources_lock, hub)
app.include_router(live_router)


def _make_source(provider: str, username: str, room_id: str) -> TikTokAdapter:
    """Build the adapter for the requested provider.

    TikTok takes a channel handle.

    The TikTok branch resolves the class at call time rather than closing over a
    module-level import, so a test that monkey-patches `main.TikTokAdapter` (the
    long-standing way these tests substitute a source) still takes effect.
    """
    return TikTokAdapter(username, room_id)


async def _connect_room(room_id: str, username: str, provider: str = "tiktok") -> dict:
    """Point the one global room at `username`, replacing any previous source.

    Shared by the session-gated /api/connect and the config-scoped
    /api/room-connect, so the two cannot drift apart in how they start or
    report a source.

    The whole read-stop-replace sequence is held under one lock. Every step in it
    is a decision about the same slot, and the `await` in the middle is exactly
    where two requests could otherwise both decide there was nothing there.
    """
    async with _sources_lock:
        existing = sources.get(room_id)
        if existing and existing.is_running() and existing.username == username:
            # Idempotent path. The ConnectEvent for this source already fired
            # earlier, so anyone attaching now would otherwise never learn the
            # current state — push it explicitly.
            await hub.broadcast(existing.status_payload(), room_id=room_id)
            return {
                "status": "already-connected",
                "username": existing.username,
                "room_id": room_id,
                **existing.status_payload(),
            }

        if existing:
            # Stopped before it is displaced, and awaited, so the old connection is
            # gone rather than merely forgotten. A source left running here is not
            # merely wasteful: it keeps emitting into the same room.
            await existing.disconnect()

        source = _make_source(provider, username, room_id)
        sources[room_id] = source
        source.start_background()
        # Start observer task to consume events from adapter queue and broadcast.
        # Spawned through the task registry rather than bare `create_task`: the
        # observer outlives the function that starts it and the process has to
        # be able to cancel and await it at shutdown — see `tasks`.
        tasks.spawn(_observe_source(room_id, source), name=f"observe:{room_id}")
        return {"status": "connecting", "username": username, "room_id": room_id, "provider": provider}


async def _observe_source(room_id: str, source: TikTokAdapter) -> None:
    """Consume events from adapter and broadcast to WebSocket clients.

    The observer starts immediately rather than waiting for `is_connected()`.
    That wait was written for TikTok, whose adapter only queues once its socket
    is up; a source that reconnects mid-stream has `is_connected()` False for a
    moment during the rebuild, and the wait loop then returned, leaving
    `observe()` never called and every event after it queued for a consumer that
    did not exist. The adapter already gates what it emits; the observer's only
    job is to drain.
    """
    try:
        async for event in source.observe():
            try:
                await events.emit(room_id, event)
            except Exception as e:
                logger.error("Per-event emit failed (room %s, event %r): %s", room_id, getattr(event, 'kind', '<nokind>'), e)
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.error("Observer task failed for room %s: %s", room_id, e)

# Manual triggers and webhooks live in `routes/ops` alongside health/metrics.





# Polls were removed with the widget. See abb2eda and the note in git log.










# --------------------------------------------------------------------------
# overlay styling, over the socket
# --------------------------------------------------------------------------
#
# The backend used to serve the overlay pages itself, from a second copy of each
# one in `static/`, baking the room's styling into the HTML. It does not any more.
# nginx serves those pages from disk off the dashboard host, which is the whole
# point of them living there: a browser source in OBS has to keep working while
# this service is restarting, so it cannot depend on a server rendering a page.
# And baking bought nothing — `main.py` already pushes the same styling to every
# overlay as a `config` frame the moment its socket opens, so the baked copy was
# the same data arriving twice, and only on the address nobody's link pointed at.
#
# What is left is the one job that genuinely needs this side: translating the
# store's namespaced keys into the names a page reads. `page_config` moved to
# `models.py`, beside `OVERLAY_STORE_KEYS`, which is the same vocabulary in the
# other direction.
from models import page_config


# --------------------------------------------------------------------------
# websocket
# --------------------------------------------------------------------------


@app.websocket("/ws/{client_type}/{room_id}")
async def websocket_endpoint(websocket: WebSocket, client_type: str, room_id: str):
    # client_type is a path param with no validation — it was never checked
    # against the known types. A typo or a malicious value silently created
    # a client that broadcasts could not route to. Reject unknown types
    # before accepting the socket.
    #
    # Checked against `hub.CLIENT_TYPES`, which is all three of them. The list
    # used to name only `room` and `customizer`, and `overlay` — the type every
    # OBS browser source and every inline dashboard preview connects as, since the
    # pages hardcode `/ws/overlay/` — was not in it. So this check refused every
    # real overlay in the product while the suite stayed green: not one test
    # connected as anything but `room`.
    if client_type not in HUB_CLIENT_TYPES:
        await websocket.close(code=1008, reason="unknown client type")
        return
    # Admission policy, before a slot is reserved. A handshake that is going to
    # be refused should not cost a queue, a writer task or a place in the caps,
    # and the reason it was refused is written here rather than discovered from
    # a 1013 that means something else. See `wsguard` for the model: a
    # room-scoped token when one is presented, the room id as the capability
    # when none is, and Origin as defence in depth when it is switched on.
    refusal = wsguard.authorize(websocket, room_id, _allowed_origins())
    if refusal is not None:
        _metrics.ws_refuse(refusal.replace(" ", "_"))
        await websocket.close(code=1008, reason=refusal)
        return
    client_id = await hub.connect(websocket, client_type, room_id)
    # A cap was reached. `hub.connect` has already closed the socket, and returns an
    # empty id rather than raising, precisely so that walking into a limit is not an
    # error worth a traceback.
    if not client_id:
        return
    try:
        record = await store.get_room_async(room_id)
        config = record.get("config", DEFAULT_ROOM_CONFIG) if record else DEFAULT_ROOM_CONFIG
        # Under the names the page reads, same as every other frame carrying styling.
        # Sent raw, this was `overlaySize` where the page looks for `size` — an
        # overlay attaching to a styled room came up on its defaults and stayed
        # there, so the link and what OBS showed could disagree.
        await websocket.send_text(
            json.dumps({"type": "config", "config": page_config(config)}, ensure_ascii=False)
        )

        # Send a status snapshot on attach. Connection-state events are edge
        # triggered, so a client opening the socket after the handshake
        # finished would otherwise sit on "connecting" forever.
        source = sources.get(room_id)
        payload = source.status_payload() if source else events.offline_status()
        # Read through the adapter's own accessors, not its private flags. The
        # class forbids reaching past itself for exactly this: a caller that
        # reads _running directly can desynchronise the task it does not know
        # about. is_running() and is_connected() are the public surface.
        await websocket.send_text(json.dumps(payload, ensure_ascii=False))

        # Only now start draining this client's queue. Both frames above are the
        # ones the page needs *first* — the config it styles itself from and the
        # state it opens on — and they are written straight to the socket rather
        # than queued, so a writer already running could deliver an event ahead of
        # them. An overlay attaching to a styled room then came up on its defaults
        # and stayed there. Events broadcast during these two sends are queued, not
        # lost, and are delivered in order behind them.
        hub.prime(client_id)

        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except (json.JSONDecodeError, RecursionError):
                # Deeply nested input raises RecursionError, not a decode error, and it
                # is the same answer: not a message this protocol has.
                continue
            # Valid JSON is not necessarily a message. `null`, `123`, `"x"` and `[1,2]`
            # all decode fine and none of them has `.get`, so the call below raised
            # AttributeError and took the handler down with a traceback. This socket is
            # unauthenticated, so the literal text `null` was enough.
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
            elif msg.get("type") == "topChatters":
                # Asked for, answered to this socket only. The board polls on its
                # own beat; broadcasting a new ranking on every comment would put
                # a ten-row list on the same wire as the chat for every client.
                await websocket.send_text(
                    json.dumps(
                        {"type": "topChatters", "chatters": eventlog.top_chatters(room_id)},
                        ensure_ascii=False,
                    )
                )
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(client_id)


# Health, metrics, the manual trigger/webhook routes, and the static gift-sticker gallery now live in
# `routes/ops`. State is bound from this module so the ops handlers reach the
# live source map and hub without importing `main`.
from routes.ops import bind_state, router as ops_router, mount_gifts  # noqa: E402

bind_state(
    sources=sources,
    hub=hub,
    token_is_valid=token_is_valid,
    default_room_config=DEFAULT_ROOM_CONFIG,
)
app.include_router(ops_router)

# Public giveaway snapshots are created through the token-holding web app and
# read later by an unguessable link. The global mutation guard protects POST.
from routes.giveaways import router as giveaways_router  # noqa: E402

app.include_router(giveaways_router)
mount_gifts(app, str(Path(__file__).parent / "static"))


if __name__ == "__main__":
    # Loopback and reload. This block is the developer entry point: `uvicorn.run`
    # here is not a production server, and binding `0.0.0.0` with the reloader on
    # would put a reloading dev server on the LAN with whatever auth state the
    # environment happens to carry. A real deployment runs `uvicorn main:app`
    # behind its own process manager and its own bind address.
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
