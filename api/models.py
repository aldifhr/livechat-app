"""Pydantic models and request-body types for the API.

All request/response shapes live here so `main.py` can stay focused on
routing. The backend stores whatever config the frontend sends without
interpreting it — this module owns neither the schema nor its defaults.
"""
from typing import Any

from pydantic import BaseModel, Field


class ConnectRequest(BaseModel):
    # Optional because /api/disconnect is posted with only a room id, and
    # this used to be required — which made disconnect answer 422 and left the
    # editor's Stop button silently doing nothing. /api/connect validates it.
    username: str = ""
    room_id: str | None = None
    #: Which platform to connect. Only "tiktok" is served.
    provider: str = "tiktok"


class CreateRoomRequest(BaseModel):
    name: str
    #: Starting room, resolved by the caller.
    #:
    #: The frontend owns the config schema entirely — this module used to mirror
    #: a single key of it, because a second copy of the schema here is how the two
    #: drift. Accepting the whole config keeps that ownership one-directional:
    #: the backend stores what it is given and never interprets it.
    config: dict[str, Any] | None = None


class UpdateRoomRequest(BaseModel):
    name: str | None = None
    username: str | None = None


class ConnectByUsernameRequest(BaseModel):
    """A handle and the overlay styling to remember for its room.

    The styling is optional and saved into the room's config when present, so a
    bare `?room=<id>` overlay link can render as the configured overlay with
    nothing in the URL — the room carries the look, the link only names it.
    """

    # Bounded because this route is exempt from the token gate: without a cap the
    # body is read and parsed in full before the handle regex rejects it, so the
    # only limit on what an unauthenticated caller sends is the server's.
    username: str = Field(default="", max_length=64)
    # Overlay styling to store on the room. The whitelist in clean_overlay
    # below is the only defence: it discards any key outside the known seven,
    # so an unauthenticated caller cannot smuggle arbitrary config in. Pydantic
    # still parses the full dict first (there is no depth/size limit on a
    # plain dict[str, Any]), but the parse result is thrown away.
    overlay: dict[str, Any] | None = None
    #: Platform to connect. Only "tiktok" is served.
    provider: str = "tiktok"


#: The overlay keys the app may store on a room, and nothing else. A connect body
#: is unauthenticated, so the styling it writes is whitelisted rather than taken
#: wholesale — a caller cannot use a connect to smuggle arbitrary config in.
OVERLAY_STORE_KEYS = (
    "overlaySize",
    "overlayNameColour",
    "overlayTextColour",
    "overlayBg",
    "overlayMax",
    "overlayDelay",
    "overlayFont",
)


def clean_overlay(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Only the known overlay keys, each coerced to the type the page expects."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key in OVERLAY_STORE_KEYS:
        if key not in raw or raw[key] is None:
            continue
        value = raw[key]
        if key in ("overlaySize", "overlayMax", "overlayDelay", "overlayBg"):
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)):
                out[key] = value
        else:  # the colour and font strings
            if isinstance(value, str) and len(value) <= 200:
                out[key] = value
    return out


#: The room-config keys that carry overlay styling, mapped to the names a page reads.
#: Wider than `OVERLAY_STORE_KEYS` on purpose: that tuple guards the unauthenticated
#: connect path and must stay narrow, while this one only renames keys on the way out
#: to a page that already knows them.
OVERLAY_STYLE_KEYS = {
    "overlaySize": "size",
    "overlayNameColour": "nameColour",
    "overlayTextColour": "textColour",
    "overlayBg": "background",
    "overlayMax": "max",
    "overlayDelay": "delay",
    "overlayFont": "font",
    "overlayPosition": "position",
    "overlayMaxWidth": "maxWidth",
    "overlayBubbleOpacity": "bubbleOpacity",
    "overlayGiftColour": "giftColour",
    # The board's heading. Added with the config route, when saving styling became
    # something the dashboard could do — see `page_config` for why this key is
    # absent from `OVERLAY_STORE_KEYS` above, which guards a different path.
    "overlayTitle": "title",
    # The cat's two knobs. Same path as `overlayTitle`: saved through the
    # authenticated config route, so not in the unauthenticated whitelist above.
    "catPalette": "pal",
    "catChonk": "chonk",
    # The likes target. Namespaced on both sides (`likeSize` and not `size`),
    # because the frame is one flat object and a shared key is one overlay
    # overwriting the other's styling.
    "likeTarget": "likeTarget",
    "likeTitle": "likeTitle",
    "likeSize": "likeSize",
    "likeBarColour": "likeBarColour",
    "likeTextColour": "likeTextColour",
    "likePosition": "likePosition",
}


def page_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """A room's stored config under the names a page reads.

    The store namespaces the overlay's settings — `overlaySize`, `overlayBg` — so
    that a room's config can hold more than styling and an unnamespaced `size` would
    be ambiguous. The page reads plain names. One translation between the two, used
    by every path that hands styling to a page.

    That is the whole point of this function: it used to exist only inside the HTML
    baker, so the WebSocket path sent the *stored* names while the HTML path sent the
    page's. A page asked to read `background` out of a frame carrying `overlayBg`
    gets nothing back and falls back to its defaults, so restyling a stream changed
    what OBS was pointed at without changing what OBS showed.

    It now lives here rather than beside the HTML routes because the backend no longer
    serves the pages. It was moved out of `routes/overlay.py` when that file went, and
    the WebSocket is the only thing left that needs it.
    """
    if not isinstance(config, dict):
        return {}
    out: dict[str, Any] = {}
    for room_key, page_key in OVERLAY_STYLE_KEYS.items():
        if room_key in config and config[room_key] is not None:
            out[page_key] = config[room_key]
    return out


class ConfigUpdateRequest(BaseModel):
    config: dict[str, Any]
    room_id: str | None = None


class TriggerRequest(BaseModel):
    """Fire an event by hand — the "alert now" path with no live room involved.

    Deliberately permissive on `kind`: the set of things a streamer can trigger
    should grow without a backend release, and an unrecognised kind is surfaced
    as an alert by `events.to_wire` rather than rejected.
    """

    kind: str = "alert"
    user: str = ""
    #: Stable per-user key, for widgets that keep state per viewer. Defaults to
    #: `user` so a caller that only knows a nickname still gets a key.
    user_id: str = ""
    text: str = ""
    title: str = ""
    icon: str = "★"
    #: Gift value and repeat count. Without these a triggered gift is worth
    #: nothing, which makes the reward thresholds a widget might key on
    #: impossible to exercise from the editor.
    diamonds: int = 0
    count: int = 1
    #: Membership length for a triggered `subscription`. The real event carries
    #: it, so a manual trigger without it renders as a nameless "membered" and
    #: the overlay's month line cannot be exercised from the editor at all.
    months: int = 0


class HookRequest(BaseModel):
    """External webhook body."""

    user: str = ""
    user_id: str = ""
    text: str = ""
    title: str = ""
    icon: str = "★"
    kind: str = "alert"
    amount: float | None = None


#: A compact room view returned to dashboards. Not a full record: `get_room`
#: hands back the stored dict as-is, because the editor wrote every field in it
#: and the backend should not be in the business of deciding which ones matter.
def summary(room_id: str, record: dict[str, Any]) -> dict[str, Any]:
    config = record.get("config", {})
    return {
        "id": room_id,
        "name": record.get("name", "Untitled"),
        "username": record.get("username", ""),
        "config": config,
        "createdAt": record.get("createdAt", 0),
        # Which platform this room reads. Defaulted rather than left absent so a
        # client never has to know that rooms predating the field were all
        # TikTok — the same rule `store.provider_of` applies server-side.
        "provider": record.get("provider") or "tiktok",
    }
