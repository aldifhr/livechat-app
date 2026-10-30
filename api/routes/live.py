"""Live connection routes: room-connect, connect, disconnect, connect-by-username.

Extracted from `main.py`. Only the route handlers and their pure helpers live
here; the shared `_connect_room` and `_observe_source` stay in `main` because
`lifespan.restore_sources` and the test suite both reach for
`main._connect_room` directly. The handlers below reach it through a **lazy
import** — `from main import _connect_room` inside each handler body — so this
module never imports `main` at load time and there's no circular dependency.

State (sources, lock, hub) is bound once at startup.
"""
import re
from typing import Any

from fastapi import APIRouter, HTTPException

import events
import store
from models import ConnectByUsernameRequest, ConnectRequest, clean_overlay as _clean_overlay
from routes.common import teardown_source

router = APIRouter()

#: A TikTok handle. Narrow on purpose: letters, digits, dot, underscore, 2-24
#: chars — what the platform actually issues. This is the only check between an
#: unauthenticated caller and a connection attempt.
USERNAME_RE = re.compile(r"^[A-Za-z0-9._]{2,24}$")

#: How many rooms this endpoint may bring into existence. The route is exempt
#: from the token gate, so without a ceiling anyone who found the URL could
#: slowly fill the store and open a connection per entry — bounded cost rather
#: than a data leak, but still someone else's resources to pay for.
AUTO_ROOM_LIMIT = 20

#: Live process state, injected from `main` at registration.
_state: dict[str, Any] = {
    "sources": {},
    "sources_lock": None,
    "hub": None,
}


def bind_state(sources: dict[str, Any], sources_lock: Any, hub: Any) -> None:
    """Point the live-connection handlers at real process state."""
    _state["sources"] = sources
    _state["sources_lock"] = sources_lock
    _state["hub"] = hub


def handle_is_sane(username: str) -> bool:
    """Whether the handle is well-shaped but also not a path probe.

    `.` is legal in a real handle (`bittersweet.by`), so the regex lets it
    through — but `..`, `...`, and `.` alone are the shape a caller reaches for
    when probing something other than a real handle, and there's no reason a
    streamer named only `.` exists.
    """
    if username in {".", "..", "..."}:
        return False
    return True


def normalise_username(raw: str) -> str:
    return raw.strip().lstrip("@").strip()


@router.post("/api/room-connect/{room_id}")
async def room_connect(room_id: str):
    """Connect the room an room is already configured for, with no login.

    An overlay page connects by handle through /api/room-connect-by-username, so
    this stays for a caller that names a room it does not have a username for —
    the editor, or anything scripting against the backend. /api/connect, which
    takes the username from the request and can therefore aim the global room
    at anything, is closed to it.
    """
    from main import _connect_room  # lazy — avoids circular import

    username = (await store.username_of_async(room_id)).strip().lstrip("@")
    if not username:
        raise HTTPException(
            status_code=409,
            detail="room has no username configured; set one in the editor",
        )
    provider = (await store.provider_of_async(room_id)) or "tiktok"
    return await _connect_room(room_id, username, provider=provider)


@router.post("/api/connect")
async def connect(req: ConnectRequest):
    from main import _connect_room  # lazy — avoids circular import

    room_id = req.room_id or "default"
    username = req.username.strip().lstrip("@")
    if not username:
        raise HTTPException(status_code=400, detail="username is required")
    return await _connect_room(room_id, username, provider=req.provider)


@router.post("/api/room-connect-by-username")
async def room_connect_by_username(req: ConnectByUsernameRequest):
    """Connect a handle, creating its room on the way. No token, no id.

    The route is exempt from the token gate, so the handle is validated before
    it touches the store: the regex rejects anything that's not 2-24 chars of
    [A-Za-z0-9._], and `handle_is_sane` turns away path-fragment shapes (`.`/`..`)
    that pass the regex but are never real streamers.
    """
    from main import _connect_room  # lazy — avoids circular import

    username = normalise_username(req.username)
    if not USERNAME_RE.fullmatch(username) or not handle_is_sane(username):
        raise HTTPException(
            status_code=400,
            detail="username must be 2-24 characters of letters, digits, dot or underscore",
        )

    record, created = await store.find_or_create_room_for_username_async(
        username, limit=AUTO_ROOM_LIMIT
    )
    # The ceiling is enforced inside the store's critical section, so a request
    # past it raises before a room exists — there is nothing to roll back and no
    # second write to undo. It used to be checked here, after the room was
    # already created and flushed, which meant the count and the insert were
    # separate steps (so concurrent requests all passed the same count) and a
    # refusal cost a create, a flush and a delete.

    room_id = record["id"]

    # Remember overlay styling and provider on a room this route just invented.
    # Existing rooms keep their prior config — this route is unauthenticated, so
    # restyling someone else's room by id would be an unauthenticated write.
    overlay = _clean_overlay(req.overlay) if req.overlay else {}
    if created:
        existing = record.get("config") or {}
        await store.set_config_async(room_id, {**existing, **overlay})
        # `provider` belongs on the record, not in `config`: it is what
        # `summary()` reports and what the startup restore reads to rebuild the
        # right adapter. Writing it into `config` left every room reporting
        # `provider: tiktok` regardless of what it connected over, because
        # nothing reads it back out of there.
        await store.update_room_async(room_id, provider=req.provider)

    result = await _connect_room(room_id, username, provider=req.provider)
    return {"room_id": room_id, **result}


@router.post("/api/disconnect")
async def disconnect(req: ConnectRequest):
    room_id = req.room_id or "default"
    # Under the same lock as the connect path (in `_connect_room`), so a Stop
    # cannot land in the middle of a replace and take the newly installed source
    # down with the old one.
    # Say so on the wire. `stop()` is a teardown and emits nothing — it is
    # not the adapter's `disconnect()`, which is a lost socket the run loop
    # means to retry — so every client already attached to this room kept the
    # last status it was handed: "Connected", over a stream that has ended.
    # An OBS overlay is the one that matters, because it is attached for the
    # whole stream and has no way to ask again.
    #
    # Sent after the stop rather than before, so the frame cannot overtake the
    # teardown and describe a connection that is still up. Guarded on there
    # having been a source at all: with nothing to stop, nothing changed, and
    # a client attaching to a source-less room is told "Offline" at attach.
    if await teardown_source(_state, room_id):
        await events.emit_status(room_id, connected=False, message="Disconnected")
    return {"status": "disconnected"}


@router.get("/api/rooms/{room_id}/status")
async def connection_status(room_id: str):
    source = _state["sources"].get(room_id)
    return source.status_payload() if source else events.offline_status()
