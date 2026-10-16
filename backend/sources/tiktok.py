"""TikTok Live as an event source.

Extracted verbatim from the original single-file server: the connection
lifecycle, the idempotent-connect contract and the placeholder-nickname filter
all behave exactly as before. The only change is that handlers now emit
normalised events instead of building wire dicts inline.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, AsyncGenerator

from protocols import EventAdapter
from sources.viewers_count import judge
import alerts
import events
from events import COMMENT, FOLLOW, GIFT, JOIN, LIKE, SHARE, VIEWERS, Event

# TikTok substitutes these when a viewer's profile is unavailable or deleted.
# Broadcasting them puts literal "Not found" / "?" on the room, so they are
# dropped rather than shown as if they were usernames.
PLACEHOLDER_NICKNAMES = {"", "?", "not found", "unknown", "-", "null", "none"}

#: How many custom emotes one comment may carry into the feed. TikTok sends a
#: list and the renderer draws every entry, so an unbounded list is unbounded work
#: on a frame from an unauthenticated socket. A real message holds a handful.
MAX_EMOTES_PER_MESSAGE = 12

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


def _mention_handle(user: Any) -> str:
    """The @-handle of a mentioned user, whichever field the lib filled in.

    `mention_users` is typed as raw proto `User` objects, which carry the handle
    as `display_id`; `at_user` is an `ExtendedUser`, which aliases the same value
    to `username`. Reading both means neither shape is silently empty — and the
    whole reason mentions are read here rather than scanned out of the text is
    that a handle is exact, whereas `@name` cannot even be typed for a display
    name that contains a space.
    """
    for attr in ("username", "display_id"):
        value = getattr(user, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def mention_handles(event: Any) -> list[str]:
    """The handles a comment is addressed to, as TikTok reported them.

    Taken from the event's own mention list rather than by scanning the text: the
    proto carries the handles the sender actually picked, so there is no guessing
    about case or a leading `@`, and a mention of a display name with a space is
    still caught. A light scan of the text is the fallback for a frame that
    leaves the list empty — the same rule the overlay has always used, kept so a
    mention is never lost just because the list arrived blank.
    """
    handles: list[str] = []
    for user in getattr(event, "mention_users", None) or []:
        handle = _mention_handle(user)
        if handle and handle not in handles:
            handles.append(handle)
    at_user = getattr(event, "at_user", None)
    if at_user is not None:
        handle = _mention_handle(at_user)
        if handle and handle not in handles:
            handles.append(handle)
    if not handles:
        handles = re.findall(r"@([A-Za-z0-9._]{1,24})", getattr(event, "comment", "") or "")
    return handles


def is_moderator(user: Any) -> bool:
    """Whether TikTok marks this user as a moderator of the room.

    Read straight off the proto (`ExtendedUser.is_moderator`). The app has drawn a
    MOD badge for this since it had a feed, but nothing ever set the field, so the
    badge could not appear — the data was in the frame the whole time.
    """
    return bool(getattr(user, "is_moderator", False))


def emotes_in(event: Any) -> list[dict[str, str]]:
    """The custom emotes a comment contains, as `{url, id}` in reading order.

    TikTok sends these as a list of `{index, emote}` rather than inline in the
    text, so the picture has to be carried separately from the message. Only
    emotes with a usable image URL are returned: an entry with no URL would be a
    broken image in the feed, which is worse than the text it replaces.

    Bounded, because this is user data arriving on an unauthenticated socket and
    the renderer draws every entry it is given.
    """
    out: list[dict[str, str]] = []
    for item in getattr(event, "emotes", None) or []:
        emote = getattr(item, "emote", None)
        if emote is None:
            continue
        urls = getattr(getattr(emote, "image", None), "url_list", None) or []
        url = next((u for u in urls if isinstance(u, str) and u.strip()), "")
        if not url:
            continue
        out.append({"url": url.strip(), "id": str(getattr(emote, "emote_id", "") or "")})
        if len(out) >= MAX_EMOTES_PER_MESSAGE:
            break
    return out


#: How many gift combos may be in progress at once before the smallest is dropped.
#:
#: A combo occupies one entry from its first frame until the frame that ends it, and
#: nothing else removes it. Realistically a handful are running at any moment, so
#: this is far above the truth and exists only so that viewers who walk away
#: mid-combo — a disconnect, a reload, the stream ending — cannot leave an entry
#: behind for the life of the source.
MAX_OPEN_STREAKS = 2000


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
        if user_id not in streaks and len(streaks) >= MAX_OPEN_STREAKS:
            # The smallest running combo goes. Every entry here is a combo that
            # started and has not ended, and nothing removes one but its own final
            # frame — so a viewer whose combo is cut off by a disconnect, or a
            # reload, or the stream ending, leaves an entry behind for the life of
            # the source. Over a long stream that is one dict entry per person who
            # ever sent a gift and walked away mid-combo.
            #
            # Safe to drop, because `repeat_count` is cumulative: the next frame for
            # that viewer recreates the entry with the right total on its own. The
            # only thing lost is the fallback for a final frame that arrives with a
            # count of zero, and that is the narrow case the branch below already
            # guards for a viewer who was never here at all.
            weakest = min(streaks, key=lambda existing: streaks[existing]["count"])
            streaks.pop(weakest, None)
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


def first_url(image: Any) -> str:
    """The first usable URL in an `ImageModel`, or "" when there is none.

    `ImageModel.url_list` is a list of the same picture at different sizes and
    TikTok does not promise it is non-empty — so an absent or blank entry has to
    read as "no picture" rather than as a broken image in the feed.
    """
    urls = getattr(image, "url_list", None)
    if not isinstance(urls, (list, tuple)):
        return ""
    for entry in urls:
        if isinstance(entry, str) and entry.strip():
            return entry.strip()
    return ""


def gift_image_url(event: Any) -> str:
    """The gift's picture, or "" when TikTok did not send one.

    The app has drawn `item.giftImage` since it had a feed and nothing ever set
    it, so the image slot stayed empty for every gift. `event.gift.image` is the
    field; `gift_image` is a legacy alias for the same thing, kept for the
    versions that spell it that way.
    """
    gift = getattr(event, "gift", None)
    if gift is None:
        return ""
    image = getattr(gift, "image", None) or getattr(gift, "gift_image", None)
    return first_url(image)


logger = logging.getLogger("streamkit.tiktok")

#: How often we ask TikTok whether a streamer who stopped has come back.
#:
#: A poll rather than a socket, because the old room is gone: the streamer starts
#: a new live with a new room id, so there is nothing left to reconnect *to*. The
#: only way to learn about the new one is to ask.
_LIVE_POLL_INTERVAL = 60.0

#: How many times that question is worth asking — 120 polls at a minute each is
#: two hours.
#:
#: Counted rather than measured against the clock, and deliberately: the budget is
#: really "how many requests are we willing to spend on this", and a count says
#: that directly. It is also what makes the wait testable — a wall-clock budget
#: checked against `time.monotonic()` does not move when a test shortens the
#: sleeps, so the loop would spin without ever expiring.
#:
#: Two hours, because the case this exists for is a streamer taking a break — not
#: a channel watched around the clock. Past it the source gives up for real, and
#: pressing Connect is the deliberate act it should be. The cost of the whole
#: window is one request a minute, which is less traffic than the socket it
#: replaced was generating every second.
_LIVE_WAIT_POLLS = 120


def _is_offline_error(exc: BaseException) -> bool:
    """Whether this exception means "there is no live to read", not "we failed".

    The two need opposite responses and used to get the same one. A network
    failure is worth retrying — that is what the backoff budget is for. A streamer
    who is not live is not a failure at all: retrying cannot change it, and the
    budget spent on it is budget the source no longer has when TikTok actually
    blocks us.

    Measured on the real thing: `@itswyss` was offline, and the loop spent ten
    attempts and about two minutes of backoff (2s, 4s, 8s … 30s) rediscovering
    that, with the app reading "Connecting" the whole time. At the end of it the
    source gave up for good — so when that streamer did start, nothing picked the
    live up and the room stayed dead until somebody pressed Connect.

    Matched on the class rather than the message where the class is available,
    because TikTokLive raises `UserOfflineError` with a plain sentence and a
    substring test would also catch a reworded unrelated error. The message test
    is the fallback for a wrapped or re-raised error, where the type is lost and
    the sentence is all that survives.
    """
    try:
        from TikTokLive.client.errors import UserNotFoundError, UserOfflineError

        if isinstance(exc, (UserOfflineError, UserNotFoundError)):
            return True
    except ImportError:
        # The library is optional at import time elsewhere in this file, so a
        # missing module must not turn a real failure into an "offline".
        pass

    text = str(exc).lower()
    return "userofflineerror" in text or "is offline" in text


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
        # Failed reconnects since the last successful connect. Lives on the
        # instance, not in `_run_client`'s frame, so `on_connect` can clear it:
        # the budget bounds *consecutive* failures, and a local counter counted
        # every drop over the life of the source instead.
        self._attempt = 0
        # The same for the circuit breaker's streak, and for the same reason:
        # three sign failures in a row is the signal, not three ever.
        self._consecutive_sign_failures = 0
        # The single background task running the connect/reconnect loop.
        self._task: asyncio.Task | None = None
        self._events: asyncio.Queue[Event | _Stop] = asyncio.Queue()
        # Streak state, keyed by user_id: the last running total seen for the
        # combo in progress. `repeat_count` is cumulative, so this holds the
        # latest value rather than a sum of the frames.
        self._gift_streaks: dict[str, dict[str, int]] = {}
        # Whether we are waiting for a streamer who stopped to come back.
        #
        # `_live_ended` on its own used to be terminal: the connect loop's
        # condition is `while self._running and not self._live_ended`, so a live
        # ending ended the source for good and only a manual connect brought it
        # back. That is wrong for the common case — a streamer who stops and
        # starts again a few minutes later, on a new room id — and the app shows
        # "no longer live" through a stream that is on the air. This flag is what
        # separates "the live is over" from "we have stopped watching for it".
        self._awaiting_live = False
        # The streamer simply has no live stream right now — as opposed to one
        # that ended. Kept apart from `_live_ended` because the two need different
        # words: "is no longer live" is false about a streamer who has not started
        # yet, and this codebase treats a status line that says something untrue
        # as a bug rather than a wording choice.
        #
        # It also keeps the retry budget honest. An offline error is not a
        # failure, so it must not be counted as one — see `_is_offline_error`.
        self._offline_waiting = False
        # Set by `disconnect()` so the wait loop stops immediately instead of
        # sitting out its remaining interval after the user pressed Stop.
        self._stopping = False

    def status_payload(self) -> dict[str, Any]:
        # The live ending is checked first, and deliberately. `on_live_end` sets
        # `_live_ended` while `_running` is still true (the connect loop has not
        # unwound yet), so with the running check ahead of this one a client
        # attaching in that window was told "Connecting" over a stream that had
        # already finished.
        #
        # But an ended live is not always the end of watching. The source waits for
        # the streamer to start again — up to two hours — and `_awaiting_live` is
        # set for exactly that window. Reporting a bare `liveEnded` through it was
        # the same trap the offline case had: the app showed "Connect" for a source
        # that is still running and will pick the stream up on its own, and the
        # wait could not be called off from the UI. `waiting` is what gives it a
        # Stop, so it is carried whenever a wait is actually in progress.
        if self._live_ended:
            payload: dict[str, Any] = {
                "type": "status",
                "connected": False,
                "message": f"@{self.username} is no longer live",
                "liveEnded": True,
            }
            if self._awaiting_live and self._running:
                # Both flags: `liveEnded` so the client says the live ended rather
                # than reconnecting, and `waiting` so it offers a way out instead
                # of a dead end.
                payload["connecting"] = True
                payload["waiting"] = True
            return payload
        if self._connected:
            return {
                "type": "status",
                "connected": True,
                "message": f"Connected to @{self.username}",
                # The headcount, so a client that attaches mid-stream has it
                # without waiting for the next `RoomUserSeqEvent`. That event is
                # edge-triggered and a quiet room can go a long while between
                # reports, so the Overview page — which reads this endpoint rather
                # than the socket — otherwise showed nothing to begin with.
                #
                # `_last_viewers` is the value `judge()` accepted, not the raw
                # field: an out-of-range count is dropped before it is stored, so
                # this cannot put an implausible figure in front of anyone.
                "viewers": self._last_viewers,
            }
        # Not connected and not trying to be: we are waiting for the streamer to
        # go live. Checked before the `_running` branch because `_running` stays
        # true across the wait, and reporting "Connecting" for up to two hours of
        # polling is the false statement this exists to avoid — the app showed
        # exactly that for two minutes while the old code burned its retry budget
        # on an offline streamer.
        #
        # No `liveEnded`: this streamer has not been live, so nothing has ended.
        # `connecting` is carried so the client keeps waiting rather than reading
        # it as a disconnect, and the message names the wait because a status that
        # just says "Offline" invites somebody to press Connect again.
        if self._offline_waiting:
            return {
                "type": "status",
                "connected": False,
                "connecting": True,
                # Its own flag, so the app can offer a way out. `connecting` alone
                # drives a disabled "Connecting…" button, and this wait can last
                # two hours — a state the user cannot leave is not a state, it is a
                # trap. The app shows "Waiting" with a working Stop instead.
                "waiting": True,
                "message": f"@{self.username} is not live — waiting",
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
        return {"type": "status", "connected": False, "message": "Offline"}

    def is_running(self) -> bool:
        """Whether a connection has been attempted and not yet given up.

        Public so the router does not read `_running` directly. Both flags are
        internal to this class's lifecycle, and a caller reaching past the class
        for one can desynchronise the task it does not know about.
        """
        return self._running

    def is_connected(self) -> bool:
        """Whether a live stream is being read right now.

        Public for the same reason as `is_running`: callers that need the
        connection state must go through the accessor, not read `_connected`
        directly.
        """
        return self._connected

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
        # Cleared with `_live_ended`: both describe the session that ended, and a
        # fresh connect is a fresh session. Left set, the status of a source that
        # has just been told to connect would read "not live — waiting" before it
        # had made a single attempt — a Stop during a wait, then Connect, and the
        # app shows a wait that has not begun.
        self._offline_waiting = False
        # A fresh connect is a fresh intent to run. Without this a source that was
        # stopped and started again would carry the previous Stop into its new
        # live-wait loop and refuse to wait.
        self._stopping = False
        # A fresh connect starts a fresh retry budget. `_run_client` reads this
        # instance counter (cleared again by `on_connect`), so it must begin at
        # zero rather than carrying a previous session's spent attempts.
        self._attempt = 0
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
            # Whether this connection followed a failure, read *before* the resets
            # below — one of the things that says "this is a recovery" is the retry
            # counter, and clearing it first would make every reconnect look like a
            # first connect. A room coming back on its own after a blip is exactly
            # what an operator walked away from the screen for; the first connect of
            # a session is not news, because they pressed Connect and watched it.
            recovered = self._live_ended or self._offline_waiting or self._attempt > 0
            # A completed handshake is what "consecutive" counts from: the retry
            # budget exists to survive a run of failures, and a connection that
            # came up is proof the last run ended. Without this reset the budget
            # was spent over the life of the source, so a long stream that
            # blipped ten times in an evening ended permanently on the tenth.
            self._attempt = 0
            # Same reasoning for the circuit breaker: a successful handshake
            # means TikTok is not blocking us, so the streak is over.
            self._consecutive_sign_failures = 0
            # Broadcast the transition, not just flip a flag. The status frame is
            # edge-triggered and nothing else produces one mid-session, so without
            # this the app's status line never leaves "connecting" on the socket
            # it opened — the one-shot snapshot at attach (main.py) is all it gets.
            await events.emit_status(
                self.room_id, connected=True, message=f"Connected to @{self.username}"
            )
            if recovered:
                alerts.notify_soon(
                    alerts.STREAM_BACK,
                    self.room_id,
                    self.username,
                    "the stream is being read again",
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
            # With the session's own numbers attached, because that is the useful
            # part: a stream that ran three hours and one that never started should
            # not read the same. Read before the wait, so the summary is of the
            # stream that just finished rather than of whatever comes next.
            alerts.notify_soon(
                alerts.LIVE_ENDED,
                self.room_id,
                self.username,
                alerts.describe(self.room_id),
            )

        @client.on(CommentEvent)
        async def on_comment(event):
            name = display_name(event.user)
            if not name:
                return
            # `moderator` and `emotes` are carried on the comment only when they
            # are true/present, so an ordinary message's frame stays byte-for-byte
            # what it was — the same rule `mentions` follows.
            meta: dict[str, Any] = {"mentions": mention_handles(event)}
            if is_moderator(event.user):
                meta["moderator"] = True
            emotes = emotes_in(event)
            if emotes:
                meta["emotes"] = emotes
            await self._events.put(Event(
                kind=COMMENT,
                user=name,
                user_id=display_id(event.user),
                avatar=avatar_url(event.user),
                value=event.comment,
                # The handles this message is addressed to, so the feed can
                # highlight it, the mention alert can fire and the voice can say
                # who was called. Empty for the ordinary comment.
                meta=meta,
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
            # `event.gift` is an ExtendedGift, whose id field is `id` — only the
            # EVENT has a `gift_id`. Reading `event.gift.gift_id` raised
            # AttributeError inside this handler on every gift, so the room
            # received none at all while the log filled with tracebacks. Read
            # defensively: a library upgrade renaming a field should degrade the
            # id, not silence every gift.
            gift_id = getattr(event.gift, "id", None) or getattr(event, "gift_id", 0) or 0

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
                    # Carried only when TikTok sent one, so a gift with no picture
                    # keeps the frame it had and the feed falls back to the name.
                    **({"giftImage": img} if (img := gift_image_url(event)) else {}),
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
        # Tells the live-wait loop to stop now rather than sitting out the rest of
        # its poll interval. Stop means stop; the user pressing it should not have
        # to wait up to a minute for the next tick to notice.
        self._stopping = True
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
            except Exception as exc:  # noqa: BLE001 — a teardown must not inherit this
                # The connect loop ended by raising rather than by being cancelled.
                # Only `CancelledError` was caught here, so a loop that died on an
                # exception re-raised it straight through `stop()` — and `stop()` is
                # what the delete, disconnect and replace paths all await, after the
                # thing they were asked to do has already happened. The room was off
                # disk and the source out of the map either way, so the operator was
                # told their delete had failed, the dashboard showed it refused, and
                # the room was gone on the next refresh.
                #
                # Logged rather than swallowed: a connect loop that ends on an
                # exception is worth knowing about, and the loop logs its own
                # failure too, so this is the second mention rather than the only one.
                logger.warning(
                    "connect loop for @%s ended with %s: %s",
                    self.username,
                    type(exc).__name__,
                    exc,
                )
            self._task = None

        if self._client is not None:
            try:
                await asyncio.wait_for(self._client.disconnect(), timeout=5)
            except (asyncio.TimeoutError, Exception):
                pass
            self._client = None

        self._connected = False
        self._live_ended = False
        # Cleared with the others. Left set, the next `status_payload()` on this
        # object claims the streamer is not live before the new connect has even
        # tried — a Stop during a wait followed by Connect showed "not live —
        # waiting" over an attempt that had not started. The two flags describe
        # the session that just ended, and a teardown is where that session stops
        # being current.
        self._offline_waiting = False
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
        _max_sign_failures = 3

        # Outer loop: one pass is one session. A live that ends and comes back is
        # a *new* session — a new room id, a new socket — so it cannot be handled
        # inside the inner loop, whose condition is already false by then. This is
        # what turns "the live ended" from a terminal state into a pause.
        while self._running:
            # Both counters live on the instance, not in this frame, so `on_connect`
            # can clear them. The budget and the circuit breaker both promise to
            # bound *consecutive* failures; frame-local counters instead accumulated
            # every failure over the life of the source, so a long stream that
            # blipped now and then eventually spent a budget it had already earned
            # back by connecting.
            self._attempt = 0
            self._consecutive_sign_failures = 0

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

                    # "There is no live to read" is not a failure, so it must not
                    # spend the retry budget. It is also not something retrying can
                    # fix: the answer will be the same until the streamer starts.
                    # Treated exactly like a live that ended — a pause, handled by
                    # the same wait — because from the room's point of view the two
                    # are the same situation, and the wait is what brings the
                    # source back on its own instead of dying until someone
                    # notices and presses Connect.
                    #
                    # Measured before this: `@itswyss` offline, ten attempts and
                    # about two minutes of backoff, the app reading "Connecting"
                    # throughout, and then the source gave up permanently — so the
                    # stream that came later was never picked up at all.
                    if _is_offline_error(e):
                        logger.info(
                            "@%s has no live stream right now — watching for it to start: %s",
                            self.username, e,
                        )
                        self._offline_waiting = True
                        self._attempt = 0
                        # Told before the wait, so a client already attached stops
                        # reading "Connecting" now rather than at the first poll a
                        # minute from now.
                        try:
                            await events.emit_status(
                                self.room_id,
                                connected=False,
                                connecting=True,
                                waiting=True,
                                message=f"@{self.username} is not live — waiting",
                            )
                        except Exception as emit_err:  # noqa: BLE001 — a status frame must not stop the wait
                            logger.debug(
                                "Could not announce @%s being offline: %s", self.username, emit_err
                            )
                        # The wait itself is the outer loop's job, below: it owns
                        # the "one wait per session, and stop when the budget is
                        # spent" rule, and doing it here as well would wait twice.
                        break

                    self._attempt += 1
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
                        self._consecutive_sign_failures += 1
                    else:
                        self._consecutive_sign_failures = 0

                    if self._consecutive_sign_failures >= _max_sign_failures:
                        logger.error(
                            "Circuit breaker tripped for @%s after %d consecutive "
                            "sign/block failures: %s — giving up permanently",
                            self.username, self._consecutive_sign_failures, err_str,
                        )
                        self._running = False
                        break

                    logger.warning(
                        "TikTok connection failed for @%s (attempt %d/%d): %s",
                        self.username, self._attempt, _max_retries, e,
                    )
                    if self._attempt >= _max_retries:
                        logger.error(
                            "Max reconnect attempts reached for @%s — giving up",
                            self.username,
                        )
                        self._running = False
                        break

                    delay = min(_base_delay * (2 ** (self._attempt - 1)), _max_delay)
                    delay = delay * (0.5 + random.random())
                    logger.info(
                        "Reconnecting to @%s in %.1fs (attempt %d/%d)",
                        self.username, delay, self._attempt, _max_retries,
                    )
                    await asyncio.sleep(delay)
                else:
                    # The awaited websocket task returned without raising: the
                    # socket closed (stream ended or a plain drop). If we are still
                    # meant to run, back off and reconnect.
                    if not self._running or self._live_ended:
                        break

                    self._attempt += 1
                    if self._attempt >= _max_retries:
                        logger.error(
                            "Max reconnect attempts reached for @%s — giving up",
                            self.username,
                        )
                        self._running = False
                        break

                    delay = min(_base_delay * (2 ** (self._attempt - 1)), _max_delay)
                    delay = delay * (0.5 + random.random())
                    logger.info(
                        "Reconnecting to @%s in %.1fs (attempt %d/%d)",
                        self.username, delay, self._attempt, _max_retries,
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

            # There is no live to read — the streamer stopped, or has not started.
            # Wait for one rather than giving up: stopping and starting again a few
            # minutes later is ordinary, and until this existed the source died and
            # the app kept reading "no longer live" over a stream that was on air,
            # or "Connecting" over one that had not begun.
            if (self._live_ended or self._offline_waiting) and self._running and not self._stopping:
                await self._wait_for_live()

            # The wait either found a live — the flags are cleared and the outer
            # loop opens a fresh session — or it spent its budget and left one set.
            # The second case has to stop here: the inner loop's condition is
            # already false, so without this the outer loop would spin straight
            # back into another wait, resetting the budget each time and never
            # giving up.
            if self._live_ended or self._offline_waiting:
                self._running = False
                break

        self._connected = False
        # The loop has ended, so nothing is running any more. `_running` used to
        # be left set on the natural exits (live end, retries exhausted, circuit
        # breaker), which made `is_running()` report a dead source as live — the
        # router then skipped the replace on the next connect and a finished
        # stream could never be revived without a restart. `disconnect()` clears
        # it too, for the cancellation path that never reaches this line.
        self._running = False
        # Every natural exit has to release the observer. `_running = False` does
        # not: the consumer is parked in `queue.get()`, which only `_STOP` wakes.
        # Without this, every room that ended on its own — the live ended, retries
        # ran out, the circuit breaker tripped — left a task alive holding the
        # adapter and its queue for the life of the process. `disconnect()`
        # releases too, so a room that was stopped properly does not get a second
        # sentinel, which is harmless: the queue drains it and the loop is gone.
        self._release_observer()
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
            # The one case that will not fix itself. A live that ended waits for
            # the streamer; this is retries exhausted, the circuit breaker, or a
            # client that could not be rebuilt — nothing will bring the room back
            # until somebody presses Connect, and nobody is watching at 02:00.
            alerts.notify_soon(
                alerts.GAVE_UP,
                self.room_id,
                self.username,
                "the source gave up and will not retry; press Connect when the stream is back",
            )

        # The loop gave up on its own (retries exhausted, circuit breaker, live
        # ended) rather than through `disconnect()`, so the observer parked in
        # `queue.get()` still has to be woken here. Without this the observer
        # for every room that failed to connect outlived its source.
        self._release_observer()

    async def _wait_for_live(self) -> None:
        """Wait for a streamer with no live stream to start one, then reconnect.

        Two situations arrive here and they are the same problem from the room's
        point of view: the streamer stopped and will start again (a break, a scene
        change, a dropped phone), or the streamer was never live when we tried.
        Either way there is nothing to read and nothing retrying can fix — only
        asking again later. Both used to end the source for good: the connect
        loop's condition includes `not self._live_ended`, so it exited and nothing
        brought it back but a manual connect, while the app showed "no longer
        live" through a stream that was on the air, or "Connecting" over one that
        had not started.

        The old socket cannot be reused. A new live gets a new room id — measured
        live: `7696774047573838612` ended, `7696866940727397126` started — so
        there is nothing to reconnect to. The only way to learn about the new one
        is to ask, which is what the poll does.

        Returns with the flags cleared and `_client` rebuilt when the streamer is
        live, so the caller can loop into a fresh connection. Leaves them as they
        are when the budget runs out, so the app keeps saying the streamer is not
        live — which by then is true.
        """
        from TikTokLive.client.errors import UserOfflineError

        self._awaiting_live = True
        # Which of the two situations this is decides the wording. A streamer who
        # has not started has not "come back", and a status line that says they
        # did is a statement the codebase treats as a bug rather than a nicety.
        was_live = self._live_ended
        logger.info(
            "@%s %s — watching for it, up to %.0f minutes",
            self.username,
            "is no longer live" if was_live else "has no live stream",
            (_LIVE_WAIT_POLLS * _LIVE_POLL_INTERVAL) / 60,
        )

        try:
            for _ in range(_LIVE_WAIT_POLLS):
                if not self._running or self._stopping:
                    return

                await asyncio.sleep(_LIVE_POLL_INTERVAL)
                if not self._running or self._stopping:
                    return

                # A fresh client per probe: `is_live()` resolves the user id and
                # the client that carried the finished session is not ours to
                # reuse. Its own failure is not the room's — a probe that throws
                # must not end the wait, or one bad request would look like a
                # streamer who never came back.
                probe = None
                try:
                    from TikTokLive import TikTokLiveClient as Client
                    probe = Client(unique_id=self.username)
                    live_now = await probe.is_live(self.username)
                except UserOfflineError:
                    live_now = False
                except asyncio.CancelledError:
                    raise
                except Exception as probe_err:  # noqa: BLE001
                    logger.debug(
                        "Live check for @%s failed, will ask again: %s",
                        self.username, probe_err,
                    )
                    live_now = False
                finally:
                    if probe is not None:
                        try:
                            await asyncio.wait_for(probe.disconnect(), timeout=5)
                        except Exception:  # noqa: BLE001
                            pass

                if not live_now:
                    continue

                # Back on the air. Clear the flags *before* rebuilding, so a client
                # attaching in this window reads "connecting" rather than the "no
                # longer live" that is no longer true.
                logger.info("@%s is live — reconnecting", self.username)
                self._live_ended = False
                self._offline_waiting = False
                self._attempt = 0
                self._consecutive_sign_failures = 0
                self._connected = False
                # And tell the clients that are already attached, not just the ones
                # that arrive later. Clearing the flag only fixes the snapshot a
                # new socket is handed at attach; an overlay that has been open
                # the whole time — which is every overlay — was last told the
                # streamer was not live and would keep saying it until the new
                # handshake completed, which is seconds of a false statement about
                # the room this whole path exists to avoid. `connecting=True` so the
                # frame reads as "coming back" rather than a disconnect, and so
                # `emit_status` skips its own bookkeeping: this is a transition,
                # and the session counters are reset by the `connected=True` frame
                # the new handshake produces, not by a status about to be replaced.
                try:
                    await events.emit_status(
                        self.room_id,
                        connected=False,
                        connecting=True,
                        message=(
                            f"@{self.username} is live again — reconnecting"
                            if was_live
                            else f"@{self.username} is live — connecting"
                        ),
                    )
                except Exception as emit_err:  # noqa: BLE001 — a status frame must not stop the reconnect
                    logger.debug(
                        "Could not announce @%s coming back: %s", self.username, emit_err
                    )
                try:
                    from TikTokLive import TikTokLiveClient as Client
                    self._client = Client(unique_id=self.username)
                    self._setup_handlers(self._client)
                except Exception as rebuild_err:  # noqa: BLE001
                    logger.error(
                        "Could not rebuild the client for @%s: %s", self.username, rebuild_err,
                    )
                    # Put the flag back: we are not connected, and saying the live
                    # ended is closer to the truth than saying nothing. Which flag
                    # depends on which situation we were waiting out — a streamer
                    # who never started did not end a live.
                    if was_live:
                        self._live_ended = True
                    else:
                        self._offline_waiting = True
                    return
                return

            # The loop ran out of polls without the streamer going live.
            logger.info(
                "@%s did not go live within %.0f minutes — giving up",
                self.username, (_LIVE_WAIT_POLLS * _LIVE_POLL_INTERVAL) / 60,
            )
        finally:
            self._awaiting_live = False

    async def start(self) -> None:
        """Alias for connect()."""
        await self.connect()

    async def stop(self) -> None:
        """Alias for disconnect()."""
        await self.disconnect()


# Register adapter with provider registry
from protocols import registry as _registry
_registry.register("tiktok", TikTokAdapter)
