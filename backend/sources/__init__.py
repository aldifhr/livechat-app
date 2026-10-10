"""Source registry.

A source turns some outside thing — a live room, a button, an inbound HTTP
call — into normalised `events.Event` values. It must not import `hub` or know
what a WebSocket is; `events.dispatch` is the whole interface.
"""

from sources.tiktok import TikTokSource

__all__ = ["TikTokSource"]
