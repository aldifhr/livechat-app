"""Health, metrics, and the static gift-sticker gallery mount.

Extracted from `main.py`. These endpoints are deliberately unauthenticated:
they carry only aggregate counts, not room-identifying data. State is bound
once at startup via `bind_state` so the module stays free of `main`.
"""
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.staticfiles import StaticFiles


import eventlog
import events
import logbuffer
import store
from models import HookRequest, TriggerRequest
from routes.auth import TOKEN_REJECTED_DETAIL
from routes.common import require_room

router = APIRouter()

#: Live process state, injected from `main` at registration.
_state: dict[str, Any] = {
    "sources": {},
    "hub": None,
    "token_is_valid": lambda req: False,
    "default_room_config": {},
}


def bind_state(sources, hub, token_is_valid, default_room_config) -> None:
    """Point the ops endpoints at live process state."""
    _state["sources"] = sources
    _state["hub"] = hub
    _state["token_is_valid"] = token_is_valid
    _state["default_room_config"] = default_room_config


def _health_body(request: Request, *, include_rooms: bool) -> dict[str, Any]:
    """The liveness body, with or without the per-room map.

    `/health` withholds the map from an unauthenticated caller because each entry
    names the streamer's handle. Everything else is identical, so it is built
    once.
    """
    app = request.app
    uptime_s = int(time.time() - getattr(app.state, "started_at", time.time()))
    body: dict[str, Any] = {
        "status": "ok",
        "uptimeSeconds": uptime_s,
        "activeRooms": len(_state["sources"]),
        "totalConnections": len(_state["hub"].active),
    }
    if include_rooms:
        body["rooms"] = {
            room_id: source.status_payload()
            for room_id, source in _state["sources"].items()
        }
    return body


@router.get("/health")
async def health(request: Request) -> dict[str, Any]:
    """Aggregate liveness probe for the backend.

    Returns uptime, active room count, total WebSocket connections, and — to a
    caller holding the token — per-room provider status. Used by orchestrators
    and load balancers, which probe without a credential; the per-room map is
    withheld from them because each entry names the streamer's handle, and this
    endpoint is open. The counts are what a probe acts on and they stay.
    """
    return _health_body(request, include_rooms=_state["token_is_valid"](request))


@router.get("/metrics")
async def metrics() -> dict[str, Any]:
    """Prometheus-style metrics exposed as JSON for simple scraping."""
    return {
        "sources_active": len(_state["sources"]),
        "websocket_connections": len(_state["hub"].active),
        "queued_messages_total": _state["hub"].queued_messages(),
        # A real counter on the hub, incremented in `disconnect`. This used to read
        # a `_disconnection_log` attribute that was never defined, so the getattr
        # default was all it ever returned and the metric was a permanent zero.
        "clients_disconnected_total": _state["hub"].disconnected_clients_count,
    }


@router.post("/api/rooms/{room_id}/trigger")
async def trigger(room_id: str, req: TriggerRequest):
    """Emit an event into a room by hand.

    Kept separate from `webhook` so a Stream Deck or cron job POSTs to a path
    whose shape matches the dashboard button, while external integrators use the
    flatter `/api/hooks/{room_id}` shape without touching the same surface.
    """
    await require_room(room_id)
    await events.emit(
        room_id,
        events.Event(
            kind=req.kind,
            user=req.user,
            user_id=req.user_id,
            value=req.text,
            meta={
                "title": req.title,
                "icon": req.icon,
                "count": req.count,
                "giftName": req.text or "Gift",
                "diamonds": req.diamonds * req.count,
                "value": req.diamonds * req.count,
                "months": req.months,
            },
        ),
    )
    return {"status": "ok", "kind": req.kind}


@router.post("/api/hooks/{room_id}")
async def webhook(room_id: str, req: HookRequest):
    """Alias for `trigger` with a flatter body, for external integrations.

    Kept separate rather than merged so the intent at the call site is
    readable, and so this path can grow its own auth later without changing
    what the dashboard's own button posts.
    """
    await require_room(room_id)

    value = req.text
    if req.amount is not None and not value:
        value = f"{req.amount:g}"

    # Gift meta must match what trigger() sets, so the two routes agree.
    # _gift (events.py) reads meta.get("value", 0) for diamond count, and
    # eventlog.record also computes from value. Without it, hook gifts are
    # always 0 diamonds and never enter total_diamonds or top_gifters.
    #
    # The name is `req.text` and not the derived `value` above, because `value`
    # falls back to the amount when no text was posted — so a gift hook with no
    # text was naming a 9999-diamond gift "9999" where the trigger route names the
    # same gift "Gift". `value` is the alert's text, which is a different field
    # doing a different job; reusing it here is how the two routes drifted.
    meta: dict[str, Any] = {
        "title": req.title,
        "icon": req.icon,
        "count": 1,
        "giftName": req.text or "Gift",
    }
    if req.amount is not None:
        meta["amount"] = req.amount
        # Whole, because a diamond count is. `HookRequest.amount` is a float so a
        # donation of 12.50 can be announced as one, and `amount` above keeps that
        # exactly as posted — but the gift accounting is a count, and
        # `RoomLog.total_diamonds` is declared `int`. Carrying the float into it
        # made a session that had seen one hook gift report `9999.0` and render a
        # leaderboard of fractional diamonds. `trigger` is integral already, being
        # `diamonds * count` over two ints, so this is the only route that had to
        # be rounded — and the two now agree on the wire as well as in the totals.
        whole = int(req.amount)
        meta["diamonds"] = whole
        meta["value"] = whole

    await events.emit(
        room_id,
        events.Event(
            kind=req.kind,
            user=req.user,
            user_id=req.user_id,
            value=value,
            meta=meta,
        ),
    )
    return {"status": "ok"}


@router.get("/api/analytics")
async def analytics(request: Request, provider: str = "") -> dict[str, Any]:
    """Aggregated session stats across all rooms.

    Answers the questions the dashboard cannot: which stream had the most
    viewers, who gifted the most across all sessions, which chatter was most
    active. Every number comes from `eventlog` — the same counters the session
    endpoint reads per room — so there is no second definition of anything.

    `provider` narrows the aggregation to one platform when given. Filtering
    here rather than on the browser keeps the totals and the gifter leaderboard
    from disagreeing with the rows they summarise: the leaderboard is summed from
    each room's top twenty, and only the backend has those per room.

    The leaderboards are summed across rooms on the stable user id, so one person
    who showed up on two streams is one row rather than two. **They are the top
    twenty of each room, added up** — `eventlog` prunes its per-viewer maps to
    that, and so a chatter ranked twenty-first everywhere is invisible here. That
    is a ceiling on what can be reported, not an approximation added for
    convenience, and the page says so where it draws them.
    """
    if provider and provider != "tiktok":
        raise HTTPException(status_code=400, detail="provider must be 'tiktok'")
    if not _state["token_is_valid"](request):
        raise HTTPException(status_code=401, detail=TOKEN_REJECTED_DETAIL)
    rooms = await store.all_rooms_async()
    if provider:
        rooms = {
            room_id: record
            for room_id, record in rooms.items()
            if str(record.get("provider") or "tiktok") == provider
        }
    out: dict[str, Any] = {
        "total_rooms": len(rooms),
        "total_viewers": 0,
        "total_peak_viewers": 0,
        "total_diamonds": 0,
        "total_events": 0,
        "rooms": [],
        "topGifters": [],
    }
    # room id -> (name, total) for the gifter leaderboard. Keyed on the user id,
    # which is the only thing that means the same person in two rooms; a nickname
    # does not, and a display name can change mid-session.
    gifter_totals: dict[str, tuple[str, int]] = {}

    for room_id, record in rooms.items():
        snap = eventlog.snapshot(room_id)
        viewers = snap.get("viewers") or 0
        peak = snap.get("peak_viewers") or 0
        diamonds = snap.get("total_diamonds") or 0
        events = sum(snap.get("totals", {}).values())
        out["total_viewers"] += viewers
        out["total_peak_viewers"] += peak
        out["total_diamonds"] += diamonds
        out["total_events"] += events

        for person in snap.get("topGifters") or []:
            key = str(person.get("id") or person.get("nickname") or "")
            name, running = gifter_totals.get(key, (str(person.get("nickname") or key), 0))
            gifter_totals[key] = (name, running + int(person.get("diamonds") or 0))

        out["rooms"].append({
            "id": room_id,
            "username": record.get("username", ""),
            "connected": snap.get("connected", False),
            "viewers": viewers,
            "peak_viewers": peak,
            "total_diamonds": diamonds,
            "events": events,
            "live_seconds": snap.get("live_seconds"),
        })

    out["rooms"].sort(key=lambda r: r["viewers"], reverse=True)
    out["topGifters"] = _rank(gifter_totals, "diamonds", eventlog.TOP_N)
    return out


def _rank(totals: dict[str, tuple[str, int]], field: str, limit: int) -> list[dict[str, Any]]:
    """A summed cross-room tally, most first, ties broken by name.

    Ties broken by name rather than by insertion order, for the reason the
    per-room leaderboards are: a ranking that reshuffles between two reads of the
    same numbers is not read as a ranking.

    A person with no id and no nickname is dropped here rather than where the
    leaderboards are built. The filter belongs on the function that produces the
    list, so that it holds for every caller instead of depending on each one
    remembering — which is how a row with a blank name and a real score ends up on
    a leaderboard.
    """
    ordered = sorted(
        ((key, value) for key, value in totals.items() if key),
        key=lambda kv: (-kv[1][1], kv[1][0]),
    )
    return [
        {"id": key, "nickname": name, field: value}
        for key, (name, value) in ordered[:limit]
    ]


@router.get("/api/logs")
async def logs(request: Request, limit: int = 200, level: str = "info", q: str = "") -> dict[str, Any]:
    """The backend's recent log records, for the dashboard's log page.

    Token-gated, unlike `/health` and `/metrics`. Those carry aggregate counts an
    orchestrator needs without a credential; this carries whatever the backend has
    said, and a backend says things like room handles, URLs and the reason a
    request was refused. It is a read, so the middleware does not gate it on method
    — the check is here instead.

    Answers 401 rather than 403 for a missing token: there is no session to be
    missing, only a credential, and the dashboard's own error handling already
    treats both as "the credential was refused".
    """
    if not _state["token_is_valid"](request):
        raise HTTPException(status_code=401, detail=TOKEN_REJECTED_DETAIL)
    # `limit` is clamped inside `read` rather than rejected, so a page asking for
    # more than exists gets what there is instead of an error.
    return logbuffer.read(limit=limit, min_level=level, search=q)


def mount_gifts(app: Any, static_dir: str) -> None:
    """Mount the browsable gift-sticker gallery as /gifts.

    Served as a static mount so the page, gifts.json and every .webp come from
    one directory with no per-file routing. Mounted last (in main.py, after the
    router) so it cannot shadow an API route.
    """
    gifts_dir = Path(static_dir) / "gifts"
    app.mount(
        "/gifts",
        StaticFiles(directory=str(gifts_dir), html=True),
        name="gifts",
    )
