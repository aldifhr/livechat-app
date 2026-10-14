"""Overlay page rendering — both the chat overlay and the top-chatters board.

Extracted from `main.py`. These handlers only read static files and the room
store; they never touch the live source map or the WebSocket layer, so they
have no dependency on `main`.

Both pages live in the same `static/` directory and share the baked-config
contract, so the escaping and room lookup live here once.
"""
import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

import store

router = APIRouter()

#: The room-config keys that carry overlay styling, mapped to the names the page's
#: baked config uses. Only these are baked in; everything else in a room's config
#: is none of the overlay's business.
OVERLAY_STYLE_KEYS = {
    "overlaySize": "size",
    "overlayNameColour": "nameColour",
    "overlayTextColour": "textColour",
    "overlayBg": "background",
    "overlayMax": "max",
    "overlayDelay": "delay",
    "overlayFont": "font",
    # The board's heading. Added with the config route, when saving styling became
    # something the dashboard could do — see `page_config` for why this key is
    # absent from `models.OVERLAY_STORE_KEYS`, which guards a different path.
    "overlayTitle": "title",
}


def page_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """A room's stored config under the names a page reads.

    The store namespaces the overlay's settings — `overlaySize`, `overlayBg` — so
    that a room's config can hold more than styling and an unnamespaced `size` would
    be ambiguous. The page reads plain names. One translation between the two, used
    by every path that hands styling to a page.

    That is the whole point of this function: it used to exist only inside
    `baked_config`, so the WebSocket path sent the *stored* names while the HTML
    path sent the page's. A page asked to read `background` out of a frame carrying
    `overlayBg` gets nothing back and falls back to its defaults, so restyling a
    stream changed what OBS was pointed at without changing what OBS showed.
    """
    if not isinstance(config, dict):
        return {}
    out: dict[str, Any] = {}
    for room_key, page_key in OVERLAY_STYLE_KEYS.items():
        if room_key in config and config[room_key] is not None:
            out[page_key] = config[room_key]
    return out


def overlay_page(name: str = "overlay.html") -> str:
    """An overlay page's HTML, from disk.

    Read on each request rather than cached at import so editing the file takes
    effect on reload without a restart — the same reason the desktop overlay
    reads it with `include_str!` only at build. A missing file is a 500, not a
    blank page: a browser source showing nothing is indistinguishable from a
    chat that is merely quiet, which is the one failure nobody can diagnose.

    `name` picks which page: the chat overlay, or the standalone top-chatters
    board. Both live in the same directory and share the baked-config contract,
    so they go through the same reader.
    """
    path = Path(__file__).parent.parent / "static" / name
    return path.read_text(encoding="utf-8")


async def baked_config(room_id: str) -> dict[str, Any]:
    """The room's saved overlay styling, under the names the page reads.

    Empty when the room does not exist or carries no overlay settings — the
    page then uses its own defaults, exactly as it did before this existed.
    """
    try:
        record = await store.get_room_async(room_id)
    except Exception:  # noqa: BLE001 — a store hiccup must not blank the overlay
        return {}
    if not record:
        return {}
    return page_config(record.get("config"))


async def render_overlay(name: str, request: Request) -> HTMLResponse:
    """An overlay page with the named room's saved styling baked in.

    Shared by the chat overlay and the top-chatters board: both take a `?room=`
    and both bake the room's config into the same `__OVERLAY_CONFIG__` slot, so
    the escaping and the room lookup live here once rather than per route.
    """
    html = overlay_page(name)
    # Only a room id names a stored room; a handle is resolved by the page itself
    # and has no config to read here.
    room_id = request.query_params.get("room", "").strip()
    if room_id:
        baked = await baked_config(room_id)
        if baked:
            payload = json.dumps(baked, ensure_ascii=False)
            # Same escaping the host uses: a value containing `</script>` would
            # otherwise end the element early. Room config is user-typed, and this
            # page is rendered on a stream.
            safe = (
                payload.replace("<", "\\u003c")
                .replace(">", "\\u003e")
                .replace("&", "\\u0026")
            )
            html = html.replace("__OVERLAY_CONFIG__", safe)
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@router.get("/overlay/", response_class=HTMLResponse, include_in_schema=False)
@router.get("/overlay", response_class=HTMLResponse, include_in_schema=False)
@router.get("/overlay/chat-overlay", response_class=HTMLResponse, include_in_schema=False)
@router.get("/overlay/chat-overlay/", response_class=HTMLResponse, include_in_schema=False)
async def chat_overlay(request: Request) -> HTMLResponse:
    """Serve the chat overlay, baking in the named room's saved styling.

    Both with and without the trailing slash, because an OBS browser source is
    configured once by hand and a redirect on the wrong one is a source that
    loads nothing for no obvious reason.
    """
    return await render_overlay("overlay.html", request)


@router.get("/topchatter/", response_class=HTMLResponse, include_in_schema=False)
@router.get("/topchatter", response_class=HTMLResponse, include_in_schema=False)
@router.get("/overlay/top-chatter", response_class=HTMLResponse, include_in_schema=False)
@router.get("/overlay/top-chatter/", response_class=HTMLResponse, include_in_schema=False)
async def top_chatter(request: Request) -> HTMLResponse:
    """Serve the standalone top-chatters board — the leaderboard and nothing else.

    Its own source for OBS, so a stream can put "who is talking most" in its own
    scene rather than as a corner of the chat overlay. Same `?room=` and same
    baked styling as the chat overlay; the difference is only which page it is.

    Also served at `/overlay/top-chatter`, which is where the frontend puts it:
    one address per overlay so a customiser or a scene collection points at one
    page and not a directory. Both domains answer both spellings, so a link
    pasted from either still works.
    """
    return await render_overlay("topchatter.html", request)
