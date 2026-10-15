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

import logging
import time
from dataclasses import dataclass, field
from typing import Any

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

    #: Total diamonds (gift value) accumulated this session.
    total_diamonds: int = 0

    #: Top gifters this session: user_id -> total diamond value.
    gifters: dict[str, int] = field(default_factory=dict)
    gifter_names: dict[str, str] = field(default_factory=dict)

    #: Per-chatter message counts and the last avatar seen for each. The overlay's
    #: leaderboard reads this; it is kept here because this is the one place
    #: every comment already passes through, keyed on the stable handle so a
    #: display-name change does not split one person into two.
    chatter_counts: dict[str, int] = field(default_factory=dict)
    chatter_names: dict[str, str] = field(default_factory=dict)

    def reset(self) -> None:
        """Forget this connection's events, keeping the connected flag's caller
        to set. A reconnect is a new session and its counters start again."""
        self.totals.clear()
        self.repeats.clear()
        self.last_user.clear()
        self.chatter_counts.clear()
        self.chatter_names.clear()
        # Session stats — reset on reconnect for accurate per-session tracking
        self.peak_viewers = 0
        self.peak_viewers_at = 0.0
        self.total_diamonds = 0
        self.gifters.clear()
        self.gifter_names.clear()


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
        log.info("[%s] connected %s", room_id, detail or "")
    else:
        summary = ", ".join(f"{k}={v}" for k, v in sorted(room.totals.items())) or "no events"
        log.info("[%s] disconnected %s (%s)", room_id, detail or "", summary)


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
    room.last_user[kind] = user or room.last_user.get(kind, "")

    # Count this message against the chatter, keyed on the stable handle so one
    # person is one row however their display name is spelled. Only comments count
    # toward the leaderboard — a gift or a join is not someone talking.
    if kind == "comment" and user:
        key = user_id or user
        room.chatter_counts[key] = room.chatter_counts.get(key, 0) + 1
        room.chatter_names[key] = user

    # Track gift diamonds and top gifters
    _diamond_value = (meta or {}).get("value", 0)
    if kind == "gift" and _diamond_value and user:
        room.total_diamonds += _diamond_value
        key = user_id or user
        room.gifters[key] = room.gifters.get(key, 0) + _diamond_value
        room.gifter_names[key] = user

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


def note(message: str) -> None:
    """Something that happened but is not an event, such as a handler error."""
    log.info("%s", message)


def error(message: str) -> None:
    log.error("%s", message)


def top_chatters(room_id: str, limit: int = TOP_N) -> list[dict[str, Any]]:
    """The chattiest viewers in one room, most messages first.

    By message count only — a gift is not someone talking. Ties broken by name so
    the order is stable between polls rather than shuffling on every refresh.
    """
    room = _rooms.get(room_id)
    if room is None:
        return []
    ranked = sorted(
        room.chatter_counts.items(),
        key=lambda kv: (-kv[1], room.chatter_names.get(kv[0], "")),
    )
    return [
        {"id": key, "nickname": room.chatter_names.get(key, key), "messages": count}
        for key, count in ranked[:limit]
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
    """One room's counters, for a status endpoint or a test."""
    room = _rooms.get(room_id)
    if room is None:
        return {
            "connected": False,
            "totals": {},
            "repeats": {},
            "viewers": None,
            "viewers_age": None,
            "topChatters": [],
        }
    return {
        "connected": room.connected,
        "totals": dict(room.totals),
        "repeats": dict(room.repeats),
        "viewers": room.viewers,
        "viewers_age": round(time.time() - room.viewers_at, 1) if room.viewers_at else None,
        "peak_viewers": room.peak_viewers,
        "peak_viewers_at": round(time.time() - room.peak_viewers_at, 1) if room.peak_viewers_at else None,
        "total_diamonds": room.total_diamonds,
        "topChatters": top_chatters(room_id),
        "topGifters": top_gifters(room_id),
    }