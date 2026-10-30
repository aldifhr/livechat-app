"""Persistent, read-by-link giveaway snapshots."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import threading
from datetime import datetime, timezone
from typing import Any

import store

_file = store.CONFIG_DIR / "giveaways.json"
_lock = threading.Lock()
_cache: dict[str, dict[str, Any]] | None = None
_MAX_SNAPSHOTS = 1000


class SnapshotCapacityError(RuntimeError):
    """The persistent snapshot store reached its configured cap."""


def _data() -> dict[str, dict[str, Any]]:
    global _cache
    if _cache is None:
        try:
            loaded = json.loads(_file.read_text(encoding="utf-8")) if _file.exists() else {}
            _cache = loaded if isinstance(loaded, dict) else {}
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            _cache = {}
    return _cache


def _flush() -> None:
    store.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    temp = _file.with_suffix(".json.tmp")
    temp.write_text(json.dumps(_data(), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(temp, _file)


def create_snapshot(report: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        data = _data()
        if len(data) >= _MAX_SNAPSHOTS:
            raise SnapshotCapacityError("The public giveaway snapshot store is full")
        snapshot_id = secrets.token_urlsafe(12)
        while snapshot_id in data:
            snapshot_id = secrets.token_urlsafe(12)
        record = {
            "id": snapshot_id,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "report": report,
        }
        data[snapshot_id] = record
        _flush()
        return record


def get_snapshot(snapshot_id: str) -> dict[str, Any] | None:
    with _lock:
        record = _data().get(snapshot_id)
        return json.loads(json.dumps(record, ensure_ascii=False)) if record else None


def delete_snapshot(snapshot_id: str) -> bool:
    """Remove one snapshot. Returns True if it existed."""
    with _lock:
        data = _data()
        if snapshot_id not in data:
            return False
        del data[snapshot_id]
        _flush()
        return True


def list_snapshots() -> list[dict[str, Any]]:
    """Every stored snapshot, newest first, without the full report body.

    The dashboard lists snapshots; the report itself is fetched by id.
    Returning it here would make every list request carry every report.
    """
    with _lock:
        items = [
            {
                "id": key,
                "createdAt": value.get("createdAt", ""),
                "report": {
                    "format": (value.get("report") or {}).get("format", ""),
                    # The report spells these `streamer` and `testMode`. Reading the old
                    # names here left the list's Stream column empty and its Test column
                    # always false, so a test run was indistinguishable from a real one.
                    "streamHandle": (value.get("report") or {}).get("streamer", ""),
                    "isTestRun": (value.get("report") or {}).get("testMode", False),
                    "entrantCount": len((value.get("report") or {}).get("entrants") or []),
                    "winnerCount": len((value.get("report") or {}).get("draws") or []),
                },
            }
            for key, value in _data().items()
        ]
    items.sort(key=lambda item: item["createdAt"], reverse=True)
    return items


# --------------------------------------------------------------------------
# async wrappers
#
# Every function above takes a `threading.Lock` and does file I/O, and the routes
# that call them are `async def`. Called directly, that work runs on the event
# loop: the whole `giveaways.json` is re-serialised on every publish — up to 1,000
# snapshots at 2 MB each — while every other coroutine in the process waits,
# including the WebSocket fan-out that keeps overlays alive. A publish would
# stall live chat for as long as it took to write the file.
#
# `store.py` solved the same problem the same way, so the convention is already
# here: a sync body under the lock, and an `_async` twin that runs it in a worker
# thread. The routes call the twins.
# --------------------------------------------------------------------------


async def create_snapshot_async(report: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(create_snapshot, report)


async def get_snapshot_async(snapshot_id: str) -> dict[str, Any] | None:
    return await asyncio.to_thread(get_snapshot, snapshot_id)


async def delete_snapshot_async(snapshot_id: str) -> bool:
    return await asyncio.to_thread(delete_snapshot, snapshot_id)


async def list_snapshots_async() -> list[dict[str, Any]]:
    return await asyncio.to_thread(list_snapshots)
