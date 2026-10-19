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

Every one of these counters belongs to a room, so they are kept per room rather
than in one set of module globals. Two rooms can be live at once — the app
connects by handle, and nothing stops a streamer watching two streams side by
side — and with shared state the second room to connect cleared the first one's
counters, the leaderboard became a mixture of both rooms' viewers, and the same
handle posting in either room read as a repeat of itself. Every entry point here
therefore takes a room id and reads or writes only that room's state.

Reading does not create state. The WebSocket is unauthenticated and the room id
arrives in the URL, so an entry created on read would be one an anonymous caller
could allocate by guessing.
"""

import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import store

#: Where the session history lives. Reuses `store.CONFIG_DIR` rather than
#: re-deriving `STREAMKIT_CONFIG_DIR`, so a deploy that moves the config dir moves
#: this too — and the two cannot disagree about where the config directory is.
#: Pruned to `SESSIONS_KEEP` entries by `_append_session`.
SESSIONS_FILE: Path = store.CONFIG_DIR / "sessions.json"

#: How many finished sessions to keep. Seven days at a few sessions a day is
#: well under this; it exists so a long-running install does not grow the file
#: without bound.
SESSIONS_KEEP = 200


def _append_session(record: dict[str, Any]) -> None:
    """Append one finished session to the history, pruning the oldest.

    Best-effort: a failure to persist must not take down the disconnect that
    produced the record. The session's own counters are already in memory for
    the current run; this is the copy that survives a restart.
    """
    try:
        history: list[dict[str, Any]] = []
        if SESSIONS_FILE.exists():
            history = json.loads(SESSIONS_FILE.read_text(encoding="utf-8"))
        history.append(record)
        if len(history) > SESSIONS_KEEP:
            history = history[-SESSIONS_KEEP:]
        SESSIONS_FILE.write_text(json.dumps(history, ensure_ascii=False), encoding="utf-8")
    except (OSError, ValueError) as exc:
        log.debug("could not persist session history (%s)", exc)

log = logging.getLogger("streamkit.events")


@dataclass
class RoomLog:
    """What one room has sent, since it last connected."""

    #: Set while the room is connected, so the log can tell "quiet room" from
    #: "not connected", which look identical in a stream of lines.
    connected: bool = False

    #: Per-kind totals for this room, and how many of those were the same person
    #: arriving twice — the shape of a chatty room differs from the shape of a
    #: broken one.
    totals: dict[str, int] = field(default_factory=dict)
    repeats: dict[str, int] = field(default_factory=dict)
    last_user: dict[str, str] = field(default_factory=dict)

    #: The most recent viewer count for this room, and when it was seen, so a
    #: stalled room is distinguishable from a room that is simply empty.
    viewers: int | None = None
    viewers_at: float = 0.0

    #: Peak viewer count seen during this session, with the timestamp.
    peak_viewers: int = 0
    peak_viewers_at: float = 0.0

    #: When this session started, so the panel can say how long it has been live.
    #: Set on connect and cleared on reset — a duration is a property of the
    #: session, and the session is what `reset` begins.
    connected_at: float = 0.0
    disconnected_at: float = 0.0

    #: Total diamonds (gift value) accumulated this session.
    total_diamonds: int = 0

    #: Top gifters this session: user_id -> total diamond value.
    gifters: dict[str, int] = field(default_factory=dict)
    gifter_names: dict[str, str] = field(default_factory=dict)

    #: Comments per user this session: user_id -> count, and the last display name
    #: seen for each. The board overlay polls this. Keyed on the stable user id so
    #: a display-name change does not split one person into two rows.
    chatters: dict[str, int] = field(default_factory=dict)
    chatter_names: dict[str, str] = field(default_factory=dict)

    def reset(self) -> None:
        """Forget this connection's events, keeping the connected flag's caller
        to set. A reconnect is a new session and its counters start again."""
        self.totals.clear()
        self.repeats.clear()
        self.last_user.clear()
        # Session stats — reset on reconnect for accurate per-session tracking
        self.peak_viewers = 0
        self.peak_viewers_at = 0.0
        self.connected_at = 0.0
        self.disconnected_at = 0.0
        self.total_diamonds = 0
        self.viewers = None
        self.viewers_at = 0.0
        self.gifters.clear()
        self.gifter_names.clear()
        self.chatters.clear()
        self.chatter_names.clear()


#: How many names the leaderboard ranks and shows.
TOP_N = 10

#: One entry per room that has connected. Rooms are removed again by `forget`.
_rooms: dict[str, RoomLog] = {}


def _room(room_id: str) -> RoomLog:
    """This room's state, created if it is the first thing we hear about it."""
    room = _rooms.get(room_id)
    if room is None:
        room = _rooms[room_id] = RoomLog()
    return room


def is_connected(room_id: str) -> bool:
    room = _rooms.get(room_id)
    return bool(room and room.connected)


def set_connected(room_id: str, connected: bool, detail: str = "") -> None:
    """Note one room's state. A reconnect resets that room's counters.

    Only a connect resets. A disconnect keeps the totals, because they are that
    session's own counts and they are what a snapshot or the leaderboard still
    answers with until the room comes back — and coming back is a new session,
    which is where the reset belongs. Clearing here instead made a dropped room
    answer as if it had never spoken, which is the opposite of what the log is
    for: ``B still reports what it sent before it dropped``.
    """
    room = _room(room_id)
    room.connected = connected
    if connected:
        room.reset()
        # After the reset, which clears it — the session begins now.
        room.connected_at = time.time()
        log.info("[%s] connected %s", room_id, detail or "")
    else:
        summary = ", ".join(f"{k}={v}" for k, v in sorted(room.totals.items())) or "no events"
        room.disconnected_at = time.time()
        log.info("[%s] disconnected %s (%s)", room_id, detail or "", summary)
        # Persist the finished session so its numbers survive a restart. Only on a
        # real disconnect: a reconnect resets the counters in memory and would
        # append a duplicate with stale numbers.
        if room.connected_at and not room.connected:
            _append_session({
                "room_id": room_id,
                "started_at": room.connected_at,
                "ended_at": time.time(),
                "duration_s": round(time.time() - room.connected_at, 1),
                "peak_viewers": room.peak_viewers,
                "total_diamonds": room.total_diamonds,
                "events": dict(room.totals),
            })


def _prune_leaders(counts: dict, names: dict, cap: int) -> None:
    """Keep only the top `cap` entries by count, dropping the rest.

    Called after every insert. A busy session produces thousands of unique
    user_ids; without pruning the dicts grow unbounded for the life of the
    session. TOP_N limits what is *returned*, not what is *stored*.
    """
    if len(counts) <= cap:
        return
    # Sort by count descending, keep top cap, drop the rest.
    kept = set(sorted(counts, key=lambda k: counts[k], reverse=True)[:cap])
    for key in list(counts.keys()):
        if key not in kept:
            counts.pop(key, None)
            names.pop(key, None)


def forget(room_id: str) -> None:
    """Drop a room's counters entirely.

    Called when a room is deleted, so a room that no longer exists cannot still be
    holding a leaderboard and answering a snapshot for someone asking about it.
    """
    _rooms.pop(room_id, None)


def record(
    room_id: str,
    kind: str,
    user: str = "",
    text: str = "",
    meta: dict[str, Any] | None = None,
    user_id: str = "",
) -> None:
    """One line per event, with a per-kind running count for that room.

    Logged at DEBUG, not INFO. Every comment, like, join and viewer update used
    to be an INFO line, and a busy room produces ~15 of those a second: measured
    at 107k lines and 26 MB in a single day, which is most of the journald budget
    and evicts the unit's own errors, a deploy, or the kernel. The signal is
    still there for anyone looking for it — `STREAMKIT_LOG_LEVEL=DEBUG` — while
    the default level now holds only what is worth reading unasked: a room
    connecting, a room dropping, and a real error.
    """
    room = _room(room_id)

    if kind == "viewers":
        count = int((meta or {}).get("count") or 0)
        room.viewers = count
        room.viewers_at = time.time()
        # Track peak viewer count for session stats
        if count > room.peak_viewers:
            room.peak_viewers = count
            room.peak_viewers_at = time.time()
        log.debug("[%s] viewers=%d", room_id, count)
        return

    n = room.totals.get(kind, 0) + 1
    room.totals[kind] = n

    if user and room.last_user.get(kind) == user:
        room.repeats[kind] = room.repeats.get(kind, 0) + 1
    # Only update last_user when this event actually carried a user. The old
    # `user or room.last_user.get(kind, "")` inherited the previous user's
    # identity on events with no user, so a burst of anonymous joins was
    # counted as a repeat of whoever spoke last.
    if user:
        room.last_user[kind] = user

    # Track gift diamonds and top gifters
    _diamond_value = (meta or {}).get("value", 0)
    if kind == "gift" and _diamond_value and user:
        room.total_diamonds += _diamond_value
        key = user_id or user
        room.gifters[key] = room.gifters.get(key, 0) + _diamond_value
        room.gifter_names[key] = user
        _prune_leaders(room.gifters, room.gifter_names, TOP_N * 10)

    # Comments per person, for the board overlay. Only comments count: the board
    # answers "who is talking most", and a gift has its own leaderboard.
    if kind == "comment" and user:
        key = user_id or user
        room.chatters[key] = room.chatters.get(key, 0) + 1
        room.chatter_names[key] = user
        _prune_leaders(room.chatters, room.chatter_names, TOP_N * 10)

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
    log.debug("[%s] %s", room_id, " · ".join(parts))


def error(message: str) -> None:
    log.error("%s", message)


def top_chatters(room_id: str, limit: int = TOP_N) -> list[dict[str, Any]]:
    """The chatters who have sent the most comments this session, most first.

    Rebuilt on request rather than pushed, because a busy room produces comments
    faster than anyone reads a ranking and the board polls on its own beat. Ties
    break by name, so the order does not reshuffle between two reads of the same
    counts.
    """
    room = _rooms.get(room_id)
    if room is None or not room.chatters:
        return []
    ranked = sorted(
        room.chatters.items(),
        key=lambda kv: (-kv[1], room.chatter_names.get(kv[0], "")),
    )
    return [
        {"id": key, "nickname": room.chatter_names.get(key, key), "messages": messages}
        for key, messages in ranked[:limit]
    ]


def top_gifters(room_id: str, limit: int = TOP_N) -> list[dict[str, Any]]:
    """The top gifters in one room by total diamond value, most first."""
    room = _rooms.get(room_id)
    if room is None or not room.gifters:
        return []
    ranked = sorted(
        room.gifters.items(),
        key=lambda kv: (-kv[1], room.gifter_names.get(kv[0], "")),
    )
    return [
        {"id": key, "nickname": room.gifter_names.get(key, key), "diamonds": diamonds}
        for key, diamonds in ranked[:limit]
    ]


def snapshot(room_id: str) -> dict[str, Any]:
    """One room's counters, for the dashboard's session panel.

    Everything here is accumulated as events arrive and lives only in memory, so
    it describes the session that is running now and is gone when the process
    restarts. That is the honest scope: there is no history to read back, and a
    panel that implied one would be inventing numbers.

    Ages are sent rather than absolute timestamps, so the page can say "12s ago"
    without knowing the server's clock — and so a client whose clock is wrong does
    not render a duration that never happened.
    """
    room = _rooms.get(room_id)
    if room is None:
        return {
            "connected": False,
            "totals": {},
            "repeats": {},
            "viewers": None,
            "viewers_age": None,
            "peak_viewers": 0,
            "peak_viewers_age": None,
            "live_seconds": None,
            "total_diamonds": 0,
            "topGifters": [],
        }
    return {
        "connected": room.connected,
        "totals": dict(room.totals),
        "repeats": dict(room.repeats),
        "viewers": room.viewers,
        "viewers_age": round(time.time() - room.viewers_at, 1) if room.viewers_at else None,
        "peak_viewers": room.peak_viewers,
        "peak_viewers_age": round(time.time() - room.peak_viewers_at, 1) if room.peak_viewers_at else None,
        # How long the session has run. Stops at disconnect time, not now —
        # otherwise the duration keeps climbing after the stream drops.
        "live_seconds": round((room.disconnected_at or time.time()) - room.connected_at, 1) if room.connected_at else None,
        "total_diamonds": room.total_diamonds,
        "topGifters": top_gifters(room_id),
    }