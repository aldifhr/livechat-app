"""A readable log of what the room actually sent.

There was no logging anywhere in the backend: an event was built, fanned out to
the WebSockets, and dropped. So when a live room produced a fast-moving viewer
count and a busy chat and the room showed an empty canvas, there was nothing to
look at — the question could only be answered by attaching a script to the socket
and reading it by eye, and comparing that to a screenshot.

The log answers the questions that actually come up, which are mostly counts and
"was it this person":

  * Is the room live at all? A connected line, then nothing, means the room is
    quiet or the handler has stopped; silence on a busy room means the opposite.
  * Is the event arriving? ``comment #1``, ``#2``, ``#3`` in sequence. If the
    counter for a kind never moves, that kind is not being produced.
  * Is it the same person every time? Repeats are printed, because a stream
    where one account fills the chat is a different problem from a dead room.

Counts go to stdout as ``kind=count`` lines rather than being accumulated and
dumped periodically, so a slow trickle still shows up: a comment every four
minutes is invisible in a summary printed every five, and visible immediately
here.

Viewers is deliberately not counted as an event. It is state, not activity — it
arrives on its own interval and would bury everything else at a count per
second. Its latest value is printed instead, since that is the number people
actually want.
"""

import logging
import time
from typing import Any

log = logging.getLogger("streamkit.events")

#: Set while a room is connected, so the log can tell "quiet room" from "not
#: connected", which look identical in a stream of lines.
_connected = False

#: Per-kind totals for the current connection, and how many of those were the
#: same person arriving twice — the shape of a chatty room differs from the
#: shape of a broken one.
_totals: dict[str, int] = {}
_repeats: dict[str, int] = {}
_last_user: dict[str, str] = {}

#: The most recent viewer count, and when it was seen, so a stalled room is
#: distinguishable from a room that is simply empty.
_viewers: int | None = None
_viewers_at = 0.0

#: Per-chatter message counts for the current connection, and the last avatar seen
#: for each. The overlay's leaderboard reads this; it is kept here because this is
#: the one place every comment already passes through, keyed on the stable handle
#: so a display-name change does not split one person into two.
_chatter_counts: dict[str, int] = {}
_chatter_names: dict[str, str] = {}

#: How many names the leaderboard ranks and shows.
TOP_N = 10


def is_connected() -> bool:
    return _connected


def set_connected(connected: bool, detail: str = "") -> None:
    """Note the room's state. A disconnect resets the counters."""
    global _connected
    _connected = connected
    if connected:
        _totals.clear()
        _repeats.clear()
        _last_user.clear()
        _chatter_counts.clear()
        _chatter_names.clear()
        log.info("connected %s", detail or "")
    else:
        summary = ", ".join(f"{k}={v}" for k, v in sorted(_totals.items())) or "no events"
        log.info("disconnected %s (%s)", detail or "", summary)


def record(
    kind: str,
    user: str = "",
    text: str = "",
    meta: dict[str, Any] | None = None,
    user_id: str = "",
) -> None:
    """One line per event, with a per-kind running count."""
    if kind == "viewers":
        global _viewers, _viewers_at
        count = int((meta or {}).get("count") or 0)
        _viewers = count
        _viewers_at = time.time()
        log.info("viewers=%d", count)
        return

    n = _totals.get(kind, 0) + 1
    _totals[kind] = n

    if user and _last_user.get(kind) == user:
        _repeats[kind] = _repeats.get(kind, 0) + 1
    _last_user[kind] = user or _last_user.get(kind, "")

    # Count this message against the chatter, keyed on the stable handle so one
    # person is one row however their display name is spelled. Only comments count
    # toward the leaderboard — a gift or a join is not someone talking.
    if kind == "comment" and user:
        key = user_id or user
        _chatter_counts[key] = _chatter_counts.get(key, 0) + 1
        _chatter_names[key] = user

    # A greeting that is long enough to be a sentence and short enough to stay
    # on one line. Comment text is capped by the widget at 44 characters anyway,
    # so this is the same information a viewer would see.
    snippet = " ".join((text or "").split())[:60]
    parts = [f"{kind} #{n}"]
    if user:
        parts.append(user)
    if snippet:
        parts.append(snippet)
    if meta and meta.get("count") and kind != "viewers":
        parts.append(f"x{meta['count']}")
    log.info("%s", " · ".join(parts))


def note(message: str) -> None:
    """Something that happened but is not an event, such as a handler error."""
    log.info("%s", message)


def error(message: str) -> None:
    log.error("%s", message)


def top_chatters(limit: int = TOP_N) -> list[dict[str, Any]]:
    """The chattiest viewers this connection, most messages first.

    By message count only — a gift is not someone talking. Ties broken by name so
    the order is stable between polls rather than shuffling on every refresh.
    """
    ranked = sorted(_chatter_counts.items(), key=lambda kv: (-kv[1], _chatter_names.get(kv[0], "")))
    return [
        {"id": key, "nickname": _chatter_names.get(key, key), "messages": count}
        for key, count in ranked[:limit]
    ]


def snapshot() -> dict[str, Any]:
    """The current counters, for a status endpoint or a test."""
    return {
        "connected": _connected,
        "totals": dict(_totals),
        "repeats": dict(_repeats),
        "viewers": _viewers,
        "viewers_age": round(time.time() - _viewers_at, 1) if _viewers_at else None,
        "topChatters": top_chatters(),
    }
