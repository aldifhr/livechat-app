"""WebSocket client registry and fan-out.

Kept separate from the event layer so that "who is listening" and "what
happened" stay independent: a new event source never needs to know how
broadcasting works, and a new client type never needs to know what an event is.
"""

import asyncio
import json
import uuid
from typing import Any

from fastapi import WebSocket

OVERLAY = "overlay"
CUSTOMIZER = "customizer"

#: Messages buffered for one client before it is judged not to be keeping up.
#:
#: Sized for a burst, not a steady rate: two thousand events dispatched in 58ms
#: will fill a small queue with a healthy client still attached, and a limit low
#: enough to catch that is low enough to fail on real spikes. A busy room sends a
#: comment every second or so, so this is well over a minute of slack.
CLIENT_QUEUE_LIMIT = 4096

#: Consecutive full-queue events before a client is dropped.
#:
#: One overflow is a burst and means nothing. A client that is still behind after
#: this many is not going to catch up, and every message it never drains is
#: memory someone else is paying for.
CLIENT_OVERFLOW_STRIKES = 50

#: How long one send may take before the socket is considered wedged.
#:
#: Not the same as a timeout on the whole broadcast: each client gets its own,
#: so one stalled OBS cannot delay anyone else and is dropped on its own clock.
SEND_TIMEOUT_S = 5.0

#: How long a writer waits on an empty queue before checking whether a viewer
#: count is being held back. Without this the held count is only ever sent when
#: something else arrives, so a stream with an audience and no chat would never
#: report its audience at all.
VIEWER_FLUSH_S = 1.0


class Hub:
    def __init__(self) -> None:
        self.active: dict[str, WebSocket] = {}
        # client id to the overlay it is watching, for every client type that
        # names one. The customizer panel edits a specific scene's config, so it
        # is bound to that scene for delivery purposes even though it is not a
        # broadcast client.
        self.overlay_clients: dict[str, str] = {}
        self.customizer_clients: set[str] = set()
        # One bounded queue and one writer task per client.
        #
        # Sending inline meant `await ws.send_text(...)` in a loop, so a browser
        # source that had stopped reading held up every other client behind it:
        # measured at 0.1ms with all clients healthy and 250.5ms with one slow
        # socket among eight, and a real stalled send takes however long the
        # socket takes to give up rather than a quarter of a second.
        self._queues: dict[str, asyncio.Queue[dict[str, Any]]] = {}
        self._writers: dict[str, asyncio.Task[None]] = {}
        self._strikes: dict[str, int] = {}
        # The newest viewer count per client, held outside the queue.
        #
        # It used to be coalesced *inside* the queue, which meant asking
        # `qsize()` on every event for every client and, when the oldest item was
        # a comment rather than a viewer, putting it back and asking again. That
        # scan wedged the whole event loop — py-spy caught it parked in
        # `qsize()` while every other client starved, which presented as the
        # whole API going dead while the backend still logged events. Holding
        # the count in a slot of its own is O(1), cannot reorder the queue, and
        # cannot block: the newest number is simply the one that gets sent.
        self._held_viewers: dict[str, dict[str, Any]] = {}

    async def connect(self, websocket: WebSocket, client_type: str, overlay_id: str | None = None) -> str:
        await websocket.accept()
        client_id = str(uuid.uuid4())
        self.active[client_id] = websocket
        self._queues[client_id] = asyncio.Queue(maxsize=CLIENT_QUEUE_LIMIT)
        self._writers[client_id] = asyncio.create_task(self._writer(client_id, websocket))
        if overlay_id:
            self.overlay_clients[client_id] = overlay_id
        if client_type == CUSTOMIZER:
            self.customizer_clients.add(client_id)
        return client_id

    def disconnect(self, client_id: str) -> None:
        self.active.pop(client_id, None)
        self.overlay_clients.pop(client_id, None)
        self.customizer_clients.discard(client_id)
        self._queues.pop(client_id, None)
        self._strikes.pop(client_id, None)
        self._held_viewers.pop(client_id, None)
        task = self._writers.pop(client_id, None)
        if task is not None:
            task.cancel()

    async def _writer(self, client_id: str, ws: WebSocket) -> None:
        """Drain one client's queue, on that client's own clock."""
        queue = self._queues[client_id]

        async def send(payload: dict[str, Any]) -> None:
            # Serialised on the way out, not on the way in: a viewer count held
            # for coalescing must not have been encoded already.
            await asyncio.wait_for(
                ws.send_text(json.dumps(payload, ensure_ascii=False)),
                timeout=SEND_TIMEOUT_S,
            )

        while True:
            try:
                message = await asyncio.wait_for(queue.get(), timeout=VIEWER_FLUSH_S)
            except asyncio.TimeoutError:
                # Nothing queued. If an audience is being held back, this is the
                # only moment it can ever leave, so it has to be checked.
                held = self._held_viewers.pop(client_id, None)
                if held is None:
                    continue
                message = held
            except asyncio.CancelledError:
                raise

            try:
                await send(message)
            except asyncio.CancelledError:
                raise
            except Exception:
                # A source OBS tore down mid-send, or one that stopped reading
                # long enough to time out. Either way it is not coming back.
                self.disconnect(client_id)
                return

            # The queue is drained, so anything held back can go now, and it is
            # the newest count rather than the oldest.
            held = self._held_viewers.pop(client_id, None)
            if held is not None:
                try:
                    await send(held)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self.disconnect(client_id)
                    return

    def _send(self, client_id: str, message: dict[str, Any]) -> None:
        """Hand a message to one client without waiting for it.

        Nothing is thrown away silently. A viewer count is the one thing that
        goes stale by definition — only the latest number is ever true — so a
        queued one is replaced rather than kept. A chat comment or a gift is not
        stale, so those are never dropped: the queue grows to hold them and the
        client is judged on its drain rate instead.

        The first version disconnected a client the instant its queue filled,
        which killed four healthy clients during a two-thousand-event burst.
        Dropping the client after it has stayed behind this many times is the
        distinction between a spike and a socket that has stopped reading.
        """
        queue = self._queues.get(client_id)
        if queue is None:
            return

        if message.get("type") == "viewers":
            # Held, not queued. The queue is for things that must all arrive in
            # order; a viewer count is only ever true as of now, so the newest
            # one supersedes every older one and there is no reason to give it a
            # place in line behind a backlog of comments.
            self._held_viewers[client_id] = message
            # The strike counter is deliberately left alone here. It exists to
            # answer "is this client draining?", and an audience update answers
            # nothing about that — it never touches the queue. Resetting it meant
            # a client with a permanently full queue and a stopped writer was
            # forgiven every minute by a number that arrived on its own clock,
            # so a threshold of fifty was really fifty overflows with no viewer
            # count in between, and a wedged OBS on a slow room was never
            # dropped at all.
            return

        try:
            queue.put_nowait(message)
            self._strikes[client_id] = 0
        except asyncio.QueueFull:
            self._strikes[client_id] = self._strikes.get(client_id, 0) + 1
            if self._strikes[client_id] >= CLIENT_OVERFLOW_STRIKES:
                self.disconnect(client_id)

    def _targets(self, client_type: str | None, overlay_id: str | None) -> set[str]:
        """Who should receive this message.

        An overlay id is a boundary, not a hint. Every producer passes one and
        none of them pass a client type, so a filter that only applied when
        `client_type == OVERLAY` fell straight through to "everyone" — and two
        streams on the same backend received each other's comments, each other's
        config and each other's connection status. A scene's own id decides who
        hears about it, whatever kind of client is listening.
        """
        if overlay_id:
            return {cid for cid, oid in self.overlay_clients.items() if oid == overlay_id}
        if client_type == CUSTOMIZER:
            return self.customizer_clients.copy()
        if client_type == OVERLAY:
            # Overlays with no id, kept apart from any stray client that never
            # named a scene.
            return set(self.overlay_clients.keys())
        return set(self.active.keys())

    async def broadcast(
        self,
        message: dict[str, Any],
        client_type: str | None = None,
        overlay_id: str | None = None,
    ) -> None:
        targets = self._targets(client_type, overlay_id)
        if not targets:
            return

        for cid in targets:
            if cid not in self.active:
                continue
            self._send(cid, message)


hub = Hub()
