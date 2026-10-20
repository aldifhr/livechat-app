"""YouTube Live as an event source.

Uses `pytchatV2` for the chat fetch and normalises its items into the same
`events.Event` values the rest of the pipeline already understands — COMMENT,
GIFT, JOIN, LIKE, SUBSCRIPTION. The adapter implements the `EventAdapter`
protocol, so the rest of the system (WebSocket fan-out, status frames, the
event log) treats a YouTube room exactly like a TikTok one.

pytchatV2 is a blocking library, so the poll loop runs in a worker thread via
`asyncio.to_thread`. The queue + sentinel pattern is the same one
`TikTokAdapter` uses: `connect()` starts the background task, `observe()`
drains the queue, and a stop sentinel wakes a consumer parked in `get()`.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, AsyncGenerator

from protocols import EventAdapter
from events import (
    COMMENT,
    GIFT,
    JOIN,
    LIKE,
    SUBSCRIPTION,
    Event,
)

logger = logging.getLogger(__name__)

#: YouTube channel handle patterns. A channel handle is `@something`; a
#: `channelId` is a `UC…` string. A raw 11-char video id is also accepted.
_RE_VIDEO_ID = re.compile(r"(?:v=|youtu\.be/|^)([A-Za-z0-9_-]{11})(?:[?&#].*)?$")
_RE_HANDLE = re.compile(r"^@?[A-Za-z0-9._-]+$")
_RE_CHANNEL_ID = re.compile(r"^UC[A-Za-z0-9_-]{22}$")


class _Stop:
    """Type-only sentinel marker so the queue stays `Event | _Stop`."""


_STOP = _Stop()


def _resolve_video_id(raw: str) -> str | None:
    """Extract an 11-character video id from a URL, raw id, or handle.

    A channel handle (`@name`) or channel id (`UC…`) is NOT a video id — the
    caller has to resolve it to the current live video first. pytchatV2 does
    that resolution internally, so we accept any shape it accepts and leave
    the error to it.
    """
    raw = raw.strip()
    m = _RE_VIDEO_ID.search(raw)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", raw):
        return raw
    return raw  # pytchatV2 will tell us if it can't handle it


class YouTubeLiveAdapter(EventAdapter):
    """YouTube Live event adapter built on pytchatV2.

    Parameters
    ----------
    video_id : str
        An 11-character video id, a YouTube watch/share URL, or a channel
        handle (`@name`) / channel id (`UC…`). pytchatV2 resolves handles to
        the current live video itself; a handle with no live right now raises
        ``ContinuationError`` and the adapter reports waiting/offline.
    room_id : str
        The room this source feeds. Used in status frames and event log.
    """

    provider = "youtube"

    #: Consecutive poll failures before the session is rebuilt rather than
    #: retried in place. A single reset is routine; a run of them means the
    #: reader's continuation is dead.
    _MAX_POLL_FAILURES = 3

    #: How many times resolving the video may fail before the room is declared
    #: dead. `create()` hits YouTube; a blip there is not a bad video id, so it
    #: is retried rather than treated as terminal on the first attempt.
    _MAX_CREATE_FAILURES = 3

    def __init__(self, video_id: str, room_id: str) -> None:
        self.video_id = _resolve_video_id(video_id)
        self.room_id = room_id
        self.username = video_id  # alias main.py reads for status payloads

        self._running = False
        self._connected = False
        self._task: asyncio.Task | None = None
        self._events: asyncio.Queue[Event | _Stop] = asyncio.Queue()
        self._last_viewers = 0

    # ------------------------------------------------------------------
    # EventAdapter protocol
    # ------------------------------------------------------------------

    def start_background(self) -> None:
        """Start the connect task without blocking the caller."""
        if self._running or (self._task is not None and not self._task.done()):
            return
        self._task = asyncio.create_task(self.connect())

    async def connect(self, **kwargs: Any) -> bool:
        """Resolve the video, start the pytchat poll loop in a worker thread.

        Idempotent: a second call while running is a no-op that returns True.
        """
        if self._running:
            return True

        try:
            import pytchat
        except ImportError:
            logger.error("pytchatV2 library not installed. Run: pip install pytchatV2")
            return False

        self._running = True
        self._connected = False
        self._task = asyncio.create_task(self._run_loop(pytchat))
        return True

    def stop(self) -> None:
        """Alias for `disconnect`, matching TikTokAdapter's sync stop.

        `_connect_room` in main.py calls `existing.stop()` synchronously; the
        actual disconnect is a coroutine and is awaited there after this returns.
        """
        # Schedule disconnect as a task so the lock-holding caller isn't blocked
        # by our coroutine.  This is only used during the tear-down path where
        # the caller does `await existing.stop()` — if it's the sync alias,
        # the caller will get a coroutine object instead of None, and the
        # `await` on a non-awaitable raises TypeError.  So the route actually
        # calls `await source.disconnect()` (the coroutine); this sync alias
        # exists for any caller that does `source.stop()` without await.
        if self._task is not None and not self._task.done():
            asyncio.ensure_future(self.disconnect())

    async def disconnect(self) -> None:
        """Stop the poll loop, close the pytchat reader, drain the queue."""
        if not self._running and self._task is None:
            return
        self._running = False
        # Wake any consumer parked in `get()` so observe() ends.
        self._events.put_nowait(_STOP)
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except asyncio.TimeoutError:
                self._task.cancel()
            except Exception:
                pass
        self._task = None

    async def observe(self) -> AsyncGenerator[Event, None]:
        """Yield normalised events from the pytchat poll loop."""
        while self._running or not self._events.empty():
            event = await self._events.get()
            if isinstance(event, _Stop):
                return
            yield event

    # ------------------------------------------------------------------
    # status helpers (read by main.py's status_payload route)
    # ------------------------------------------------------------------

    def is_running(self) -> bool:
        return self._running

    def is_connected(self) -> bool:
        return self._connected

    def status_payload(self) -> dict[str, Any]:
        """The status frame for this source, matching TikTokAdapter's shape."""
        if not self._running:
            return {"connected": False, "message": "Offline"}
        if not self._connected:
            return {"connected": False, "message": "connecting", "connecting": True}
        return {
            "connected": True,
            "message": "connected",
            "viewers": self._last_viewers,
        }

    # ------------------------------------------------------------------
    # the pytchat loop
    # ------------------------------------------------------------------

    async def _run_loop(self, pytchat_mod: Any) -> None:
        """Poll pytchat in a worker thread, push events onto the queue.

        pytchat's PytchatCore is blocking: each poll runs synchronously for the
        duration the server tells it to wait (`timeoutMs`). Running it directly
        on the event loop would freeze every WebSocket client behind one slow
        poll, so each poll is dispatched with `asyncio.to_thread`.

        A dropped connection is normal on a long stream — HTTP/2 gets reset by
        intermediates, and YouTube closes idle sessions. pytchat reports that as
        a poll that raises or a reader that stops being alive, and the old code
        treated either as "give up", which silently ended the room on the first
        blip. Both are retried with a bounded backoff instead, and only a
        failure that survives the whole budget stops the room.
        """
        self._connected = False
        create_failures = 0

        while self._running:
            try:
                chat = pytchat_mod.create(
                    video_id=self.video_id,
                    interruptable=False,
                )
                create_failures = 0
            except Exception as exc:
                create_failures += 1
                logger.error(
                    "YouTube: could not resolve %s (%d/%d): %s",
                    self.video_id, create_failures, self._MAX_CREATE_FAILURES, exc,
                )
                if create_failures >= self._MAX_CREATE_FAILURES:
                    break
                await asyncio.sleep(min(2 ** create_failures, 30))
                continue

            self._connected = True
            logger.info("YouTube: connected to %s", self.video_id)
            poll_failures = 0

            try:
                while self._running and chat.is_alive():
                    try:
                        items = await asyncio.to_thread(
                            lambda: list(chat.get().sync_items())
                        )
                        poll_failures = 0
                    except Exception as exc:
                        poll_failures += 1
                        logger.warning(
                            "YouTube: poll failed for %s (%d/%d): %s",
                            self.video_id, poll_failures, self._MAX_POLL_FAILURES, exc,
                        )
                        if poll_failures >= self._MAX_POLL_FAILURES:
                            raise
                        await asyncio.sleep(min(2 ** poll_failures, 15))
                        continue

                    for item in items:
                        event = self._normalise(item)
                        if event is not None:
                            await self._events.put(event)

                    # Small yield so a disconnect can land between polls.
                    await asyncio.sleep(0.05)
            except Exception as exc:
                logger.warning("YouTube: session for %s ended: %s", self.video_id, exc)
            finally:
                try:
                    chat.terminate()
                except Exception:
                    pass
                self._connected = False

            if not self._running:
                break
            # Rebuild the session: a terminated reader cannot be revived, and a
            # dropped one has no usable continuation left.
            logger.info("YouTube: reconnecting to %s", self.video_id)
            await asyncio.sleep(3)

        self._running = False
        # Wake any parked consumer.
        await self._events.put(_STOP)

    def _normalise(self, item: Any) -> Event | None:
        """Turn one pytchat ChatItem into an Event.

        pytchat item types: "text", "superChat", "superSticker",
        "membershipGift", "newSponsor". The first three carry a message;
        membership events carry months and an author.
        """
        author = getattr(item, "author", None)
        name = getattr(author, "name", "") or ""
        channel_id = getattr(author, "channelId", "") or ""
        image_url = getattr(author, "imageUrl", "") or ""
        is_mod = getattr(author, "isChatModerator", False)
        is_sponsor = getattr(author, "isChatSponsor", False)

        item_type = getattr(item, "type", "") or ""
        message = str(getattr(item, "message", "") or "").strip()
        meta: dict[str, Any] = {}

        if is_mod:
            meta["moderator"] = True
        if is_sponsor:
            meta["sponsor"] = True

        if item_type in ("superChat", "superSticker"):
            amount = getattr(item, "amountValue", 0) or 0
            currency = getattr(item, "currency", "") or ""
            meta["amount"] = amount
            meta["currency"] = currency
            meta["giftName"] = item_type
            return Event(
                kind=GIFT,
                user=name,
                user_id=channel_id,
                avatar=image_url,
                value=message or f"{amount} {currency}",
                meta=meta,
            )

        if item_type == "newSponsor":
            # Month count lives in the message text (e.g. "Member for 12 months"),
            # which pytchat already joined from headerSubText.runs.
            month_count = 0
            m = re.search(r"(\d+)", message)
            if m:
                month_count = int(m.group(1))
            meta["months"] = month_count
            value = message or f"member for {month_count} months"
            return Event(
                kind=SUBSCRIPTION,
                user=name,
                user_id=channel_id,
                avatar=image_url,
                value=value,
                meta=meta,
            )

        # text — the common case
        if message:
            return Event(
                kind=COMMENT,
                user=name,
                user_id=channel_id,
                avatar=image_url,
                value=message,
                meta=meta,
            )

        return None
