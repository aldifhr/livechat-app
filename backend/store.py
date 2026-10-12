"""Room persistence.

The original loader re-read and re-wrote the entire rooms file on every
request. That is harmless for one room and wrong for twenty: each request
re-parses the JSON, and two saves issued in the same tick each hold their own
copy of the file, so whichever flushed last silently discarded the other. The
file is now read once and mutated in place behind a lock, and each write is
atomic so a crash mid-save cannot leave a truncated file behind.
"""

import asyncio
import copy
import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent
# Where rooms.json lives. `STREAMKIT_CONFIG_DIR` moves it, which is what a deploy
# pointing at a persistent volume needs: with the directory inside the source
# tree, a rebuild throws every room away. Read at import, so it is set once by the
# process rather than changing under a cached store.
CONFIG_DIR = Path(os.environ.get("STREAMKIT_CONFIG_DIR") or (BASE_DIR / "config"))
ROOMS_FILE = CONFIG_DIR / "rooms.json"

# A plain lock, not asyncio.Lock: every critical section below is synchronous
# and contains no await, so the only thing the lock is protecting against is a
# re-entrant or cross-thread caller. asyncio.Lock would also demand `async with`.
_lock = threading.Lock()
_cache: dict[str, Any] | None = None


def _data() -> dict[str, Any]:
    global _cache
    if _cache is None:
        if ROOMS_FILE.exists():
            try:
                _cache = json.loads(ROOMS_FILE.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                # A corrupt file must not brick the API. The bad copy is set
                # aside so it can be inspected instead of silently overwritten.
                broken = ROOMS_FILE.with_suffix(".json.corrupt")
                os.replace(ROOMS_FILE, broken)
                _cache = {}
            except (OSError, UnicodeDecodeError) as exc:
                # A file that cannot be *read* — permissions, a bad sector, a
                # half-written file that is not even valid UTF-8 — is the same
                # situation as a corrupt one from the caller's side, because every
                # route touches the store. Not caught here, one unreadable file
                # takes the whole API down with a 500.
                logger.warning("could not read %s (%s); starting empty", ROOMS_FILE, exc)
                _cache = {}
        else:
            _cache = {}
    return _cache


def _flush() -> None:
    data = _data()
    # `parents=True` because STREAMKIT_CONFIG_DIR is a path a deploy chose, and
    # `exist_ok=True` alone only creates the last component. A setting of
    # `/var/lib/myapp/streamkit/config` on a volume that is mounted empty failed
    # the first write with FileNotFoundError, which surfaced as a 500 on the
    # request that created the room rather than as a configuration problem.
    # The default, `backend/config`, already exists, so this changes nothing for
    # a checkout and only rescues the deploy that set the variable.
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = ROOMS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, ROOMS_FILE)


def _record(room_id: str) -> dict[str, Any] | None:
    return _data().get(room_id)


def all_rooms() -> dict[str, Any]:
    """A detached copy, so a caller cannot mutate the cache by accident."""
    with _lock:
        return copy.deepcopy(_data())


def get_room(room_id: str) -> dict[str, Any] | None:
    with _lock:
        record = _record(room_id)
        return copy.deepcopy(record) if record else None


def create_room(name: str, config: dict[str, Any]) -> dict[str, Any]:
    room_id = str(uuid.uuid4())
    record = {
        "name": name,
        "username": "",
        "config": config,
        "createdAt": time.time(),
    }
    with _lock:
        _data()[room_id] = record
        _flush()
    return {"id": room_id, **record}


def update_room(
    room_id: str,
    *,
    name: str | None = None,
    username: str | None = None,
) -> dict[str, Any] | None:
    with _lock:
        record = _record(room_id)
        if record is None:
            return None
        if name is not None:
            record["name"] = name
        if username is not None:
            record["username"] = username
        _flush()
        return copy.deepcopy(record)


def delete_room(room_id: str) -> bool:
    with _lock:
        if room_id not in _data():
            return False
        del _data()[room_id]
        _flush()
        return True


def set_config(room_id: str, config: dict[str, Any]) -> bool:
    with _lock:
        record = _record(room_id)
        if record is None:
            return False
        record["config"] = config
        _flush()
        return True


def username_of(room_id: str) -> str:
    with _lock:
        record = _record(room_id)
        return str(record.get("username", "")) if record else ""


def find_room_by_username(username: str) -> dict[str, Any] | None:
    """The room already configured for this handle, case-insensitively.

    A name is not an identity: `Bittersweet`, `bittersweet` and `@bittersweet`
    are one streamer, and three rooms claiming to be the same one would each
    open their own connection to the same room. Matching is done on the
    normalised handle rather than on the stored string so a room saved by hand
    as `@bittersweet` is found by a request for `bittersweet`.
    """
    wanted = username.strip().lstrip("@").casefold()
    if not wanted:
        return None
    with _lock:
        for room_id, record in _data().items():
            stored = str(record.get("username", "")).strip().lstrip("@").casefold()
            if stored == wanted:
                return {"id": room_id, **copy.deepcopy(record)}
    return None


def find_or_create_room_for_username(username: str, config: dict[str, Any] | None = None) -> tuple[dict[str, Any], bool]:
    """The room for this handle, created if there is none. One room per handle.

    The lookup and the insert share one critical section on purpose. Doing them
    separately meant two requests arriving together for a handle nobody had
    asked for both saw "not found" and both inserted, leaving two rooms on one
    streamer — and two TikTok connections to the same live, which is the exact
    thing this function exists to make impossible.

    Returns the record and whether this call is what brought it into existence.
    The flag is the only way the caller can tell a room it just invented from one
    that was already there, which matters because the ceiling below counts only
    the invented ones.
    """
    wanted = username.strip().lstrip("@").casefold()
    if not wanted:
        raise ValueError("username is required")
    with _lock:
        data = _data()
        for room_id, record in data.items():
            stored = str(record.get("username", "")).strip().lstrip("@").casefold()
            if stored == wanted:
                return {"id": room_id, **copy.deepcopy(record)}, False
        room_id = str(uuid.uuid4())
        record = {
            "name": username.strip().lstrip("@"),
            "username": username.strip().lstrip("@"),
            "config": config or {},
            "createdAt": time.time(),
            # Marked at birth, because "did this route invent it?" is the only
            # question the ceiling needs answered. It used to be inferred from the
            # room holding a username but no live source, which is unreachable in
            # practice: the route that creates a room connects it on the next
            # statement, so the room is never source-less by the time anyone
            # counts. The cap therefore never fired.
            "autoCreated": True,
        }
        data[room_id] = record
        _flush()
        return {"id": room_id, **copy.deepcopy(record)}, True


def count_auto_rooms() -> int:
    """How many rooms the by-username route has invented.

    Counted from the marker written at creation rather than from the absence of a
    source, because a source is present for as long as anyone is watching and
    gone once the stream ends — so a source-based count would also forget rooms
    whose stream had stopped, and let the cap refill without bound.
    """
    with _lock:
        return sum(1 for record in _data().values() if record.get("autoCreated"))


# --------------------------------------------------------------------------
# async wrappers
# --------------------------------------------------------------------------
#
# Everything above is synchronous, and a `write_text` of the whole store plus an
# `os.replace` is exactly the kind of blocking call that stalls an event loop —
# every other coroutine, including the websocket fan-out, waits for it. These
# wrappers hand the work to a thread so the loop keeps running. The lock is a
# threading lock precisely so this is safe: the work still happens under it, just
# not on the loop's thread.
#
# The synchronous versions stay for the callers that are not on the loop (the
# tests, and the restore path at startup).

async def all_rooms_async() -> dict[str, Any]:
    return await asyncio.to_thread(all_rooms)


async def get_room_async(room_id: str) -> dict[str, Any] | None:
    return await asyncio.to_thread(get_room, room_id)


async def create_room_async(name: str, config: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(create_room, name, config)


async def update_room_async(
    room_id: str,
    *,
    name: str | None = None,
    username: str | None = None,
) -> dict[str, Any] | None:
    return await asyncio.to_thread(update_room, room_id, name=name, username=username)


async def delete_room_async(room_id: str) -> bool:
    return await asyncio.to_thread(delete_room, room_id)


async def set_config_async(room_id: str, config: dict[str, Any]) -> bool:
    return await asyncio.to_thread(set_config, room_id, config)


async def username_of_async(room_id: str) -> str:
    return await asyncio.to_thread(username_of, room_id)


async def find_or_create_room_for_username_async(
    username: str, config: dict[str, Any] | None = None
) -> tuple[dict[str, Any], bool]:
    return await asyncio.to_thread(find_or_create_room_for_username, username, config)


async def count_auto_rooms_async() -> int:
    return await asyncio.to_thread(count_auto_rooms)
