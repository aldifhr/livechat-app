"""TikTok Live as an event source.

Extracted verbatim from the original single-file server: the connection
lifecycle, the idempotent-connect contract and the placeholder-nickname filter
all behave exactly as before. The only change is that handlers now emit
normalised events instead of building wire dicts inline.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from sources.viewers_count import judge
from events import COMMENT, FOLLOW, GIFT, JOIN, LIKE, SHARE, VIEWERS, Event, dispatch, emit_error, emit_status

# TikTok substitutes these when a viewer's profile is unavailable or deleted.
# Broadcasting them puts literal "Not found" / "?" on the overlay, so they are
# dropped rather than shown as if they were usernames.
PLACEHOLDER_NICKNAMES = {"", "?", "not found", "unknown", "-", "null", "none"}


def display_name(user: Any) -> str | None:
    """Return a nickname worth showing, or None if it is missing/placeholder."""
    if user is None:
        return None
    nickname = (getattr(user, "nickname", "") or "").strip()
    if nickname.lower() in PLACEHOLDER_NICKNAMES:
        return None
    return nickname


def display_id(user: Any) -> str:
    """TikTok's stable per-user handle, aliased to `username` by the lib.

    Falls back to the nickname so a widget that keys state per viewer still
    gets a key, just a less durable one.
    """
    if user is None:
        return ""
    return (getattr(user, "username", "") or "").strip()


logger = logging.getLogger("streamkit.tiktok")


class TikTokSource:
    def __init__(self, username: str, overlay_id: str) -> None:
        self.username = username
        self.overlay_id = overlay_id
        self._client = None
        # The previous audience figure, so an implausible jump can be called out
        # rather than silently driving the city's size.
        self._last_viewers = 0
        # _running means "a connection was attempted"; _connected means the
        # WebSocket handshake with TikTok actually completed. Reporting the
        # latter is what makes a newly-attached client's status honest.
        self._running = False
        self._connected = False
        self._task: asyncio.Task | None = None

    def status_payload(self) -> dict[str, Any]:
        if self._connected:
            return {
                "type": "status",
                "connected": True,
                "message": f"Connected to @{self.username}",
            }
        if self._running:
            return {
                "type": "status",
                "connected": False,
                "connecting": True,
                "message": f"Connecting to @{self.username}",
            }
        return {"type": "status", "connected": False, "message": "Offline"}

    def is_running(self) -> bool:
        """Whether a connection has been attempted.

        Public so the router does not read `_running` directly. Both flags are
        internal to this class's lifecycle, and a caller reaching past the class
        for one can desynchronise the task it does not know about.
        """
        return self._running

    def start_background(self) -> None:
        """Run `start()` as a task owned by this source, for `stop()` to cancel.

        Assigning `_task` from outside is the same reach-around this replaces:
        a task created elsewhere is a task `stop` may or may not know to cancel.
        """
        self._task = asyncio.create_task(self.start())

    async def start(self) -> None:
        try:
            from TikTokLive import TikTokLiveClient as Client
            from TikTokLive.events import (
                ConnectEvent,
                DisconnectEvent,
                CommentEvent,
                LikeEvent,
                GiftEvent,
                RoomUserSeqEvent,
                JoinEvent,
                FollowEvent,
                ShareEvent,
            )
        except ImportError:
            await emit_error(
                self.overlay_id,
                "TikTokLive library not installed. Run: pip install TikTokLive",
            )
            return

        self._client = Client(unique_id=self.username)
        self._running = True

        @self._client.on(ConnectEvent)
        async def on_connect(_):
            self._connected = True
            await emit_status(self.overlay_id, connected=True, message=f"Connected to @{self.username}")

        @self._client.on(DisconnectEvent)
        async def on_disconnect(_):
            self._running = False
            self._connected = False
            await emit_status(self.overlay_id, connected=False, message="Disconnected")

        @self._client.on(CommentEvent)
        async def on_comment(event):
            name = display_name(event.user)
            if not name:
                return
            dispatch(
                self.overlay_id,
                Event(
                    kind=COMMENT,
                    user=name,
                    user_id=display_id(event.user),
                    value=event.comment,
                ),
            )

        @self._client.on(LikeEvent)
        async def on_like(event):
            name = display_name(event.user)
            if not name:
                return
            dispatch(
                self.overlay_id,
                Event(
                    kind=LIKE,
                    user=name,
                    user_id=display_id(event.user),
                    meta={"count": event.count, "totalLikes": event.total},
                ),
            )

        @self._client.on(GiftEvent)
        async def on_gift(event):
            if event.gift is None:
                return
            name = display_name(event.user)
            if not name:
                return
            dispatch(
                self.overlay_id,
                Event(
                    kind=GIFT,
                    user=name,
                    user_id=display_id(event.user),
                    meta={
                        "giftName": event.gift.name or "Gift",
                        "count": event.repeat_count,
                        "value": event.gift.diamond_count * event.repeat_count,
                    },
                ),
            )

        # JoinEvent is sparse — TikTok batches member messages rather than
        # sending one per viewer — so treat it as a bonus, not a source of
        # truth for who is in the room.
        @self._client.on(JoinEvent)
        async def on_join(event):
            name = display_name(event.user)
            if not name:
                return
            dispatch(
                self.overlay_id,
                Event(
                    kind=JOIN,
                    user=name,
                    user_id=display_id(event.user),
                    meta={"viewers": event.member_count},
                ),
            )

        @self._client.on(RoomUserSeqEvent)
        async def on_viewers(event):
            # `total` is how many people are in the room now. `total_user` is how
            # many have been in it since the session began, and it only ever
            # climbs — measured live at 627,555 against 19,682 on `join`, 31.9
            # times apart, both rising. A city sized from a cumulative total reads
            # METROPOLIS within minutes of any stream starting and keeps climbing
            # for as long as it runs, which measures nothing.
            #
            # Only `count` goes out. `events._viewers` forwards that one field,
            # so sending the other three would mean carrying them this far to
            # drop them there, with nothing on either side reading them.
            # The decision — in range, implausible, a jump worth reporting —
            # lives in `viewers_count.judge`, because the handler is a nested
            # function and nothing could test it where it lived.
            verdict = judge(event.total, self._last_viewers, event.total_user)
            self._last_viewers = verdict.last
            if verdict.warning:
                logger.warning(verdict.warning)
            if verdict.count is None:
                return
            dispatch(self.overlay_id, Event(kind=VIEWERS, meta={"count": verdict.count}))

        # Social events are registered as the concrete subclasses rather than
        # SocialEvent: TikTokLive matches handlers on the emitted class, and a
        # parent-class handler would fire again for every follow and share.
        @self._client.on(FollowEvent)
        async def on_follow(event):
            name = display_name(event.user)
            if not name:
                return
            dispatch(
                self.overlay_id,
                Event(kind=FOLLOW, user=name, user_id=display_id(event.user)),
            )

        @self._client.on(ShareEvent)
        async def on_share(event):
            name = display_name(event.user)
            if not name:
                return
            # users_joined parses a display string and is None whenever that
            # string is absent, so it is optional rather than defaulted to 0.
            joined = event.users_joined
            dispatch(
                self.overlay_id,
                Event(
                    kind=SHARE,
                    user=name,
                    user_id=display_id(event.user),
                    meta={"count": joined} if joined else {},
                ),
            )

        try:
            await self._client.start()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self._running = False
            self._connected = False
            await emit_error(self.overlay_id, f"Connection failed: {e}")
        finally:
            self._connected = False
            await emit_status(self.overlay_id, connected=False, message="Disconnected")

    async def stop(self) -> None:
        self._running = False
        self._connected = False
        if self._client is not None:
            try:
                await asyncio.wait_for(self._client.disconnect(), timeout=5)
            except asyncio.TimeoutError:
                pass
            except Exception:
                pass
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._client = None
        self._task = None
