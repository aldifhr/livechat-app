"""Normalised event layer.

Every source — TikTok, the manual trigger button, a donation webhook — emits
the same `Event` shape, and this module owns the single place where that shape
becomes a wire message. Sources therefore never learn the wire format, and
adding a new kind of alert is a one-file change instead of a new branch in
whichever source happened to produce it.

The wire format for the pre-existing kinds is unchanged from the original
single-file server, so a frontend on the old build keeps working against a
server on this one.

These dicts are read in two places, and only the first is a Python caller: the
overlay pages in `web/public/overlay/` consume this format directly, and the
dashboard reads it through the same socket. So renaming a key here is not
contained: the overlay will read the old name and show nothing.
`api/tests/test_api.py` pins the Python side — run it after changing a key.
"""

from dataclasses import dataclass, field
from typing import Any, Callable

from hub import hub
from metrics import metrics as _metrics
from models import page_config

import eventlog

COMMENT = "comment"
LIKE = "like"
GIFT = "gift"
JOIN = "join"
VIEWERS = "viewers"
FOLLOW = "follow"
SHARE = "share"
ALERT = "alert"
INTRO = "intro"
NOTICE = "notice"
SUBSCRIPTION = "subscription"
POLL = "poll"


@dataclass
class Event:
    kind: str
    user: str = ""
    #: Stable per-user handle where the source can supply one. Distinct from
    #: `user`, which is a display nickname: a nickname can change and two
    #: people can share one, so anything that keys state per viewer (the
    #: astronaut widget's persistent roster, for one) needs this instead.
    user_id: str = ""
    #: Avatar URL where the source has one. Empty is the normal case, not an
    #: error: TikTok populates it on comment events and leaves it empty on
    #: join/follow/like/gift, so a row without an avatar is the ordinary state of
    #: a row rather than a broken one. Empty means "draw the initial", and the
    #: renderer must never turn it into an image request.
    avatar: str = ""
    #: Bare payload, no verb attached. "sent Rose x1", not "kei sent Rose x1" —
    #: the verb is a presentation concern and belongs in the renderer.
    value: str = ""
    #: Extra fields the wire format may or may not carry. `liveEnded` is one of
    #: them: set when the stream itself finished rather than the socket dropping.
    #: The two look identical from the outside — both stop events arriving — but
    #: they mean opposite things for what to do next, since a dropped socket is
    #: worth reconnecting and a finished live is not. Nothing downstream can tell
    #: them apart otherwise, which is why this is carried rather than inferred
    #: later from "no events for a while".
    meta: dict[str, Any] = field(default_factory=dict)


def _named(e: Event) -> dict[str, Any]:
    """The user fields every per-viewer event carries.

    The avatar is included here rather than per-serializer because every one of
    them describes a person, and TikTok's population of it is uneven: comments
    have one, joins and follows do not. Passing it through the shared helper
    means a kind that has an avatar sends it, and the kinds that do not send an
    empty string the renderer already knows how to draw.
    """
    return {"user": e.user, "userId": e.user_id or e.user, "avatar": e.avatar}


def _comment(e: Event) -> dict[str, Any]:
    # `mentions` is carried only when there is one, so a plain message stays
    # byte-for-byte what it was and a client that predates the field reads
    # nothing new. An empty list and an absent key mean the same thing here —
    # nobody was addressed — and the absent form keeps the ordinary case cheap.
    payload: dict[str, Any] = {"type": COMMENT, **_named(e), "text": e.value}
    mentions = e.meta.get("mentions")
    if mentions:
        payload["mentions"] = list(mentions)
    # Same rule for the MOD badge and custom emotes: present only when true, so a
    # plain comment's frame is unchanged and an older client sees nothing new.
    if e.meta.get("moderator"):
        payload["isModerator"] = True
    emotes = [
        {"url": str(x.get("url", "")), "id": str(x.get("id", ""))}
        for x in (e.meta.get("emotes") or [])
        if isinstance(x, dict) and x.get("url")
    ]
    if emotes:
        payload["emotes"] = emotes
    return payload


def _like(e: Event) -> dict[str, Any]:
    return {
        "type": LIKE,
        **_named(e),
        "count": e.meta.get("count", 1),
        "totalLikes": e.meta.get("totalLikes", 0),
    }


def _gift(e: Event) -> dict[str, Any]:
    payload = {
        "type": GIFT,
        **_named(e),
        "giftName": e.meta.get("giftName", "Gift"),
        "count": e.meta.get("count", 1),
        "value": e.meta.get("value", 0),
    }
    # Carried only when TikTok sent one, the same rule as mentions/emotes: a gift
    # with no picture keeps the frame it had, and the app falls back to the name.
    image = e.meta.get("giftImage")
    if image:
        payload["giftImage"] = str(image)
    return payload


def _join(e: Event) -> dict[str, Any]:
    return {"type": JOIN, **_named(e), "viewers": e.meta.get("viewers", 0)}


def _viewers(e: Event) -> dict[str, Any]:
    return {"type": VIEWERS, "count": e.meta.get("count", 0)}


def _follow(e: Event) -> dict[str, Any]:
    return {"type": FOLLOW, **_named(e)}


def _share(e: Event) -> dict[str, Any]:
    return {"type": SHARE, **_named(e), "count": e.meta.get("count", 1)}


def _intro(e: Event) -> dict[str, Any]:
    return {
        "type": INTRO,
        **_named(e),
        "title": e.value,
    }


def _subscription(e: Event) -> dict[str, Any]:
    return {
        "type": SUBSCRIPTION,
        **_named(e),
        "months": e.meta.get("months", 0),
        "isSend": e.meta.get("isSend", False),
        "isCustom": e.meta.get("isCustom", False),
    }


def _notice(e: Event) -> dict[str, Any]:
    payload: dict[str, Any] = {"type": NOTICE, "text": e.value}
    # Carried only when TikTok sent one, the same rule as mentions/emotes: a
    # plain system notice keeps the frame it had.
    if e.user:
        payload["user"] = e.user
    if e.meta.get("source"):
        payload["source"] = e.meta["source"]
    return payload


def _poll(e: Event) -> dict[str, Any]:
    return {
        "type": POLL,
        "pollId": e.meta.get("pollId", ""),
        "question": e.value,
        "options": list(e.meta.get("options") or []),
        "state": e.meta.get("state", ""),
    }


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
    INTRO: _intro,
    NOTICE: _notice,
    SUBSCRIPTION: _subscription,
    POLL: _poll,
}


def to_wire(event: Event) -> dict[str, Any]:
    serialise = SERIALISERS.get(event.kind)
    if serialise is None:
        # An unknown kind is a bug in the caller, not a reason to silence the
        # room: surface it as an alert so it is visible while developing
        # rather than dropped on the floor.
        return _alert(
            Event(kind=ALERT, value=event.kind, meta={"title": "unhandled kind", "icon": "⚠"})
        )
    return serialise(event)


async def emit(room_id: str, event: Event) -> None:
    # Logged here rather than in each source, so every producer is covered by one
    # line of code: TikTok, the manual trigger and any future source all pass
    # through emit, and a source that forgot to log would be invisible if the call
    # sat in the source instead.
    #
    # Outside the broadcast on purpose. The log has to keep working when every
    # client has gone — a quiet log is exactly when it is needed.
    eventlog.record(
        room_id, event.kind, user=event.user, text=event.value, meta=event.meta, user_id=event.user_id
    )
    # Counted here for the same reason it is logged here: one line covers every
    # producer. The kind is the only label, and `to_wire` maps an unknown kind to
    # `alert`, so the set of labels is closed — see `metrics`.
    _metrics.event_in(event.kind)
    await hub.broadcast(to_wire(event), room_id=room_id)


async def emit_status(
    room_id: str,
    *,
    connected: bool,
    message: str,
    connecting: bool = False,
    live_ended: bool = False,
    waiting: bool = False,
) -> None:
    # A snapshot sent at the start of a session is connecting=True, not a state
    # change, and treating it as a disconnect would reset the counters before
    # there is anything to count.
    if not connecting and eventlog.is_connected(room_id) != connected:
        eventlog.set_connected(room_id, connected, message)
    payload: dict[str, Any] = {"type": "status", "connected": connected, "message": message}
    if connecting:
        payload["connecting"] = True
    # Carried only when true, so a plain status frame is byte-for-byte what it was
    # before this existed and an older client reading it sees nothing new. The
    # flag is what separates "the streamer stopped" from "our connection dropped":
    # the app says "live ended" for one and reconnects for the other, and it
    # cannot tell them apart from the stream of events alone.
    if live_ended:
        payload["liveEnded"] = True
    # Also carried only when true, and also its own flag: the backend is polling
    # for a streamer with no live right now. Distinct from `connecting`, which
    # means "a handshake is in flight" and drives a button the user cannot press;
    # this one can last two hours and needs a way out.
    if waiting:
        payload["waiting"] = True
    await hub.broadcast(payload, room_id=room_id)


async def emit_error(room_id: str, message: str) -> None:
    eventlog.error(message)
    await hub.broadcast({"type": "error", "message": message}, room_id=room_id)


async def emit_config(room_id: str, config: dict[str, Any]) -> None:
    """Push a room's styling to every overlay already watching it.

    Translated on the way out, not on the way in. The caller is handing over what
    was stored — `overlaySize`, `overlayBg` and the rest — and the page is waiting
    for `size`, `background`. Sending the stored names meant a page asked to read
    `background` out of this frame got `undefined` and fell back to its defaults,
    so a restyle looked like it had done nothing while the overlay kept running
    exactly as before.

    Translating here rather than at the two call sites means there is one place
    that knows the two vocabularies, and the WebSocket handshake and the save path
    cannot disagree about what a page is sent.
    """
    await hub.broadcast({"type": "config", "config": page_config(config)}, room_id=room_id)


def offline_status() -> dict[str, Any]:
    """The status frame for a room with no source running.

    A fresh dict rather than a shared constant, because callers hand it to
    `hub.broadcast` and to WebSocket sends where a later mutation of one shared
    object would leak between rooms. The shape is the adapter's own terminal
    status, so a client cannot tell — and does not need to — which side produced
    it.
    """
    return {"type": "status", "connected": False, "message": "Offline"}


# There used to be a `dispatch()`/`_gate()`/`MAX_INFLIGHT` trio here, bounding how
# many fan-outs could be in flight at once. It was written when `emit` awaited the
# socket send directly and a stalled client could back-pressure the whole stream.
# That is no longer how delivery works: `hub.broadcast` hands each message to a
# per-client queue with `put_nowait` and a writer task drains it, so `emit` never
# blocks and there is nothing for a gate to bound. It was also never called from
# production — only from its own test — so the safety net was fictional and the
# docstring in `sources/__init__.py` described an interface nothing used. Both are
# gone; `emit` is the interface, and it does not block.

