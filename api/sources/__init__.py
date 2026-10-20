"""Source registry.

A source turns some outside thing — a live room, a button, an inbound HTTP
call — into normalised `events.Event` values. It must not import `hub` or know
what a WebSocket is; `events.emit` is the whole interface, and it does not
block (delivery is queued per client inside `hub`).
"""

from sources.tiktok import TikTokAdapter
from sources.youtube import YouTubeLiveAdapter

__all__ = ["TikTokAdapter", "YouTubeLiveAdapter"]
