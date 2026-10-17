"""Persistent, read-by-link giveaway snapshots."""

import json
import os
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path
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
