"""StreamKit API — routes only.

Persistence lives in `store`, WebSocket bookkeeping in `hub`, and the shape of
everything that reaches a browser in `events`. This module is the HTTP surface
and nothing else; the split exists so that adding a widget or an event source
does not mean editing the file that owns routing.
"""

import asyncio
import json
import logging
import os
import re
import secrets
import sys
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from fastapi import APIRouter, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import eventlog
import events
import store
from watchdog import LivenessWatchdog
from events import ALERT, Event
from hub import hub
from sources import TikTokAdapter
from protocols import registry

logger = logging.getLogger("streamkit.api")

# Every style default is owned by the frontend (apps/web/lib/widgets) so the two
# can't drift apart — an earlier version mirrored the full schema here and
# silently overrode the frontend defaults with stale values. Nothing is left for
# this backend to default: a record's config is whatever the editor wrote, and an
# room nobody has edited yet has no config at all. An empty dict is therefore
# the correct default, and it is stated rather than inlined so the three places
# that need one cannot drift into disagreeing about what "no config" is.
#
# It used to hold a theme id. The theme is gone from the frontend, so the key was
# dead weight that every record carried and every summary repeated.
DEFAULT_ROOM_CONFIG: dict[str, Any] = {}

# Without this, Python's default level is WARNING and every log.info in the
# event path is discarded — the log would look like it was working while saying
# nothing. A handler is configured rather than relying on "last resort", so the
# format is ours and uvicorn's own access log is not reformatted out from under
# anyone reading `journalctl -u streamer-api`.
#
# STREAMKIT_LOG_LEVEL=NONE silences it entirely for a streamer who does not want
# a chatty journal on a busy room.
_LEVEL = os.environ.get("STREAMKIT_LOG_LEVEL", "INFO").upper()
if _LEVEL != "NONE":
    try:
        from pythonjsonlogger import jsonlogger

        _json_formatter = jsonlogger.JsonFormatter(
            "%(asctime)s %(name)s %(levelname)s %(message)s"
        )
    except ImportError:
        _json_formatter = logging.Formatter(
            "%(asctime)s %(name)s %(levelname)s %(message)s",
            datefmt="%H:%M:%S",
        )

    _handler = logging.StreamHandler(sys.stderr)
    _handler.setFormatter(_json_formatter)

    _root_logger = logging.getLogger()
    _root_logger.setLevel(getattr(logging, _LEVEL, logging.INFO))
    _root_logger.addHandler(_handler)


# --------------------------------------------------------------------------
# live connections
# --------------------------------------------------------------------------

#: room_id -> source. One live room per room, whatever asked for it.
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

    liveness.stop()


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
        try:
            await _connect_room(room_id, username)
            restored.append(f"{room_id}@{username}")
        except Exception as exc:  # noqa: BLE001 — one room must not block the rest
            logger.warning("could not restore %s (%s): %s", room_id, username, exc)
    if restored:
        logger.info("restored %d source(s) on boot: %s", len(restored), ", ".join(restored))
    return restored


app = FastAPI(title="StreamKit", lifespan=lifespan)

router = APIRouter()


# --------------------------------------------------------------------------
# authorisation
#
# A deployed API is public. Without a token anyone could delete a stream's
# rooms, rewrite its config, or post a fake 999-diamond gift that permanently
# advances the astronaut roster. Read and stream access stays open on purpose:
# the room page is loaded by OBS, which cannot send a header, and it needs the
# event stream to render at all.
# --------------------------------------------------------------------------

#: Read from the API's environment. Read per call rather than cached at import so
#: a test — and a future config reload — can change it without reimporting the
#: module.
def api_token() -> str:
    return os.environ.get("STREAMKIT_TOKEN", "").strip()


#: Set to a truthy value to run with the write gate open and no token required.
#: Development only. It exists so a fresh clone still runs with no setup, which is
#: the one case where "no token configured" should mean "no auth wanted" instead
#: of "no auth possible".
AUTH_DISABLED_ENV = "STREAMKIT_AUTH_DISABLED"

_TRUTHY = frozenset({"1", "true", "yes", "on"})


def auth_is_disabled() -> bool:
    return os.environ.get(AUTH_DISABLED_ENV, "").strip().lower() in _TRUTHY


def token_is_valid(request: Request) -> bool:
    expected = api_token()
    if not expected:
        # No token configured is *unsatisfiable*, not *open*. Returning True here
        # meant a deploy that forgot STREAMKIT_TOKEN served every write — delete a
        # room, rewrite its config, post a fake gift — to anyone who found the
        # URL, while every other layer still looked protected. An unsatisfiable
        # check and no check at all are not the same thing, and only the second
        # one was reachable.
        return auth_is_disabled()
    header = request.headers.get("x-streamkit-token", "")
    # Compared as bytes, not as str. `compare_digest` raises TypeError on a str
    # holding any non-ASCII code point, and headers arrive decoded as latin-1 —
    # so a single byte above 0x80 in the header was a 500 from inside the auth
    # check, with a stack trace in the log, on an unauthenticated request.
    return bool(header) and secrets.compare_digest(
        header.encode("utf-8", "surrogateescape"), expected.encode("utf-8")
    )


#: The write routes the desktop app needs. It sends no token: the handle is the
#: whole ask, and a token in the app binary would be extractable and would grant
#: full write access to every other route besides these two. Matched per path
#: segment rather than as a prefix: a plain
#: `startswith` also exempted anything that merely began with those characters,
#: which would arrive one refactor later with no auth and no diff on this line.
#:
#: Both are safe because neither lets the caller choose the destination beyond
#: the handle: `room-connect/{id}` reads its username from the stored room, and
#: `room-connect-by-username` creates or reuses the room for the handle given.
#:
EXEMPT_WRITE_PATHS = frozenset({
    "/api/room-connect/",
    "/api/room-connect-by-username",
})


def is_exempt_write_path(path: str) -> bool:
    for prefix in EXEMPT_WRITE_PATHS:
        if not path.startswith(prefix):
            continue
        if prefix.endswith("/"):
            # Exactly one non-empty segment: the room id, and nothing below it.
            rest = path[len(prefix):]
            if rest and "/" not in rest:
                return True
        elif path == prefix:
            return True
    return False


def warn_if_auth_unsatisfiable() -> None:
    """Say so at boot, once, in the log a deploy actually reads.

    Fail-closed plus silence looks identical to a broken client from the outside:
    every write 401s and nothing says why. The check cannot fail, so this is the
    only place the cause can come from.
    """
    if api_token():
        return
    if auth_is_disabled():
        logger.warning(
            "AUTH: %s is set and STREAMKIT_TOKEN is not — every write endpoint "
            "is open to anyone who can reach this port",
            AUTH_DISABLED_ENV,
        )
        return
    logger.warning(
        "AUTH: STREAMKIT_TOKEN is not set — every write will be refused with 401 "
        "until it is, or until %s=true for local development",
        AUTH_DISABLED_ENV,
    )


@app.middleware("http")
async def guard_mutations(request: Request, call_next):
    """Reject unauthenticated writes.

    A method check rather than a path list, so a new mutating route is protected
    the moment it is added instead of the day someone remembers to add it. The
    WebSocket path is exempt because it is not an HTTP request in the first
    place.

    /api/room-connect/{id} is exempt because the username comes from the room's
    own stored config — not from the caller — so there is nothing to forge.

    The rejection is returned rather than raised: an HTTPException thrown from
    middleware is not routed through the exception handlers, so it would surface
    as an unhandled error instead of a 401.
    """
    if request.method in ("POST", "PATCH", "PUT", "DELETE"):
        # room-connect is config-scoped (username from the stored room, never
        # from the caller) — exempt it from the token gate.
        if not is_exempt_write_path(request.url.path) and not token_is_valid(request):
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid or missing STREAMKIT_TOKEN"},
            )
    return await call_next(request)


# Registered after the guard above, so CORS ends up the *outer* layer and the
# 401 it returns carries the headers a browser needs to read it. In the other
# order the guard is outermost and its 401 crosses the wire without any CORS
# headers, which a browser reports as an opaque network failure rather than the
# 401 it is — so the real reason for the refusal never reaches the page.
app.add_middleware(
    CORSMiddleware,
    # The frontend is served from a different origin than this API, so it has to
    # be reachable cross-origin. Credentials are never used, which is what makes
    # "*" acceptable here.
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------
# request bodies
# --------------------------------------------------------------------------


class ConnectRequest(BaseModel):
    # Optional because /api/disconnect is posted with only an room id, and
    # this used to be required — which made disconnect answer 422 and left the
    # editor's Stop button silently doing nothing. /api/connect validates it.
    username: str = ""
    room_id: str | None = None


class CreateRoomRequest(BaseModel):
    name: str
#: Starting room, resolved by the caller.
    #:
    #: The frontend owns the config schema entirely — this module used to mirror
    #: a single key of it, because a second copy of the schema here is how the two
    #: drift. Accepting the whole config keeps that ownership one-directional:
    #: the backend stores what it is given and never interprets it.
    config: dict[str, Any] | None = None


class UpdateRoomRequest(BaseModel):
    name: str | None = None
    username: str | None = None


class ConnectByUsernameRequest(BaseModel):
    """A handle and the overlay styling to remember for its room.

    The styling is optional and saved into the room's config when present, so a
    bare `?room=<id>` overlay link can render as the configured overlay with
    nothing in the URL — the room carries the look, the link only names it.
    """

    # Bounded because this route is exempt from the token gate: without a cap the
    # body is read and parsed in full before the handle regex rejects it, so the
    # only limit on what an unauthenticated caller sends is the server's.
    username: str = Field(default="", max_length=64)
    # Overlay styling to store on the room. Bounded in depth and key count by the
    # extractor below; a stray blob is ignored rather than stored.
    overlay: dict[str, Any] | None = None


#: The overlay keys the app may store on a room, and nothing else. A connect body
#: is unauthenticated, so the styling it writes is whitelisted rather than taken
#: wholesale — a caller cannot use a connect to smuggle arbitrary config in.
_OVERLAY_STORE_KEYS = (
    "overlaySize",
    "overlayNameColour",
    "overlayTextColour",
    "overlayBg",
    "overlayMax",
    "overlayDelay",
    "overlayFont",
)


def _clean_overlay(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Only the known overlay keys, each coerced to the type the page expects."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key in _OVERLAY_STORE_KEYS:
        if key not in raw or raw[key] is None:
            continue
        value = raw[key]
        if key in ("overlaySize", "overlayMax", "overlayDelay"):
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)):
                out[key] = value
        elif key == "overlayBg":
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)):
                out[key] = value
        else:  # the colour and font strings
            if isinstance(value, str) and len(value) <= 200:
                out[key] = value
    return out


class ConfigUpdateRequest(BaseModel):
    config: dict[str, Any]
    room_id: str | None = None


class TriggerRequest(BaseModel):
    """Fire an event by hand — the "alert now" path with no live room involved.

    Deliberately permissive on `kind`: the set of things a streamer can trigger
    should grow without a backend release, and an unrecognised kind is surfaced
    as an alert by `events.to_wire` rather than rejected.
    """

    kind: str = ALERT
    user: str = ""
    #: Stable per-user key, for widgets that keep state per viewer. Defaults to
    #: `user` so a caller that only knows a nickname still gets a key.
    user_id: str = ""
    text: str = ""
    title: str = ""
    icon: str = "★"
    #: Gift value and repeat count. Without these a triggered gift is worth
    #: nothing, which makes the reward thresholds a widget might key on
    #: impossible to exercise from the editor.
    diamonds: int = 0
    count: int = 1


class HookRequest(BaseModel):
    """External webhook body."""

    user: str = ""
    user_id: str = ""
    text: str = ""
    title: str = ""
    icon: str = "★"
    kind: str = ALERT
    amount: float | None = None


# --------------------------------------------------------------------------
# rooms
# --------------------------------------------------------------------------


def _summary(room_id: str, record: dict[str, Any]) -> dict[str, Any]:
    config = record.get("config", {})
    return {
        "id": room_id,
        "name": record.get("name", "Untitled"),
        "username": record.get("username", ""),
        "config": config,
        "createdAt": record.get("createdAt", 0),
    }


@router.get("/api/rooms")
async def list_rooms():
    rooms = await store.all_rooms_async()
    return {"rooms": [_summary(oid, rec) for oid, rec in rooms.items()]}


@router.post("/api/rooms")
async def create_room(req: CreateRoomRequest):
    name = req.name.strip() or "Untitled"
    config = req.config if req.config is not None else dict(DEFAULT_ROOM_CONFIG)
    record = await store.create_room_async(name, config)
    return {"room": _summary(record["id"], record)}


@router.patch("/api/rooms/{room_id}")
async def update_room(room_id: str, req: UpdateRoomRequest):
    username_changed = False
    if req.username is not None:
        current = await store.username_of_async(room_id)
        incoming = req.username.strip().lstrip("@")
        username_changed = incoming != current

    record = await store.update_room_async(
        room_id,
        name=req.name.strip() if req.name is not None else None,
        username=req.username.strip().lstrip("@") if req.username is not None else None,
    )
    if record is None:
        raise HTTPException(status_code=404, detail="Room not found")

    # A different username means the running source is pointed at the wrong
    # room, so drop it; the room page re-requests the connection on reload.
    if username_changed:
        source = sources.get(room_id)
        if source is not None and source.is_running():
            await source.stop()

    return {"room": _summary(room_id, record)}


@router.get("/api/rooms/{room_id}")
async def get_room(room_id: str):
    record = await store.get_room_async(room_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return record


@router.delete("/api/rooms/{room_id}")
async def delete_room(room_id: str):
    if not await store.delete_room_async(room_id):
        raise HTTPException(status_code=404, detail="Room not found")
    async with _sources_lock:
        source = sources.pop(room_id, None)
    if source is not None:
        await source.stop()
    # Its counters go with it. Left behind, a deleted room would still answer a
    # leaderboard request with the viewers it used to have, which is a room
    # answering for a room that no longer exists.
    eventlog.forget(room_id)
    return {"status": "ok"}


@router.post("/api/rooms/{room_id}/config")
async def update_room_config(room_id: str, req: ConfigUpdateRequest):
    if not await store.set_config_async(room_id, req.config):
        raise HTTPException(status_code=404, detail="Room not found")
    await events.emit_config(room_id, req.config)
    return {"status": "ok"}


# --------------------------------------------------------------------------
# live connection
# --------------------------------------------------------------------------


@router.post("/api/room-connect/{room_id}")
async def room_connect(room_id: str):
    """Connect the room an room is already configured for, with no login.

    The desktop app connects by handle through /api/room-connect-by-username, so
    this stays for a caller that names a room it does not have a username for —
    the editor, or anything scripting against the backend. /api/connect, which
    takes the username from the request and can therefore aim the global room at
    anything, is closed to it. That left the room unable to ever reach a stream
    and showing the sample room forever.

    The difference here is that the username is not taken from the request. It is
    read from the room's own saved config, so this can only ever connect the
    room that room already names. A caller who wants a different room has to
    change the config first, which is behind the session. There is no body to
    forge and no path to hijack another room's stream.
    """
    username = (await store.username_of_async(room_id)).strip().lstrip("@")
    if not username:
        # No config to honour is a configuration error, not an auth error, and
        # saying "not signed in" would send the caller looking for a password
        # that cannot possibly help.
        raise HTTPException(
            status_code=409,
            detail="room has no username configured; set one in the editor",
        )
    return await _connect_room(room_id, username)


@router.post("/api/connect")
async def connect(req: ConnectRequest):
    room_id = req.room_id or "default"
    username = req.username.strip().lstrip("@")
    if not username:
        raise HTTPException(status_code=400, detail="username is required")
    return await _connect_room(room_id, username)


#: A TikTok handle. Deliberately narrow: letters, digits, dot and underscore, 2
#: to 24 characters, which is what the platform actually issues. This is the only
#: check standing between an unauthenticated caller and a connection attempt, so
#: it rejects anything that is not shaped like a handle — a URL, a path, a shell
#: fragment, a thousand-character string — rather than forwarding a guess to
#: TikTok and letting someone else's server find out what it does with junk.
USERNAME_RE = re.compile(r"^[A-Za-z0-9._]{2,24}$")


def _handle_is_sane(username: str) -> bool:
    """Whether the handle is not merely well-shaped but a plausible one.

    The pattern above says "no URL, no shell fragment, no thousand characters".
    It still lets `..`, `...` and `.` through, because a dot is legal in a real
    handle — `bittersweet.by` is a streamer. What it cannot tell is whether the
    string is a name or a path fragment, and a path fragment is the one shape
    worth refusing here: it is the shape a caller reaches for when probing
    something other than a handle.
    """
    if username in {".", "..", "..."}:
        return False
    return True

#: How many rooms this endpoint may bring into existence. The route is exempt
#: from the token gate, so without a ceiling anyone who found the URL could
#: slowly fill the store and open a connection per entry — bounded cost rather
#: than a data leak, but still someone else's resources to pay for. Rooms made
#: through the token-gated route are not counted, so a dashboard user is never
#: blocked by this.
AUTO_ROOM_LIMIT = 20


def normalise_username(raw: str) -> str:
    return raw.strip().lstrip("@").strip()


@router.post("/api/room-connect-by-username")
async def room_connect_by_username(req: ConnectByUsernameRequest):
    """Connect a handle, creating its room on the way. No token, no id.

    The flow the desktop app wants is one field: type a handle, watch the chat.
    Making that true needed a path that does not require a room to exist first,
    and `POST /api/rooms` is behind the write token — a token deliberately not
    shipped in the app, because one embedded in a binary is extractable and
    grants full write access to the backend.

    So this route creates the room it needs. That makes it an open proxy for
    "connect to any handle": unauthenticated callers can name a streamer and
    have the server open a connection to them. That is a cost and an IP exposure
    problem, not a data leak — the room belongs to whoever named it and no room
    can be read or pointed elsewhere through here. Three things bound it: the
    handle must be shaped like a handle, one room per handle, and the number of
    rooms this route may create is capped.

    Existing rooms are reused, so a room made in the dashboard still connects and
    keeps its config.
    """
    username = normalise_username(req.username)
    if not USERNAME_RE.fullmatch(username) or not _handle_is_sane(username):
        raise HTTPException(
            status_code=400,
            detail="username must be 2-24 characters of letters, digits, dot or underscore",
        )

    try:
        record, created = await store.find_or_create_room_for_username_async(username)
    except ValueError as exc:  # pragma: no cover — the regex above already rejected it
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Only rooms this route had to invent count against the ceiling. Counting
    # every room would let someone fill the cap with junk handles and lock a
    # real streamer out of connecting; counting every room *except* junk is the
    # same problem. The store therefore marks a room at the moment it invents one,
    # and that marker is what is counted — the previous test, "has a username but
    # no source", could never be true here, because this route connects the room
    # it just created on the very next statement. The log says when it rejects, so
    # the failure mode is visible rather than silent.
    if created:
        # Counted once. The check and the log line both used to call
        # count_auto_rooms_async, which is a second full read of the store on a
        # path an unauthenticated caller can drive — the count cannot change
        # between the two calls here, so the extra read was pure churn.
        auto = await store.count_auto_rooms_async()
        if auto > AUTO_ROOM_LIMIT:
            logger.warning(
                "room-connect-by-username: refusing to create a room for @%s — "
                "%d auto-created rooms already exist (limit %d)",
                username,
                auto,
                AUTO_ROOM_LIMIT,
            )
            await store.delete_room_async(record["id"])
            raise HTTPException(
                status_code=429,
                detail=f"too many auto-created rooms (limit {AUTO_ROOM_LIMIT}); delete some first",
            )

    room_id = record["id"]

    # Remember the overlay styling on the room, if the app sent any. Merged into
    # the existing config rather than replacing it, so a room configured elsewhere
    # keeps everything else. This is what lets the overlay link be a bare
    # `?room=<id>`: the room carries the look, the link only names it.
    #
    # Applied only when this call invented the room. This route is exempt from the
    # write token, so accepting styling for a room that already exists would let
    # anyone who knows a room id restyle someone else's overlay without a
    # credential — an unauthenticated write to a config the dashboard owns. A room
    # this call just created has no prior config to clobber, and an existing room
    # keeps the styling set where it was made.
    overlay = _clean_overlay(req.overlay)
    if created and overlay:
        existing = record.get("config") or {}
        await store.set_config_async(room_id, {**existing, **overlay})

    result = await _connect_room(room_id, username)
    return {"room_id": room_id, **result}


async def _connect_room(room_id: str, username: str) -> dict:
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
            await existing.stop()

        source = TikTokAdapter(username, room_id)
        sources[room_id] = source
        source.start_background()
        # Start observer task to consume events from adapter queue and broadcast
        asyncio.create_task(_observe_source(room_id, source))
        return {"status": "connecting", "username": username, "room_id": room_id}


async def _observe_source(room_id: str, source: TikTokAdapter) -> None:
    """Consume events from adapter and broadcast to WebSocket clients."""
    # Wait for connection before starting observer
    while source._running and not source._connected:
        await asyncio.sleep(0.1)
        if not source._running:
            return

    try:
        async for event in source.observe():
            # Route through the shared event layer rather than hand-building a
            # frame here. This used to emit {"kind", "user", "value", "meta"},
            # but the wire format every consumer reads is {"type", "text", ...}
            # (see events.to_wire): the chat overlay does `frame.type !==
            # 'comment'` and reads `frame.text`, so the hand-built frame matched
            # nothing and the overlay rendered an empty chat while the backend
            # looked perfectly healthy. events.emit also records the eventlog,
            # so the separate eventlog.record call that stood here was both
            # redundant and the only copy that ran.
            await events.emit(room_id, event)
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.error("Observer task failed for room %s: %s", room_id, e)


@router.post("/api/disconnect")
async def disconnect(req: ConnectRequest):
    room_id = req.room_id or "default"
    # Under the same lock as the connect path, so a Stop cannot land in the middle
    # of a replace and take the newly installed source down with the old one.
    async with _sources_lock:
        source = sources.pop(room_id, None)
    if source is not None:
        await source.stop()
    return {"status": "disconnected"}


@router.get("/api/rooms/{room_id}/status")
async def connection_status(room_id: str):
    source = sources.get(room_id)
    return source.status_payload() if source else {"type": "status", "connected": False, "message": "Offline"}


# --------------------------------------------------------------------------
# manual triggers and webhooks
# --------------------------------------------------------------------------


@router.post("/api/rooms/{room_id}/trigger")
async def trigger(room_id: str, req: TriggerRequest):
    """Emit an event into an room by hand.

    This is the seam that makes the room more than a chat mirror: anything
    that can POST here — a Stream Deck, a Discord bot, a cron job — appears on
    the stream without touching the backend.
    """
    if await store.get_room_async(room_id) is None:
        raise HTTPException(status_code=404, detail="Room not found")

    await events.emit(
        room_id,
        Event(
            kind=req.kind,
            user=req.user,
            user_id=req.user_id,
            value=req.text,
            meta={
                "title": req.title,
                "icon": req.icon,
                "count": req.count,
                "giftName": req.text or "Gift",
                # `diamonds` is the total for the whole send, matching what
                # sources/tiktok.py puts in `value`: one gift of five sent three
                # times is fifteen. Sending the per-unit figure here instead made
                # a triggered gift worth a third of a real one, and left the
                # frontend guessing whether to multiply — which is how a total
                # ends up counted twice.
                "diamonds": req.diamonds * req.count,
                "value": req.diamonds * req.count,
            },
        ),
    )
    return {"status": "ok", "kind": req.kind}


@router.post("/api/hooks/{room_id}")
async def webhook(room_id: str, req: HookRequest):
    """Alias for `trigger` with a flatter body, for external integrations.

    Kept separate rather than merged so the intent at the call site is
    readable, and so this path can grow its own auth later without changing
    what the dashboard's own button posts.
    """
    if await store.get_room_async(room_id) is None:
        raise HTTPException(status_code=404, detail="Room not found")

    value = req.text
    if req.amount is not None and not value:
        value = f"{req.amount:g}"

    # `amount` is forwarded, not just formatted into the text. A donation posted
    # through this hook used to arrive as the string "50000" and nothing else,
    # so a widget that counts money had nothing to count — the number was on the
    # wire as a label and nowhere as a value.
    meta: dict[str, Any] = {"title": req.title, "icon": req.icon, "count": 1}
    if req.amount is not None:
        meta["amount"] = req.amount

    await events.emit(
        room_id,
        Event(
            kind=req.kind,
            user=req.user,
            user_id=req.user_id,
            value=value,
            meta=meta,
        ),
    )
    return {"status": "ok"}





# Polls were removed with the widget. See abb2eda and the note in git log.










# --------------------------------------------------------------------------
# the stream overlay, as a page
# --------------------------------------------------------------------------
#
# The overlay used to be served by the desktop app on its own loopback port,
# which meant OBS had to run on the same machine as the app. It does not have to:
# the page is one self-contained HTML file that opens its own socket to this
# backend, so the only thing that has to be reachable is the backend itself. This
# route serves that file from the domain OBS already points at, so a browser
# source anywhere can load it.
#
# The page takes every setting from its query string, and falls back to the values
# baked into it. When the link names a room by id, this handler bakes that room's
# saved styling in — so the link can be a bare `?room=<id>` and still render as the
# configured overlay, with nothing in the URL. Nothing here is authenticated, for
# the same reason the desktop overlay needed no token: it shows one public chat,
# and the room is named in the URL by whoever is watching.


def _overlay_page(name: str = "overlay.html") -> str:
    """An overlay page's HTML, from disk.

    Read on each request rather than cached at import so editing the file takes
    effect on reload without a restart — the same reason the desktop overlay
    reads it with `include_str!` only at build. A missing file is a 500, not a
    blank page: a browser source showing nothing is indistinguishable from a
    chat that is merely quiet, which is the one failure nobody can diagnose.

    `name` picks which page: the chat overlay, or the standalone top-chatters
    board. Both live in the same directory and share the baked-config contract,
    so they go through the same reader.
    """
    path = Path(__file__).parent / "static" / name
    return path.read_text(encoding="utf-8")


#: The room-config keys that carry overlay styling, mapped to the names the page's
#: baked config uses. Only these are baked in; everything else in a room's config
#: is none of the overlay's business.
_OVERLAY_STYLE_KEYS = {
    "overlaySize": "size",
    "overlayNameColour": "nameColour",
    "overlayTextColour": "textColour",
    "overlayBg": "background",
    "overlayMax": "max",
    "overlayDelay": "delay",
    "overlayFont": "font",
}


async def _baked_config(room_id: str) -> dict[str, Any]:
    """The room's saved overlay styling, under the names the page reads.

    Empty when the room does not exist or carries no overlay settings — the page
    then uses its own defaults, exactly as it did before this existed.
    """
    try:
        record = await store.get_room_async(room_id)
    except Exception:  # noqa: BLE001 — a store hiccup must not blank the overlay
        return {}
    if not record:
        return {}
    config = record.get("config") or {}
    baked: dict[str, Any] = {}
    for room_key, page_key in _OVERLAY_STYLE_KEYS.items():
        if room_key in config and config[room_key] is not None:
            baked[page_key] = config[room_key]
    return baked


async def _render_overlay(name: str, request: Request) -> HTMLResponse:
    """An overlay page with the named room's saved styling baked in.

    Shared by the chat overlay and the top-chatters board: both take a `?room=`
    and both bake the room's config into the same `__OVERLAY_CONFIG__` slot, so
    the escaping and the room lookup live here once rather than per route.
    """
    html = _overlay_page(name)
    # Only a room id names a stored room; a handle is resolved by the page itself
    # and has no config to read here.
    room_id = request.query_params.get("room", "").strip()
    if room_id:
        baked = await _baked_config(room_id)
        if baked:
            payload = json.dumps(baked, ensure_ascii=False)
            # Same escaping the host uses: a value containing `</script>` would
            # otherwise end the element early. Room config is user-typed, and this
            # page is rendered on a stream.
            safe = (
                payload.replace("<", "\\u003c")
                .replace(">", "\\u003e")
                .replace("&", "\\u0026")
            )
            html = html.replace("__OVERLAY_CONFIG__", safe)
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@app.get("/overlay/", response_class=HTMLResponse, include_in_schema=False)
@app.get("/overlay", response_class=HTMLResponse, include_in_schema=False)
@app.get("/overlay/chat-overlay", response_class=HTMLResponse, include_in_schema=False)
@app.get("/overlay/chat-overlay/", response_class=HTMLResponse, include_in_schema=False)
async def overlay_page(request: Request) -> HTMLResponse:
    """Serve the chat overlay, baking in the named room's saved styling.

    Both with and without the trailing slash, because an OBS browser source is
    configured once by hand and a redirect on the wrong one is a source that
    loads nothing for no obvious reason.
    """
    return await _render_overlay("overlay.html", request)


@app.get("/topchatter/", response_class=HTMLResponse, include_in_schema=False)
@app.get("/topchatter", response_class=HTMLResponse, include_in_schema=False)
@app.get("/overlay/top-chatter", response_class=HTMLResponse, include_in_schema=False)
@app.get("/overlay/top-chatter/", response_class=HTMLResponse, include_in_schema=False)
async def topchatter_page(request: Request) -> HTMLResponse:
    """Serve the standalone top-chatters board — the leaderboard and nothing else.

    Its own source for OBS, so a stream can put "who is talking most" in its own
    scene rather than as a corner of the chat overlay. Same `?room=` and same
    baked styling as the chat overlay; the difference is only which page it is.

    Also served at `/overlay/top-chatter`, which is where the frontend puts it:
    one address per overlay so a customiser or a scene collection points at one
    page and not a directory. Both domains answer both spellings, so a link
    pasted from either still works.
    """
    return await _render_overlay("topchatter.html", request)


# --------------------------------------------------------------------------
# websocket
# --------------------------------------------------------------------------


@app.websocket("/ws/{client_type}/{room_id}")
async def websocket_endpoint(websocket: WebSocket, client_type: str, room_id: str):
    client_id = await hub.connect(websocket, client_type, room_id)
    try:
        record = await store.get_room_async(room_id)
        config = record.get("config", DEFAULT_ROOM_CONFIG) if record else DEFAULT_ROOM_CONFIG
        await websocket.send_text(json.dumps({"type": "config", "config": config}, ensure_ascii=False))

        # Send a status snapshot on attach. Connection-state events are edge
        # triggered, so a client opening the socket after the handshake
        # finished would otherwise sit on "connecting" forever.
        source = sources.get(room_id)
        payload = source.status_payload() if source else {"type": "status", "connected": False, "message": "Offline"}
        await websocket.send_text(json.dumps(payload, ensure_ascii=False))

        # The leaderboard, sent to this socket only — never fanned out to the room.
        # It is asked for, not pushed on a timer: a periodic room-wide broadcast
        # would interleave with the event stream every client reads frame by frame,
        # and a leaderboard is something an overlay polls when it wants the current
        # ranking, not a firehose. Recomputed here rather than kept per comment,
        # because a busy room produces comments faster than anyone reads a ranking.
        async def send_leaderboard() -> None:
            await websocket.send_text(
                json.dumps(
                    {"type": "topChatters", "chatters": eventlog.top_chatters(room_id)},
                    ensure_ascii=False,
                )
            )

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
                await send_leaderboard()
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(client_id)


app.include_router(router)


# --------------------------------------------------------------------------
# the gift sticker gallery
# --------------------------------------------------------------------------
#
# A browsable page over the downloaded gift stickers. Served as a static mount so
# the page, gifts.json and every .webp come from one directory with no per-file
# routing — the page loads gifts.json and each sticker by filename, exactly as it
# would from any static host. Mounted last so it cannot shadow an API route.

_GIFTS_DIR = Path(__file__).parent / "static" / "gifts"


# `html=True` serves index.html at /gifts/ on its own, so no separate route is
# needed — and adding one would race the mount for the same path.
app.mount("/gifts", StaticFiles(directory=str(_GIFTS_DIR), html=True), name="gifts")


# --------------------------------------------------------------------------
# health and metrics endpoints
# --------------------------------------------------------------------------
#
# These are not behind the write gate: they are read-only probes that a deploy
# needs before it can decide whether to send traffic somewhere, and they carry
# no room-identifying data, only aggregate counts that are safe by being broad.
#
# Defined above the `__main__` block rather than after it. The routes were once
# declared below it, which works — the module is imported top to bottom, so the
# decorators ran either way — but it reads as though they are part of the
# development entry point, and a reader who stops at `uvicorn.run` would not
# know they exist. Route declarations belong with the other routes.

@app.get("/health")
async def health() -> dict[str, Any]:
    """Aggregate liveness probe for the backend.

    Returns uptime, active room count, total WebSocket connections, and
    per-room provider status. Used by orchestrators and load balancers.
    """
    import time
    uptime_s = int(time.time() - getattr(app.state, "started_at", time.time()))
    room_status = {}
    for room_id, source in sources.items():
        room_status[room_id] = source.status_payload()
    return {
        "status": "ok",
        "uptimeSeconds": uptime_s,
        "activeRooms": len(sources),
        "totalConnections": len(hub.active),
        "rooms": room_status,
    }


@app.get("/metrics")
async def metrics() -> dict[str, Any]:
    """Prometheus-style metrics exposed as JSON for simple scraping."""
    return {
        "sources_active": len(sources),
        "websocket_connections": len(hub.active),
        "queued_messages_total": sum(q.qsize() for q in hub._queues.values()),
        # A real counter on the hub, incremented in `disconnect`. This used to read
        # a `_disconnection_log` attribute that was never defined, so the getattr
        # default was all it ever returned and the metric was a permanent zero.
        "clients_disconnected_total": hub.disconnected_clients_count,
    }


if __name__ == "__main__":
    # Loopback and reload. This block is the developer entry point: `uvicorn.run`
    # here is not a production server, and binding `0.0.0.0` with the reloader on
    # would put a reloading dev server on the LAN with whatever auth state the
    # environment happens to carry. A real deployment runs `uvicorn main:app`
    # behind its own process manager and its own bind address.
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
