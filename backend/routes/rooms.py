"""Room CRUD routes.

Extracted from `main.py` so the routing surface stays a thin file. The state
these handlers reach — the source map, its lock, the default config — is bound
once at startup from `main` via `bind_state`, so this module never imports
`main` and stays independently importable.
"""
from typing import Any

from fastapi import APIRouter

import eventlog
import events
import store
from models import (
    ConfigUpdateRequest,
    CreateRoomRequest,
    UpdateRoomRequest,
    summary,
)
from routes.common import require_room, room_not_found, teardown_source

router = APIRouter()

#: Mutable slots filled by `bind_state` before the router is included.
_state: dict[str, Any] = {
    "sources": {},
    "sources_lock": None,
    "default_room_config": {},
}


def bind_state(sources: dict[str, Any], sources_lock: Any, default_room_config: dict[str, Any]) -> None:
    """Point this router at live process state.

    Called once from `main` before `include_router`. Handlers read `_state` on
    every request rather than capturing values at bind time, so a restart of the
    watchdog or a test that swaps the source map mid-flight is reflected.
    """
    _state["sources"] = sources
    _state["sources_lock"] = sources_lock
    _state["default_room_config"] = default_room_config


@router.get("/api/rooms")
async def list_rooms():
    rooms = await store.all_rooms_async()
    return {"rooms": [summary(oid, rec) for oid, rec in rooms.items()]}


@router.get("/api/rooms/public")
async def list_rooms_public():
    """Room list for public browser sources (OBS docks).

    Returns id, username, connected, and name — no config, no styling,
    no session data. Same shape as list_rooms minus everything sensitive.
    """
    rooms = await store.all_rooms_async()
    live = _state["sources"]
    return {
        "rooms": [
            {
                "id": oid,
                "username": rec.get("username", ""),
                "name": rec.get("name", ""),
                # Whether the room has a source and its handshake completed. The
                # stored record has no `connected` key, so reading it there
                # reported every room offline forever.
                "connected": oid in live and live[oid].is_connected(),
            }
            for oid, rec in rooms.items()
        ]
    }


@router.post("/api/rooms")
async def create_room(req: CreateRoomRequest):
    name = req.name.strip() or "Untitled"
    config = req.config if req.config is not None else dict(_state["default_room_config"])
    record = await store.create_room_async(name, config)
    return {"room": summary(record["id"], record)}


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
        username=(
            req.username.strip().lstrip("@") if req.username is not None else None
        ),
    )
    if record is None:
        raise room_not_found()

    # A different username means the running source is pointed at the wrong
    # room, so drop it; the room page re-requests the connection on reload.
    #
    # Removed from `sources` under the same lock the connect and stop paths use,
    # then stopped outside it. Leaving it in the dict (as this used to) kept a
    # dead entry that `/health` still counted as an active room, and the next
    # connect had to displace an object whose teardown had already run.
    if username_changed:
        had_source = await teardown_source(_state, room_id)
        # The room's counters belong to the handle that just left. `stop()` does
        # not emit a status frame — it is a teardown, not a disconnect the wire
        # hears about — so `eventlog` still believes this room is connected, and
        # the next handle's `connected=True` frame then looks like a no-op to it
        # and skips its own reset. The result was the previous streamer's
        # leaderboard and diamond total showing up under the new handle.
        # Dropping the counters here is what makes the switch a new session.
        eventlog.forget(room_id)
        # Tell the wire too, for the same reason as `/api/disconnect`: a client
        # watching this room — an OBS overlay, most of all — was last told the
        # previous handle was connected, and nothing else in this path produces a
        # frame. Emitted after the counters are dropped so it cannot be counted
        # against the room that is on its way out, and only when there was a
        # source to stop: renaming a room nobody is reading changed nothing, and
        # a client attaching to a source-less room is told "Offline" at attach.
        if had_source:
            await events.emit_status(
                room_id,
                connected=False,
                message="Streamer changed — reconnecting",
            )

    return {"room": summary(room_id, record)}


@router.get("/api/rooms/{room_id}")
async def get_room(room_id: str):
    return await require_room(room_id)


@router.get("/api/rooms/{room_id}/session")
async def room_session(room_id: str):
    """What this room's current session has accumulated.

    Everything `eventlog` counts — peak viewers, diamonds, the leaderboards — was
    already tracked and reachable from nowhere: the dashboard showed the live
    viewer count and nothing else, and `eventlog.snapshot` had no caller in
    production at all. This is the door to it.

    Reads the counters rather than the room record, so it answers for a room whose
    source is gone: a stream that just ended still has a session worth reading.

    Returns the empty shape for a room that has never connected rather than a 404.
    "Nothing has happened here" is an answer; the caller asking about a room it
    already listed should not have to treat it as an error.
    """
    return eventlog.snapshot(room_id)


@router.delete("/api/rooms/{room_id}")
async def delete_room(room_id: str):
    if not await store.delete_room_async(room_id):
        raise room_not_found()
    had_source = await teardown_source(_state, room_id)
    # Its counters go with it. Left behind, a deleted room would still answer a
    # leaderboard request with the viewers it used to have, which is a room
    # answering for a room that no longer exists.
    eventlog.forget(room_id)
    # And tell whoever was watching. A deleted room's clients are the ones with
    # the least chance of noticing on their own: nothing else will ever be
    # produced for this room id again, so the last frame they received stands
    # forever. Emitted after `forget`, deliberately — `is_connected` then reads
    # False and `emit_status` skips its own bookkeeping, so the frame cannot
    # bring back the counters that were just dropped.
    if had_source:
        await events.emit_status(room_id, connected=False, message="Room deleted")
    return {"status": "ok"}


@router.post("/api/rooms/{room_id}/config")
async def update_room_config(room_id: str, req: ConfigUpdateRequest):
    if not await store.set_config_async(room_id, req.config):
        raise room_not_found()
    await events.emit_config(room_id, req.config)
    return {"status": "ok"}
