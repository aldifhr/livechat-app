"""Health, metrics, and the static gift-sticker gallery mount.

Extracted from `main.py`. These endpoints are deliberately unauthenticated:
they carry only aggregate counts, not room-identifying data. State is bound
once at startup via `bind_state` so the module stays free of `main`.
"""
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse

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
