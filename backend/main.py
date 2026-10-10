"""StreamKit API — routes only.

Persistence lives in `store`, WebSocket bookkeeping in `hub`, and the shape of
everything that reaches a browser in `events`. This module is the HTTP surface
and nothing else; the split exists so that adding a widget or an event source
does not mean editing the file that owns routing.
"""

import json
import logging
import os
import re
import secrets
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from fastapi import APIRouter, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import events
import store
from watchdog import LivenessWatchdog
from events import ALERT, Event
from hub import hub
from sources import TikTokSource

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
    logging.basicConfig(
        level=getattr(logging, _LEVEL, logging.INFO),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )


# --------------------------------------------------------------------------
# live connections
# --------------------------------------------------------------------------

#: room_id -> source. One live room per room, whatever asked for it.
sources: dict[str, TikTokSource] = {}


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

    # Watched from a thread, because the failure it exists for is one the loop
    # cannot report: a backend that stops yielding answers nothing and writes
    # nothing, and the only evidence available is a stack taken from outside it.
    liveness.start()

    yield
    liveness.stop()
    for source in list(sources.values()):
        await source.stop()
    sources.clear()


async def restore_sources() -> list[str]:
    """Reconnect every room with a stored channel. Returns what came back."""
    restored: list[str] = []
    try:
        records = store.all_rooms()
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

app.add_middleware(
    CORSMiddleware,
    # The frontend is served from a different origin than this API, so it has to
    # be reachable cross-origin. Credentials are never used, which is what makes
    # "*" acceptable here.
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    return bool(header) and secrets.compare_digest(header, expected)


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
    """A handle and nothing else — the app's whole ask of the backend."""

    username: str = ""


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
    return {"rooms": [_summary(oid, rec) for oid, rec in store.all_rooms().items()]}


@router.post("/api/rooms")
async def create_room(req: CreateRoomRequest):
    name = req.name.strip() or "Untitled"
    config = req.config if req.config is not None else dict(DEFAULT_ROOM_CONFIG)
    record = store.create_room(name, config)
    return {"room": _summary(record["id"], record)}


@router.patch("/api/rooms/{room_id}")
async def update_room(room_id: str, req: UpdateRoomRequest):
    username_changed = False
    if req.username is not None:
        current = store.username_of(room_id)
        incoming = req.username.strip().lstrip("@")
        username_changed = incoming != current

    record = store.update_room(
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
    record = store.get_room(room_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return record


@router.delete("/api/rooms/{room_id}")
async def delete_room(room_id: str):
    if not store.delete_room(room_id):
        raise HTTPException(status_code=404, detail="Room not found")
    source = sources.pop(room_id, None)
    if source is not None:
        await source.stop()
    return {"status": "ok"}


@router.post("/api/rooms/{room_id}/config")
async def update_room_config(room_id: str, req: ConfigUpdateRequest):
    if not store.set_config(room_id, req.config):
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
    username = store.username_of(room_id).strip().lstrip("@")
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
        record, created = store.find_or_create_room_for_username(username)
    except ValueError as exc:  # pragma: no cover — the regex above already rejected it
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Only rooms this route had to invent count against the ceiling. Counting
    # every room would let someone fill the cap with junk handles and lock a
    # real streamer out of connecting; counting every room *except* junk is the
    # same problem. The count is therefore the number of rooms that have a
    # username but no source, which is what an auto-created room looks like: a
    # dashboard room either has no username yet or is being connected on
    # purpose. It is a heuristic, and the log says when it rejects, so the
    # failure mode is visible rather than silent.
    if created:
        # all_rooms() is keyed by id and returns the records themselves, so the
        # id has to come from the key rather than from the record.
        auto = sum(
            1
            for other_id, other in store.all_rooms().items()
            if str(other.get("username", "")).strip() and other_id not in sources
        )
        if auto > AUTO_ROOM_LIMIT:
            logger.warning(
                "room-connect-by-username: refusing to create a room for @%s — %d "
                "auto-created rooms already exist (limit %d)",
                username,
                auto,
                AUTO_ROOM_LIMIT,
            )
            store.delete_room(record["id"])
            raise HTTPException(
                status_code=429,
                detail=f"too many auto-created rooms (limit {AUTO_ROOM_LIMIT}); delete some first",
            )

    room_id = record["id"]
    result = await _connect_room(room_id, username)
    return {"room_id": room_id, **result}


async def _connect_room(room_id: str, username: str) -> dict:
    """Point the one global room at `username`, replacing any previous source.

    Shared by the session-gated /api/connect and the config-scoped
    /api/room-connect, so the two cannot drift apart in how they start or
    report a source.
    """
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
        await existing.stop()

    source = TikTokSource(username, room_id)
    sources[room_id] = source
    source.start_background()
    return {"status": "connecting", "username": username, "room_id": room_id}


@router.post("/api/disconnect")
async def disconnect(req: ConnectRequest):
    room_id = req.room_id or "default"
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
    if store.get_room(room_id) is None:
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
    if store.get_room(room_id) is None:
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
# websocket
# --------------------------------------------------------------------------


@app.websocket("/ws/{client_type}/{room_id}")
async def websocket_endpoint(websocket: WebSocket, client_type: str, room_id: str):
    client_id = await hub.connect(websocket, client_type, room_id)
    try:
        record = store.get_room(room_id)
        config = record.get("config", DEFAULT_ROOM_CONFIG) if record else DEFAULT_ROOM_CONFIG
        await websocket.send_text(json.dumps({"type": "config", "config": config}, ensure_ascii=False))

        # Send a status snapshot on attach. Connection-state events are edge
        # triggered, so a client opening the socket after the handshake
        # finished would otherwise sit on "connecting" forever.
        source = sources.get(room_id)
        payload = source.status_payload() if source else {"type": "status", "connected": False, "message": "Offline"}
        await websocket.send_text(json.dumps(payload, ensure_ascii=False))

        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(client_id)


app.include_router(router)


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
