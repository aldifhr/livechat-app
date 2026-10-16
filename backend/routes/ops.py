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
from fastapi.responses import JSONResponse

import alerts
import events
import logbuffer
import store
from models import HookRequest, TriggerRequest

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


@router.get("/health")
async def health(request: Request) -> dict[str, Any]:
    """Aggregate liveness probe for the backend.

    Returns uptime, active room count, total WebSocket connections, and — to a
    caller holding the token — per-room provider status. Used by orchestrators
    and load balancers, which probe without a credential; the per-room map is
    withheld from them because each entry names the streamer's handle, and this
    endpoint is open. The counts are what a probe acts on and they stay.
    """
    app = request.app
    uptime_s = int(time.time() - getattr(app.state, "started_at", time.time()))
    body: dict[str, Any] = {
        "status": "ok",
        "uptimeSeconds": uptime_s,
        "activeRooms": len(_state["sources"]),
        "totalConnections": len(_state["hub"].active),
    }
    # Only the holder of the write token sees the per-room map. Each entry names
    # a streamer's handle — an open leak would expose every configured room.
    if _state["token_is_valid"](request):
        body["rooms"] = {
            room_id: source.status_payload()
            for room_id, source in _state["sources"].items()
        }
    return JSONResponse(body)


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
    await _require_room(room_id)
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
    await _require_room(room_id)

    value = req.text
    if req.amount is not None and not value:
        value = f"{req.amount:g}"

    # Gift meta must match what trigger() sets, so the two routes agree.
    # _gift (events.py) reads meta.get("value", 0) for diamond count, and
    # eventlog.record also computes from value. Without it, hook gifts are
    # always 0 diamonds and never enter total_diamonds or top_gifters.
    meta: dict[str, Any] = {
        "title": req.title,
        "icon": req.icon,
        "count": 1,
        "giftName": value or "Gift",
    }
    if req.amount is not None:
        meta["amount"] = req.amount
        meta["diamonds"] = req.amount
        meta["value"] = req.amount

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
        raise HTTPException(status_code=401, detail="Invalid or missing STREAMKIT_TOKEN")
    # `limit` is clamped inside `read` rather than rejected, so a page asking for
    # more than exists gets what there is instead of an error.
    return logbuffer.read(limit=limit, min_level=level, search=q)


@router.post("/api/alerts/test")
async def alerts_test(request: Request) -> dict[str, Any]:
    """Send one alert now, so a webhook can be checked without waiting for a stream.

    A webhook that was never tested is a webhook nobody knows is broken. The
    alternative — waiting for the first real failure to find out — is the worst
    possible time to discover it.

    Token-gated like every other write. Answers with `configured: false` rather
    than an error when no webhook is set: "alerts are off" is a fact about the
    deployment, not a failure of the request.
    """
    if not _state["token_is_valid"](request):
        raise HTTPException(status_code=401, detail="Invalid or missing STREAMKIT_TOKEN")
    if not alerts.enabled():
        return {"configured": False, "sent": False, "detail": f"{alerts.WEBHOOK_ENV} is not set"}
    sent = await alerts.notify(
        "test",
        "00000000-0000-0000-0000-000000000000",
        "test",
        "This is a test alert from the dashboard. Nothing is wrong.",
    )
    return {"configured": True, "sent": sent}


async def _require_room(room_id: str) -> None:
    """Raise 404 by name if the room does not exist.

    Shared by the ``trigger`` and ``webhook`` endpoints so the existence check
    reads one way and cannot drift between them — the bug this guards is a 404
    that reads "something else" in one handler and "room missing" in the other.
    """
    record = await store.get_room_async(room_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Room not found")


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
