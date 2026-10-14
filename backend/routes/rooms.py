"""Room CRUD routes.

Extracted from `main.py` so the routing surface stays a thin file. The state
these handlers reach — the source map, its lock, the default config — is bound
once at startup from `main` via `bind_state`, so this module never imports
`main` and stays independently importable.
"""
from typing import Any

from fastapi import APIRouter, HTTPException

import eventlog
import events
import store
from models import (
    ConfigUpdateRequest,
    CreateRoomRequest,
    UpdateRoomRequest,
    summary,
)

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
        raise HTTPException(status_code=404, detail="Room not found")

    # A different username means the running source is pointed at the wrong
    # room, so drop it; the room page re-requests the connection on reload.
    #
    # Removed from `sources` under the same lock the connect and stop paths use,
    # then stopped outside it. Leaving it in the dict (as this used to) kept a
    # dead entry that `/health` still counted as an active room, and the next
    # connect had to displace an object whose teardown had already run.
    if username_changed:
        async with _state["sources_lock"]:
            source = _state["sources"].pop(room_id, None)
        if source is not None:
            await source.stop()
        # The room's counters belong to the handle that just left. `stop()` does
        # not emit a status frame — it is a teardown, not a disconnect the wire
        # hears about — so `eventlog` still believes this room is connected, and
        # the next handle's `connected=True` frame then looks like a no-op to it
        # and skips its own reset. The result was the previous streamer's
        # leaderboard and diamond total showing up under the new handle.
        # Dropping the counters here is what makes the switch a new session.
        eventlog.forget(room_id)

    return {"room": summary(room_id, record)}


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
    async with _state["sources_lock"]:
        source = _state["sources"].pop(room_id, None)
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
