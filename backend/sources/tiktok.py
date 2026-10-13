"""TikTok Live as an event source.

Extracted verbatim from the original single-file server: the connection
lifecycle, the idempotent-connect contract and the placeholder-nickname filter
all behave exactly as before. The only change is that handlers now emit
normalised events instead of building wire dicts inline.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncGenerator

from protocols import EventAdapter
from sources.viewers_count import judge
from events import COMMENT, FOLLOW, GIFT, JOIN, LIKE, SHARE, VIEWERS, Event

# TikTok substitutes these when a viewer's profile is unavailable or deleted.
# Broadcasting them puts literal "Not found" / "?" on the room, so they are
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


def avatar_url(user: Any) -> str:
    """The user's avatar URL, or "" when TikTok did not send one.

    `avatar_thumb` is an ImageModel, not a list — a small protobuf message with
    a `url_list: list[str]` on it. Reading it as if the attribute were the list
    itself silently yields nothing, because iterating a protobuf message gives
    field names rather than URLs; that is why this goes through `url_list`
    explicitly. Confirmed against the installed library
    (TikTokLiveProto/v3/webcast/model/user.py:1354, base.ImageModel), not against
    the docs: the examples file describes it as an image and the wire type is a
    message, and getting that wrong produced an empty avatar on every frame
    while looking like correct code.

    Empty is the normal case and not a failure. TikTok populates this on comment
    events and leaves it empty or absent on join, follow, like and gift, so four
    of the six per-viewer kinds have no avatar and never will with this library.

    Tolerates every shape the events actually arrive in, and none of them
    raises: `user` is None on events that carry no user at all, `avatar_thumb` is
    None rather than an ImageModel on some of those, and `url_list` can be empty
    or hold empty strings. A helper that raised here would turn a missing avatar
    into a lost event, which is the wrong trade: a row with an initial is fine, a
    dropped comment is not.

    It does not guard against a `user` whose attribute access itself raises.
    That is not a shape TikTokLive produces, and handling it would mean a
    try/except around every field on the event to defend against a library
    bug — which would then hide that bug rather than report it.

    No fallback for a shape the library does not produce either: if a future
    version types this as a plain list, an empty avatar is the correct visible
    result and a silent second code path would hide the change.

    The URL is signed by TikTok (`x-expires`, `x-signature`) and stops working
    within hours. It is sent per event rather than remembered, so a client that
    holds one for a while will show a broken image and no amount of retrying
    will bring it back — that is the platform's design, not a bug here.
    """
    if user is None:
        return ""
    thumb = getattr(user, "avatar_thumb", None)
    if thumb is None:
        return ""
    urls = getattr(thumb, "url_list", None)
    if not isinstance(urls, (list, tuple)):
        return ""
    for entry in urls:
        if isinstance(entry, str) and entry.strip():
            return entry.strip()
    return ""


logger = logging.getLogger("streamkit.tiktok")


class TikTokAdapter(EventAdapter):
    """TikTok Live event adapter. Implements the EventAdapter protocol."""

    provider = "tiktok"

    def __init__(self, username: str, room_id: str) -> None:
        self.username = username
        self.room_id = room_id
        self._client = None
        # The previous audience figure, so an implausible jump can be called out
        # rather than silently driving the city's size.
        self._last_viewers = 0
        # _running means "a connection was attempted"; _connected means the
        # WebSocket handshake with TikTok actually completed. Reporting the
        # latter is what makes a newly-attached client's status honest.
        self._running = False
        self._connected = False
        # Whether the streamer stopped rather than the connection failing. Kept
        # separately from `_running` because that one means "a connection was
        # attempted" and the router reads it, so overloading it here would let a
        # new connect replace this object while its teardown is still running.
        self._live_ended = False
        self._task: asyncio.Task | None = None
        self._events: asyncio.Queue[Event] = asyncio.Queue()
        self._event_task: asyncio.Task | None = None
        # Streak accumulation: user_id -> {gift_id, count, diamond_total}
        self._gift_streaks: dict[str, dict[str, int]] = {}
        # Guard: don't create duplicate _run_client tasks
        self._reconnect_task: asyncio.Task | None = None

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
        # A client attaching after the live already ended gets the same honest
        # answer as one that was there when it happened, rather than a bare
        # "Offline" that is indistinguishable from never-connected.
        if self._live_ended:
            return {
                "type": "status",
                "connected": False,
                "message": f"@{self.username} is no longer live",
                "liveEnded": True,
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

    async def connect(self, **kwargs: Any) -> bool:
        """Connect to TikTok Live for this username."""
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
                LiveEndEvent,
            )
        except ImportError:
            logger.error("TikTokLive library not installed. Run: pip install TikTokLive")
            return False

        self._client = Client(unique_id=self.username)
        self._setup_handlers(self._client)

        self._running = True
        self._connected = False
        self._live_ended = False
        self._attempt = 0
        # Cancel any existing reconnect task before creating new one
        if self._reconnect_task is not None and not self._reconnect_task.done():
            self._reconnect_task.cancel()
            try:
                await self._reconnect_task
            except asyncio.CancelledError:
                pass
        self._reconnect_task = asyncio.create_task(self._run_client())
        return True

    def _setup_handlers(self, client: Any) -> None:
        """Register all TikTokLive event handlers on the given client."""
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
            LiveEndEvent,
        )

        @client.on(ConnectEvent)
        async def on_connect(_):
            self._connected = True

        @client.on(DisconnectEvent)
        async def on_disconnect(_):
            self._running = False
            self._connected = False

        @client.on(LiveEndEvent)
        async def on_live_end(_):
            self._connected = False
            self._live_ended = True

        @self._client.on(CommentEvent)
        async def on_comment(event):
            name = display_name(event.user)
            if not name:
                return
            await self._events.put(Event(
                kind=COMMENT,
                user=name,
                user_id=display_id(event.user),
                avatar=avatar_url(event.user),
                value=event.comment,
            ))

        @self._client.on(LikeEvent)
        async def on_like(event):
            name = display_name(event.user)
            if not name:
                return
            await self._events.put(Event(
                kind=LIKE,
                user=name,
                user_id=display_id(event.user),
                avatar=avatar_url(event.user),
                meta={"count": event.count, "totalLikes": event.total},
            ))

        @client.on(GiftEvent)
        async def on_gift(event):
            if event.gift is None:
                return
            name = display_name(event.user)
            if not name:
                return
            user_id = display_id(event.user)
            gift_id = event.gift.gift_id or 0

            # TikTok streak handling: repeat_end=0 means streak ongoing,
            # repeat_end=1 means streak just finished. Accumulate diamonds
            # during streak, dispatch total when repeat_end=1.
            if event.repeat_end == 0:
                # Streak in progress — accumulate
                streak = self._gift_streaks.get(user_id)
                if streak is None or streak["gift_id"] != gift_id:
                    self._gift_streaks[user_id] = {
                        "gift_id": gift_id,
                        "count": event.repeat_count,
                        "diamond_total": event.gift.diamond_count * event.repeat_count,
                    }
                else:
                    streak["count"] += event.repeat_count
                    streak["diamond_total"] += event.gift.diamond_count * event.repeat_count
                return  # Don't dispatch yet

            # repeat_end == 1 — streak finished (or single gift)
            streak = self._gift_streaks.pop(user_id, None)
            if streak and streak["gift_id"] == gift_id:
                count = streak["count"]
                value = streak["diamond_total"]
            else:
                count = event.repeat_count
                value = event.gift.diamond_count * event.repeat_count

            await self._events.put(Event(
                kind=GIFT,
                user=name,
                user_id=user_id,
                avatar=avatar_url(event.user),
                meta={
                    "giftName": event.gift.name or "Gift",
                    "count": count,
                    "value": value,
                    "repeatEnd": event.repeat_end,
                    "streak": event.streaking if hasattr(event, "streaking") else False,
                },
            ))

        @self._client.on(JoinEvent)
        async def on_join(event):
            name = display_name(event.user)
            if not name:
                return
            await self._events.put(Event(
                kind=JOIN,
                user=name,
                user_id=display_id(event.user),
                avatar=avatar_url(event.user),
                meta={"viewers": event.member_count},
            ))

        @self._client.on(RoomUserSeqEvent)
        async def on_viewers(event):
            verdict = judge(event.total, self._last_viewers, event.total_user)
            self._last_viewers = verdict.last
            if verdict.warning:
                logger.warning(verdict.warning)
            if verdict.count is not None:
                await self._events.put(Event(
                    kind=VIEWERS,
                    meta={"count": verdict.count},
                ))

        @self._client.on(FollowEvent)
        async def on_follow(event):
            name = display_name(event.user)
            if not name:
                return
            await self._events.put(Event(
                kind=FOLLOW,
                user=name,
                user_id=display_id(event.user),
                avatar=avatar_url(event.user),
            ))

        @self._client.on(ShareEvent)
        async def on_share(event):
            name = display_name(event.user)
            if not name:
                return
            joined = event.users_joined
            await self._events.put(Event(
                kind=SHARE,
                user=name,
                user_id=display_id(event.user),
                avatar=avatar_url(event.user),
                meta={"count": joined} if joined else {},
            ))

        self._running = True
        self._connected = False
        self._live_ended = False
        self._event_task = asyncio.create_task(self._run_client())
        return True

    async def disconnect(self) -> None:
        """Stop connection and cleanup."""
        self._running = False
        if self._event_task:
            self._event_task.cancel()
            try:
                await self._event_task
            except asyncio.CancelledError:
                pass
            self._event_task = None

        if self._client is not None:
            try:
                await asyncio.wait_for(self._client.disconnect(), timeout=5)
            except (asyncio.TimeoutError, Exception):
                pass
            self._client = None

        self._connected = False
        self._live_ended = False
        self._gift_streaks.clear()

    async def observe(self) -> AsyncGenerator[Event, None]:
        """Yield normalized events from TikTok Live stream."""
        while self._running or not self._events.empty():
            event = await self._events.get()
            yield event

    async def _run_client(self) -> None:
        """Run the TikTok client with auto-reconnect and exponential backoff.

        Reconnects on transient failures but gives up permanently on:
        - Streamer's live has ended (no point retrying)
        - Explicit shutdown via disconnect()
        - Max retry attempts exceeded

        Backoff sequence: 2s, 4s, 8s, 16s, 32s, capped at 30s.
        Max retries: 10 attempts before giving up.
        Includes jitter to prevent thundering herd on multi-room reconnect.
        """
        import random

        _max_retries = getattr(self, "_attempt", 0)  # inherit from connect
        _base_delay = 2.0
        _max_delay = 30.0
        _max_retries = 10
        _attempt = 0

        while self._running and not self._live_ended:
            try:
                if self._client is not None:
                    await self._client.start()
                else:
                    logger.warning("No TikTok client to start for @%s", self.username)
                    break
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._live_ended or not self._running:
                    break
                _attempt += 1
                logger.warning(
                    "TikTok connection failed for @%s (attempt %d/%d): %s",
                    self.username, _attempt, _max_retries, e,
                )
                if _attempt >= _max_retries:
                    logger.error(
                        "Max reconnect attempts reached for @%s — giving up",
                        self.username,
                    )
                    self._running = False
                    break

                delay = min(_base_delay * (2 ** (_attempt - 1)), _max_delay)
                # Add jitter (±50%) to prevent thundering herd
                delay = delay * (0.5 + random.random())
                logger.info(
                    "Reconnecting to @%s in %.1fs", self.username, delay,
                )
                await asyncio.sleep(delay)
                # Re-create client on retry
                try:
                    from TikTokLive import TikTokLiveClient as Client
                    self._client = Client(unique_id=self.username)
                    self._setup_handlers(self._client)
                except Exception as retry_err:
                    logger.error("Failed to recreate client on retry: %s", retry_err)
                    self._running = False
                    break
            else:
                # Connection ended normally (not via exception)
                break

        self._connected = False

    def _register_handlers(self) -> None:
        """Register event handlers on current client."""
        # Use _setup_handlers instead — kept for backward compat
        if self._client is not None:
            self._setup_handlers(self._client)

    # --- Backward compatibility helpers ---

    def start_background(self) -> None:
        """Run connect() as a task owned by this adapter."""
        self._task = asyncio.create_task(self.connect())

    async def start(self) -> None:
        """Legacy alias for connect()."""
        await self.connect()

    async def stop(self) -> None:
        """Legacy alias for disconnect()."""
        await self.disconnect()
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None


# Register adapter with provider registry
from protocols import registry as _registry
_registry.register("tiktok", TikTokAdapter)
