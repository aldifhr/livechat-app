"""Small helpers shared by the route modules.

The room-existence guard and the source-teardown sequence each appear in more
than one router. Keeping a single copy here is what stops the 404 wording and
the teardown ordering from drifting between them — the drift this replaces was
a room that read "Room not found" in one handler and something else in another.
"""
from typing import Any

from fastapi import HTTPException

import store


def room_not_found() -> HTTPException:
    """The 404 every route answers with for a room id that does not exist."""
    return HTTPException(status_code=404, detail="Room not found")


async def require_room(room_id: str) -> dict[str, Any]:
    """The room record, or a 404 by name if it does not exist."""
    record = await store.get_room_async(room_id)
    if record is None:
        raise room_not_found()
    return record


async def teardown_source(state: dict[str, Any], room_id: str) -> bool:
    """Remove and stop a room's source, if it has one.

    The source is popped under the same lock the connect path uses, then stopped
    outside it — an `await` while holding the lock would hold it across the whole
    teardown. Returns whether there was a source at all, so a caller can decide
    whether the wire also needs a status frame; the surrounding `eventlog`
    bookkeeping stays with the caller because its ordering is deliberate.
    """
    async with state["sources_lock"]:
        source = state["sources"].pop(room_id, None)
    if source is None:
        return False
    await source.stop()
    return True
