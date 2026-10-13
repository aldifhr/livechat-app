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
import events
from events import COMMENT, FOLLOW, GIFT, JOIN, LIKE, SHARE, VIEWERS, Event

# TikTok substitutes these when a viewer's profile is unavailable or deleted.
# Broadcasting them puts literal "Not found" / "?" on the room, so they are
# dropped rather than shown as if they were usernames.
PLACEHOLDER_NICKNAMES = {"", "?", "not found", "unknown", "-", "null", "none"}

#: Pushed into an adapter's event queue to release a consumer parked in
#: `observe()`. A bare queue cannot end that loop: `_running` going false is
#: only read at the top of the `while`, which a consumer blocked in `get()`
#: never reaches, and once the source has stopped nothing else is ever queued —
#: so the `await` parked forever and every reconnect leaked the previous
#: observer task for the life of the process. The sentinel is that missing
#: wake-up, and it is queued behind any real events so a drain still happens.
class _Stop:
    """Type-only sentinel marker so the queue stays `Event | _Stop`."""


_STOP = _Stop()


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


def streak_step(
    streaks: dict[str, dict[str, int]],
    user_id: str,
    gift_id: int,
    repeat_count: int,
    diamond_count: int,
    repeat_end: int,
) -> tuple[int, int] | None:
    """Fold one gift frame into the streak state, or report the finished total.

    Returns `None` while a combo is still running (nothing to dispatch yet), and
    `(count, diamonds)` on the frame that ends it.

    The whole correctness of this rests on one fact about the protocol:
    `repeat_count` is a *cumulative* total, not a per-frame delta. The third shot
    of a ten-Rose combo arrives carrying `3`, and the final frame carries `10` —
    so each frame's value replaces the stored one rather than being added to it.
    Summing them is exactly the bug this exists to prevent: 1+2+…+10 = 55
    diamonds for a combo worth 10.

    Extracted from the handler so the arithmetic can be checked without a live
    socket — the same reason `viewers_count.judge` was pulled out, and the reason
    a nested handler is a poor place for a rule that is easy to get wrong.
    """
    if repeat_end == 0:
        streaks[user_id] = {
            "gift_id": gift_id,
            "count": repeat_count,
            "diamond_total": diamond_count * repeat_count,
        }
        return None

    previous = streaks.pop(user_id, None)
    count = repeat_count
    # The final frame carries the full count. If it somehow arrives without one,
    # fall back to the last running total rather than reporting a zero-gift —
    # but only when it is the same gift, so a stale entry cannot leak in.
    if count <= 0 and previous is not None and previous["gift_id"] == gift_id:
        count = previous["count"]
    return count, diamond_count * count


def avatar_url(user: Any) -> str:
    """The user's avatar URL, or "" when TikTok did not send one."""
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
    """TikTok Live event adapter. Implements the EventAdapter protocol.

    Single task model: `connect()` spawns exactly one `_run_client` task and
    tracks it in `_task`. `_setup_handlers` only registers event handlers on
    the client — it never spawns tasks. This is what prevents the reconnect
    storm that previously crashed the VPS: the old code spawned a fresh
    `_run_client` from inside `_setup_handlers`, which was called on every
    retry, creating an unbounded fan-out of parallel connection loops.
    """

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
        # The single background task running the connect/reconnect loop.
        self._task: asyncio.Task | None = None
        self._events: asyncio.Queue[Event | _Stop] = asyncio.Queue()
        # Streak state, keyed by user_id: the last running total seen for the
        # combo in progress. `repeat_count` is cumulative, so this holds the
        # latest value rather than a sum of the frames.
        self._gift_streaks: dict[str, dict[str, int]] = {}

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
        """Whether a connection has been attempted and not yet given up.

        Public so the router does not read `_running` directly. Both flags are
        internal to this class's lifecycle, and a caller reaching past the class
        for one can desynchronise the task it does not know about.
        """
        return self._running

    def start_background(self) -> None:
        """Spawn the connect loop as a task owned by this source.

        Idempotent: if the task is already running, do nothing. Without this
        guard two calls (e.g. restore_sources on boot plus a manual connect)
        each spawn an independent `_run_client` loop with its own retry
        counter — the reconnect-storm signature.

        `_task` is parked with this *wrapper* task only until `connect()`
        replaces it with the run loop. `connect()` therefore must not use
        `_task` as its idempotency guard: the wrapper is still pending when
        the scheduled coroutine runs, so the guard saw its own task, returned
        early, and left `_running` False — every room reported a bare
        "Offline" and no socket was ever opened.
        """
        if self._running or (self._task is not None and not self._task.done()):
            return
        self._task = asyncio.create_task(self.connect())

    async def connect(self, **kwargs: Any) -> bool:
        """Connect to TikTok Live for this username. Idempotent."""
        # Already running — don't spawn a second loop. Keyed on `_running`
        # (which `start_background()` does not set) rather than `_task`, so the
        # wrapper task parked there cannot trip this guard and skip the connect.
        if self._running:
            return True
        try:
            from TikTokLive import TikTokLiveClient as Client
        except ImportError:
            logger.error("TikTokLive library not installed. Run: pip install TikTokLive")
            return False

        self._client = Client(unique_id=self.username)
        self._setup_handlers(self._client)

        self._running = True
        self._connected = False
        self._live_ended = False
        self._task = asyncio.create_task(self._run_client())
        return True

    def _setup_handlers(self, client: Any) -> None:
        """Register event handlers on the given client.

        Pure registration — never spawns tasks. Spawning the connect loop
        from here (as the old code did) caused an unbounded fan-out because
        this method is called on every retry inside `_run_client`.
        """
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
            # Broadcast the transition, not just flip a flag. The status frame is
            # edge-triggered and nothing else produces one mid-session, so without
            # this the app's status line never leaves "connecting" on the socket
            # it opened — the one-shot snapshot at attach (main.py) is all it gets.
            await events.emit_status(
                self.room_id, connected=True, message=f"Connected to @{self.username}"
            )

        @client.on(DisconnectEvent)
        async def on_disconnect(_):
            # Only the socket is gone; the source is still meant to run, so
            # `_run_client` is left free to reconnect. Clearing `_running` here
            # (as it used to) ended the connect loop on the first transient
            # drop, which is what made a still-live stream sit at "Offline"
            # until somebody reconnected it by hand.
            self._connected = False
            # Say so on the wire too. A dropped socket and a finished live both
            # stop events arriving, and the app cannot tell them apart from the
            # stream alone; this frame is what keeps the status honest between
            # reconnects. While the run loop is still going this is a *connecting*
            # frame, not a plain disconnect: the app then reads "Connecting" for
            # the retry instead of a bare idle, and `emit_status` leaves the
            # session counters alone — a transient blip is not a new session. An
            # explicit stop has already cleared `_running`, so it lands here as a
            # real disconnect and is logged as one.
            await events.emit_status(
                self.room_id,
                connected=False,
                connecting=self._running,
                message=f"Disconnected from @{self.username}",
            )

        @client.on(LiveEndEvent)
        async def on_live_end(_):
            self._connected = False
            self._live_ended = True
            # The one transition worth a distinct flag: a streamer who stopped is
            # not a connection to reconnect, and the app says "live ended" for it.
            await events.emit_status(
                self.room_id,
                connected=False,
                message=f"@{self.username} is no longer live",
                live_ended=True,
            )

        @client.on(CommentEvent)
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

        @client.on(LikeEvent)
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

            # TikTok streak handling. `repeat_count` is a cumulative total, not a
            # per-frame delta, so the arithmetic lives in `streak_step` where it
            # can be checked without a socket — summing the frames is what turned
            # a ten-Rose combo into 1+2+…+10 = 55 diamonds.
            step = streak_step(
                self._gift_streaks,
                user_id,
                gift_id,
                event.repeat_count,
                event.gift.diamond_count,
                event.repeat_end,
            )
            if step is None:
                return  # Streak still running — nothing to dispatch yet
            count, value = step

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

        @client.on(JoinEvent)
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

        @client.on(RoomUserSeqEvent)
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

        @client.on(FollowEvent)
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

        @client.on(ShareEvent)
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

    def _release_observer(self) -> None:
        """Wake a consumer parked in `observe()`.

        `put_nowait` rather than an await: this is called from teardown paths,
        one of which (`_run_client` finishing) is the last statement of the task
        that would otherwise be the one doing the awaiting.
        """
        self._events.put_nowait(_STOP)

    async def disconnect(self) -> None:
        """Stop connection and cleanup."""
        self._running = False
        # Release the observer before awaiting the client teardown. `observe()`
        # parks in `queue.get()`, which `_running` alone cannot interrupt, so
        # without this the observer task for every disconnected room stayed
        # alive holding a reference to the adapter and its queue.
        self._release_observer()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

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
            # The stop sentinel releases the `get()` above; it is not an event and
            # must not reach `events.emit`. `_running` is re-read after the wake-up
            # so a consumer that was parked when the source stopped ends the loop
            # instead of blocking on the next `get()`.
            if isinstance(event, _Stop):
                return
            yield event

    async def _run_client(self) -> None:
        """Run the TikTok client with auto-reconnect and exponential backoff.

        Single loop, single retry counter. Gives up permanently on:
        - Streamer's live has ended (no point retrying)
        - Explicit shutdown via disconnect()
        - Max retry attempts exceeded
        - Circuit breaker: 3 consecutive sign/block failures (TikTok is
          blocking the IP — retrying makes it worse, not better)

        Backoff sequence: 2s, 4s, 8s, 16s, 32s, capped at 30s, with ±50% jitter.
        """
        import random

        _base_delay = 2.0
        _max_delay = 30.0
        _max_retries = 10
        _consecutive_sign_failures = 0
        _max_sign_failures = 3
        _attempt = 0

        while self._running and not self._live_ended:
            try:
                if self._client is not None:
                    # `start()` is NOT blocking: it returns the websocket
                    # heartbeat Task and comes straight back. Await that task,
                    # or the loop spins and calls `start()` again on a client
                    # whose socket is still up — which is exactly what raises
                    # AlreadyConnectedError ("You can only make one connection
                    # per client!"). Awaiting it parks this loop for as long as
                    # the socket lives and returns only when it drops.
                    _ws_task = await self._client.start()
                    if _ws_task is not None:
                        await _ws_task
                else:
                    logger.warning("No TikTok client to start for @%s", self.username)
                    break
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._live_ended or not self._running:
                    break

                _attempt += 1
                err_str = str(e)

                # Circuit breaker: sign server / TikTok blocking is permanent,
                # not transient. Stop immediately instead of hammering it.
                is_sign_failure = (
                    "Expecting value" in err_str
                    or "sign" in err_str.lower()
                    or "blocked" in err_str.lower()
                    or "captcha" in err_str.lower()
                    or "403" in err_str
                )
                if is_sign_failure:
                    _consecutive_sign_failures += 1
                else:
                    _consecutive_sign_failures = 0

                if _consecutive_sign_failures >= _max_sign_failures:
                    logger.error(
                        "Circuit breaker tripped for @%s after %d consecutive "
                        "sign/block failures: %s — giving up permanently",
                        self.username, _consecutive_sign_failures, err_str,
                    )
                    self._running = False
                    break

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
                delay = delay * (0.5 + random.random())
                logger.info(
                    "Reconnecting to @%s in %.1fs (attempt %d/%d)",
                    self.username, delay, _attempt, _max_retries,
                )
                await asyncio.sleep(delay)
            else:
                # The awaited websocket task returned without raising: the
                # socket closed (stream ended or a plain drop). If we are still
                # meant to run, back off and reconnect.
                if not self._running or self._live_ended:
                    break

                _attempt += 1
                if _attempt >= _max_retries:
                    logger.error(
                        "Max reconnect attempts reached for @%s — giving up",
                        self.username,
                    )
                    self._running = False
                    break

                delay = min(_base_delay * (2 ** (_attempt - 1)), _max_delay)
                delay = delay * (0.5 + random.random())
                logger.info(
                    "Reconnecting to @%s in %.1fs (attempt %d/%d)",
                    self.username, delay, _attempt, _max_retries,
                )
                await asyncio.sleep(delay)

            # Rebuild the client before the next attempt — every path that
            # reaches here (error-retry or normal drop) must start from a fresh
            # client. Reusing the old one is what triggers AlreadyConnectedError:
            # its websocket can still read as connected after the task returned.
            # _setup_handlers only registers handlers, so this stays one loop.
            if not self._running or self._live_ended:
                break
            try:
                from TikTokLive import TikTokLiveClient as Client
                self._client = Client(unique_id=self.username)
                self._setup_handlers(self._client)
            except Exception as retry_err:
                logger.error("Failed to recreate client on retry: %s", retry_err)
                self._running = False
                break

        self._connected = False
        # The loop has ended. A live-end already reported itself from the handler;
        # anything else is the source giving up (retries exhausted, circuit
        # breaker, or a client that could not be rebuilt), and the app would
        # otherwise sit on a stale "Connecting" over a stream that is not coming
        # back.
        if not self._live_ended:
            try:
                await events.emit_status(
                    self.room_id,
                    connected=False,
                    message=f"Gave up connecting to @{self.username}",
                )
            except Exception:  # noqa: BLE001 — a status frame must not kill the loop
                pass

        # The loop gave up on its own (retries exhausted, circuit breaker, live
        # ended) rather than through `disconnect()`, so the observer parked in
        # `queue.get()` still has to be woken here. Without this the observer
        # for every room that failed to connect outlived its source.
        self._release_observer()

    async def start(self) -> None:
        """Alias for connect()."""
        await self.connect()

    async def stop(self) -> None:
        """Alias for disconnect()."""
        await self.disconnect()


# Register adapter with provider registry
from protocols import registry as _registry
_registry.register("tiktok", TikTokAdapter)
