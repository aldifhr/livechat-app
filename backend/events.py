"""Normalised event layer.

Every source — TikTok, the manual trigger button, a donation webhook — emits
the same `Event` shape, and this module owns the single place where that shape
becomes a wire message. Sources therefore never learn the wire format, and
adding a new kind of alert is a one-file change instead of a new branch in
whichever source happened to produce it.

The wire format for the pre-existing kinds is unchanged from the original
single-file server, so a frontend on the old build keeps working against a
server on this one.
"""

import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable

from hub import hub

import eventlog

COMMENT = "comment"
LIKE = "like"
GIFT = "gift"
JOIN = "join"
VIEWERS = "viewers"
FOLLOW = "follow"
SHARE = "share"
ALERT = "alert"

#: Kinds a widget can subscribe to. The frontend mirrors this list in
#: lib/widgets/registry.ts; a mismatch means a widget never fires.
STREAM_KINDS = (COMMENT, LIKE, GIFT, JOIN)
STATE_KINDS = (VIEWERS,)
MANUAL_KINDS = (FOLLOW, SHARE, ALERT)


@dataclass
class Event:
    kind: str
    user: str = ""
    #: Stable per-user handle where the source can supply one. Distinct from
    #: `user`, which is a display nickname: a nickname can change and two
    #: people can share one, so anything that keys state per viewer (the
    #: astronaut widget's persistent roster, for one) needs this instead.
    user_id: str = ""
    #: Bare payload, no verb attached. "sent Rose x1", not "kei sent Rose x1" —
    #: the verb is a presentation concern and belongs in the renderer.
    value: str = ""
    meta: dict[str, Any] = field(default_factory=dict)


def _named(e: Event) -> dict[str, Any]:
    """The user fields every per-viewer event carries."""
    return {"user": e.user, "userId": e.user_id or e.user}


def _comment(e: Event) -> dict[str, Any]:
    return {"type": COMMENT, **_named(e), "text": e.value}


def _like(e: Event) -> dict[str, Any]:
    return {
        "type": LIKE,
        **_named(e),
        "count": e.meta.get("count", 1),
        "totalLikes": e.meta.get("totalLikes", 0),
    }


def _gift(e: Event) -> dict[str, Any]:
    return {
        "type": GIFT,
        **_named(e),
        "giftName": e.meta.get("giftName", "Gift"),
        "count": e.meta.get("count", 1),
        "value": e.meta.get("value", 0),
    }


def _join(e: Event) -> dict[str, Any]:
    return {"type": JOIN, **_named(e), "viewers": e.meta.get("viewers", 0)}


def _viewers(e: Event) -> dict[str, Any]:
    return {"type": VIEWERS, "count": e.meta.get("count", 0)}


def _follow(e: Event) -> dict[str, Any]:
    return {"type": FOLLOW, **_named(e)}


def _share(e: Event) -> dict[str, Any]:
    return {"type": SHARE, **_named(e), "count": e.meta.get("count", 1)}


def _alert(e: Event) -> dict[str, Any]:
    return {
        "type": ALERT,
        "title": e.meta.get("title", ""),
        "text": e.value,
        "icon": e.meta.get("icon", "★"),
        # Carried only when present, so a plain alert is unchanged on the wire
        # and anything that checks for the field is not misled by a zero. This
        # is the only thing that carries a donation amount, and it is what the
        # donation jar reads — a hook that posted an amount used to have it
        # dropped on the way out.
        **({"amount": e.meta["amount"]} if e.meta.get("amount") is not None else {}),
    }


SERIALISERS: dict[str, Callable[[Event], dict[str, Any]]] = {
    COMMENT: _comment,
    LIKE: _like,
    GIFT: _gift,
    JOIN: _join,
    VIEWERS: _viewers,
    FOLLOW: _follow,
    SHARE: _share,
    ALERT: _alert,
}


def to_wire(event: Event) -> dict[str, Any]:
    serialise = SERIALISERS.get(event.kind)
    if serialise is None:
        # An unknown kind is a bug in the caller, not a reason to silence the
        # overlay: surface it as an alert so it is visible while developing
        # rather than dropped on the floor.
        return _alert(
            Event(kind=ALERT, value=event.kind, meta={"title": "unhandled kind", "icon": "⚠"})
        )
    return serialise(event)


async def emit(overlay_id: str, event: Event) -> None:
    # Logged here rather than in each source, so every producer is covered by one
    # line of code: TikTok, the manual trigger and any future source all pass
    # through emit, and a source that forgot to log would be invisible if the call
    # sat in the source instead.
    #
    # Outside the broadcast on purpose. The log has to keep working when every
    # client has gone — a quiet log is exactly when it is needed.
    eventlog.record(event.kind, user=event.user, text=event.value, meta=event.meta)
    await hub.broadcast(to_wire(event), overlay_id=overlay_id)


async def emit_status(overlay_id: str, *, connected: bool, message: str, connecting: bool = False) -> None:
    # A snapshot sent at the start of a session is connecting=True, not a state
    # change, and treating it as a disconnect would reset the counters before
    # there is anything to count.
    if not connecting and eventlog.is_connected() != connected:
        eventlog.set_connected(connected, message)
    payload: dict[str, Any] = {"type": "status", "connected": connected, "message": message}
    if connecting:
        payload["connecting"] = True
    await hub.broadcast(payload, overlay_id=overlay_id)


async def emit_error(overlay_id: str, message: str) -> None:
    eventlog.error(message)
    await hub.broadcast({"type": "error", "message": message}, overlay_id=overlay_id)


async def emit_config(overlay_id: str, config: dict[str, Any]) -> None:
    await hub.broadcast({"type": "config", "config": config}, overlay_id=overlay_id)


# How many fan-outs may be in flight at once.
#
# Every event became its own task, so a burst of two thousand comments became
# two thousand tasks all competing for the same event loop — the shape that took
# the API down once already. Bounding it keeps the loop answering requests while
# the burst is still going out.
#
# Bounded, not dropped. A full room gets every comment; it just does not get
# them all in the same instant.
MAX_INFLIGHT = 64

_inflight: asyncio.Semaphore | None = None


def _gate() -> asyncio.Semaphore:
    """The fan-out gate, built on first use.

    An asyncio primitive binds to the loop it was made on, and this module is
    imported long before there is one, so it cannot be built at import time.
    """
    global _inflight
    if _inflight is None:
        _inflight = asyncio.Semaphore(MAX_INFLIGHT)
    return _inflight


async def _emit_gated(overlay_id: str, event: Event) -> None:
    async with _gate():
        await emit(overlay_id, event)


def dispatch(overlay_id: str, event: Event) -> asyncio.Task:
    """Fire an event without making the caller await the fan-out.

    WebSocket sends can block on a stalled client, and a source's handler runs
    inside TikTokLive's event loop; awaiting here would let one wedged browser
    source back-pressure the whole live stream.
    """
    return asyncio.create_task(_emit_gated(overlay_id, event))
