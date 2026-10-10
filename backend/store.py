"""Overlay persistence.

The original loader re-read and re-wrote the entire overlays file on every
request. That is harmless for one overlay and wrong for twenty: each request
re-parses the JSON, and two saves issued in the same tick each hold their own
copy of the file, so whichever flushed last silently discarded the other. The
file is now read once and mutated in place behind a lock, and each write is
atomic so a crash mid-save cannot leave a truncated file behind.
"""

import copy
import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OVERLAYS_FILE = CONFIG_DIR / "overlays.json"

# A plain lock, not asyncio.Lock: every critical section below is synchronous
# and contains no await, so the only thing the lock is protecting against is a
# re-entrant or cross-thread caller. asyncio.Lock would also demand `async with`.
_lock = threading.Lock()
_cache: dict[str, Any] | None = None


def _data() -> dict[str, Any]:
    global _cache
    if _cache is None:
        if OVERLAYS_FILE.exists():
            try:
                _cache = json.loads(OVERLAYS_FILE.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                # A corrupt file must not brick the API. The bad copy is set
                # aside so it can be inspected instead of silently overwritten.
                broken = OVERLAYS_FILE.with_suffix(".json.corrupt")
                os.replace(OVERLAYS_FILE, broken)
                _cache = {}
        else:
            _cache = {}
    return _cache


def _flush() -> None:
    data = _data()
    CONFIG_DIR.mkdir(exist_ok=True)
    tmp = OVERLAYS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, OVERLAYS_FILE)


def _record(overlay_id: str) -> dict[str, Any] | None:
    return _data().get(overlay_id)


def all_overlays() -> dict[str, Any]:
    """A detached copy, so a caller cannot mutate the cache by accident."""
    with _lock:
        return copy.deepcopy(_data())


def get_overlay(overlay_id: str) -> dict[str, Any] | None:
    with _lock:
        record = _record(overlay_id)
        return copy.deepcopy(record) if record else None


def create_overlay(name: str, config: dict[str, Any]) -> dict[str, Any]:
    overlay_id = str(uuid.uuid4())
    record = {
        "name": name,
        "username": "",
        "config": config,
        "createdAt": time.time(),
    }
    with _lock:
        _data()[overlay_id] = record
        _flush()
    return {"id": overlay_id, **record}


def update_overlay(
    overlay_id: str,
    *,
    name: str | None = None,
    username: str | None = None,
) -> dict[str, Any] | None:
    with _lock:
        record = _record(overlay_id)
        if record is None:
            return None
        if name is not None:
            record["name"] = name
        if username is not None:
            record["username"] = username
        _flush()
        return copy.deepcopy(record)


def delete_overlay(overlay_id: str) -> bool:
    with _lock:
        if overlay_id not in _data():
            return False
        del _data()[overlay_id]
        _flush()
        return True


def set_config(overlay_id: str, config: dict[str, Any]) -> bool:
    with _lock:
        record = _record(overlay_id)
        if record is None:
            return False
        record["config"] = config
        _flush()
        return True


def username_of(overlay_id: str) -> str:
    with _lock:
        record = _record(overlay_id)
        return str(record.get("username", "")) if record else ""
