"""A ring buffer of the backend's own log records, for the dashboard to read.

The backend logs to stderr and the journal keeps it, but the dashboard is a
separate service and has no business shelling out to `journalctl` — it runs as its
own user, on its own host if a deployment splits them, and a page that reads the
journal is a page that reads everything else in it too. So the process keeps the
last few hundred records itself and serves them.

A ring, not a file: this is for "what just happened", the minutes around an error,
and a file would need rotation, a size cap and a cleanup story to answer the same
question. The journal remains the archive; this is the window.

Attached as a logging handler rather than written by each module, so every line
the backend already produces is captured — including the ones from libraries that
know nothing about this module. A handler that missed a logger would show a log
page with holes in it, which is worse than no log page.
"""

from __future__ import annotations

import logging
import threading
from collections import deque
from datetime import datetime, timezone
from typing import Any

#: How many records are kept. A busy backend produces a few thousand lines a day,
#: so this is the last few hours — long enough to cover "something went wrong a
#: while ago" and short enough to stay a few hundred kilobytes.
CAPACITY = 1000

#: The levels worth keeping out of the ring, when asked. `debug` is excluded by
#: default because a run at DEBUG would fill the ring with library chatter and push
#: out the errors it exists to show.
_LEVELS = ("debug", "info", "warning", "error", "critical")

_records: deque[dict[str, Any]] = deque(maxlen=CAPACITY)
#: Guards the ring. `logging` handlers can be called from any thread — the
#: watchdog is one — and a deque append is atomic but a read-while-append is not.
_lock = threading.Lock()


class RingHandler(logging.Handler):
    """Keeps the last `CAPACITY` records in memory."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            entry = {
                "at": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
                # Seconds since start, which is what an operator compares against
                # the uptime on the dashboard when the clock is not in question.
                "level": record.levelname.lower(),
                # The logger's own name, so "which part said this" survives. Trimmed
                # of the common prefix because `streamkit.tiktok` and
                # `streamkit.api` are the same sentence with a different tail.
                "source": record.name.removeprefix("streamkit."),
                "message": record.getMessage(),
            }
            # The traceback, when there is one. `exc_info` is the tuple the logging
            # call was given; formatting it here is the only way the page can show
            # why something failed rather than only that it did.
            if record.exc_info:
                entry["traceback"] = logging.Formatter().formatException(record.exc_info)
            with _lock:
                _records.append(entry)
        except Exception:  # noqa: BLE001
            # A logging handler that raises takes the caller down with it, and the
            # caller is often already handling a failure. Swallowing is the only
            # safe answer here — this is diagnostics, not the work.
            pass


def install() -> None:
    """Attach the ring to the root logger. Idempotent.

    On the root logger rather than on `streamkit.api`, so lines from uvicorn,
    httpx and TikTokLive land in the same place. The page exists to answer "what is
    happening", and the answer is not only what our own modules said.
    """
    root = logging.getLogger()
    if any(isinstance(handler, RingHandler) for handler in root.handlers):
        return
    root.addHandler(RingHandler())


def read(limit: int = 200, min_level: str = "info", search: str = "") -> dict[str, Any]:
    """The most recent records, newest first.

    `min_level` is inclusive: `warning` returns warnings, errors and criticals.
    An unknown level is treated as `info` rather than raising, because the page
    should answer a mistyped filter with the default view rather than a 500.
    """
    try:
        floor = _LEVELS.index(min_level.lower())
    except ValueError:
        floor = _LEVELS.index("info")
    needle = search.strip().lower()

    with _lock:
        snapshot = list(_records)

    kept = [
        entry
        for entry in snapshot
        if _LEVELS.index(entry["level"]) >= floor
        and (not needle or needle in entry["message"].lower() or needle in entry["source"].lower())
    ]
    # Newest first, and the newest are the ones kept when the limit bites: a log
    # page is read from the bottom of the interesting thing upwards.
    kept.reverse()
    return {
        "entries": kept[: max(1, min(limit, CAPACITY))],
        "total": len(kept),
        # So the page can say how much it is not showing, rather than looking
        # complete when it is not.
        "capacity": CAPACITY,
    }
