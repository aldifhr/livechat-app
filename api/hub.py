"""WebSocket client registry and fan-out.

Kept separate from the event layer so that "who is listening" and "what
happened" stay independent: a new event source never needs to know how
broadcasting works, and a new client type never needs to know what an event is.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any

from fastapi import WebSocket

from metrics import metrics as _metrics

#: The kinds of client that attach to a room's event stream.
#:
#: `overlay` is the one that has count, and it is named here because the list of
#: known types was once just the other two — so a handler validating against them
#: refused every OBS browser source and every inline dashboard preview with 1008,
#: and the suite stayed green because all of it connected as `room`.
ROOM = "room"
CUSTOMIZER = "customizer"
#: The overlay pages. `static/overlay.html` and `static/topchatter.html` open this,
#: and so does the dashboard's own preview iframe, which embeds one of those pages.
OVERLAY = "overlay"

#: Every accepted `client_type`. Checked in one place, so adding a kind is this line
#: and not a hunt for the tuple literal that used to sit in the `if`.
CLIENT_TYPES = frozenset({ROOM, CUSTOMIZER, OVERLAY})

#: Clients that are a viewer of the room rather than somebody editing it. A
#: customizer is the operator's own surface, and counting it against the viewer's
#: cap would lock the operator out of styling a room that already has overlays on
#: it — which is the normal state of a stream that is set up and running.
VIEWER_TYPES = frozenset({ROOM, OVERLAY})

# Re-exported for routes that validate client_type before calling hub.connect().
# The route in main.py needs these without instantiating the hub.

#: Maximum concurrent sockets per room.
#:
#: Each socket costs one asyncio.Queue (4096 slots), one writer task, and
#: several dict entries. A room with no cap is a remote FD-exhaustion attack:
#: anyone who discovers the host can open sockets until the process runs out
#: of file descriptors or memory. Five is generous for a human operator —
#: typically one OBS overlay, one dashboard preview, maybe a phone — and still
#: bounded.
MAX_CLIENTS_PER_ROOM = 5

#: Maximum concurrent sockets on the whole hub, across every room.
#:
#: The per-room cap alone does not bound anything, and the reason is the room id:
#: it is a free-form path segment with no validation, so a caller reaching the cap
#: for one room simply asks for the next one. `ws/room/a`, `ws/room/b`, `ws/room/c`
#: — five sockets each, indefinitely, and the total is what the process actually
#: pays for. This is the cap that bounds the total; the per-room one is about being
#: a good citizen of a room rather than about survival.
#:
#: Sized for a small deployment with room to spare. Every socket here is a real
#: stream somebody is watching, so a ceiling far above this would not protect
#: anything — it would only decide how many file descriptors are gone before the
#: ceiling is reached.
#:
#: The room id itself is not validated, and adding that was considered and left out.
#: The overlay pages recognise a room id by shape — 8-4-4-4-12 hex, because the
#: backend mints `uuid.uuid4()` and a handle can never match — and reusing that
#: regex here would have been the tidier defence. It is not, because the id is a
#: free-form segment in every other caller too: the test suite opens `/ws/room/
#: test-room` and `/ws/room/alpha-board`, and a room id is not required to be a uuid
#: anywhere it is minted. Enforcing the shape would have meant changing the contract
#: to close a hole this ceiling already closes — a caller using a fresh made-up id
#: per socket is bounded by the total now, which is the thing that was actually
#: unbounded. If the id is ever tightened, tighten it at the store, not here.
MAX_CLIENTS_TOTAL = 200

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


class _Outgoing(dict):
    """One message on its way to one client, stamped when it was queued.

    The stamp is what makes ingest-to-send latency measurable at all. The wire
    dict cannot carry it: those dicts *are* the client contract, and a key the
    overlay pages do not know is a key that ships to every browser. So the
    timestamp rides alongside the payload instead of inside it.

    A `dict` subclass rather than a wrapper, deliberately: the payload is the
    message, and anything that reads one of these — a test asserting on queue
    contents, `json.dumps` on the way out — must see the payload and nothing
    else. `enqueued_at` is the one addition, and `getattr` with a default is
    how the reader treats a payload that arrived without one.

    That span is queue wait plus send — everything from `events.emit` handing
    the message over to the bytes hitting the socket. Normalisation and routing
    happen before the stamp and are not in it; the number is honest about what
    it covers and is labelled that way in `/metrics`.
    """

    __slots__ = ("enqueued_at",)

    def __init__(self, payload: dict[str, Any], enqueued_at: float | None = None) -> None:
        super().__init__(payload)
        self.enqueued_at = enqueued_at if enqueued_at is not None else time.monotonic()


class Hub:
    def __init__(self) -> None:
        self.active: dict[str, WebSocket] = {}
        # client id to the room it is watching, for every client type that
        # names one. The customizer panel edits a specific room's config, so it
        # is bound to that room for delivery purposes even though it is not a
        # broadcast client.
        self.room_clients: dict[str, str] = {}
        self.customizer_clients: set[str] = set()
        # One bounded queue and one writer task per client.
        #
        # Sending inline meant `await ws.send_text(...)` in a loop, so a browser
        # source that had stopped reading held up every other client behind it:
        # measured at 0.1ms with all clients healthy and 250.5ms with one slow
        # socket among eight, and a real stalled send takes however long the
        # socket takes to give up rather than a quarter of a second.
        self._queues: dict[str, asyncio.Queue[_Outgoing]] = {}
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
        self._held_viewers: dict[str, _Outgoing] = {}
        # Counted rather than logged: `/metrics` used to read a `_disconnection_log`
        # attribute that never existed, so `getattr(..., [])` fell through to an
        # empty list and the metric reported a permanent zero. A counter that is
        # actually incremented is the smallest thing that makes the number true.
        self.disconnected_clients_count = 0

        # --- admission reservations --------------------------------------
        #
        # Both caps were checked *before* `await websocket.accept()` and the
        # client was registered *after* it, which left a window where any number
        # of handshakes could pass the same check. Two sockets arriving in the
        # same tick both read "four of five", both accepted, both registered —
        # and the cap that is the only thing between an unauthenticated port and
        # a process out of file descriptors was a suggestion.
        #
        # The window cannot be closed with a lock: the point of the `await` is
        # that the handshake itself is slow, and holding a lock across it is the
        # "avoid holding a global lock across slow network operations" failure
        # with extra steps. What closes it is counting the handshakes that are
        # *in flight* alongside the ones that are registered. Both counters are
        # mutated by synchronous code with no `await` between the check and the
        # increment, so on a single-threaded event loop the check-and-reserve is
        # atomic by construction — no lock, nothing held across the handshake.
        #
        # A reservation is released on exactly two paths: the handshake failed,
        # or it succeeded and the client is now counted in `active` instead.
        # There is no third path, so a slot cannot leak.
        self._pending_total = 0
        self._pending_rooms: dict[str, int] = {}

    # --- admission -------------------------------------------------------

    def _reserve(self, client_type: str, room_id: str | None) -> str | None:
        """Take a slot for a handshake that is about to happen.

        Returns `None` when the slot is taken, or the reason it is not. Called
        with no `await` between the read and the write, which is what makes it
        atomic here.
        """
        if len(self.active) + self._pending_total >= MAX_CLIENTS_TOTAL:
            return "total"
        if room_id and client_type in VIEWER_TYPES:
            # In-flight handshakes for this room count against it too, or the
            # per-room cap has the same hole the total one did.
            current = sum(1 for rid in self.room_clients.values() if rid == room_id)
            current += self._pending_rooms.get(room_id, 0)
            if current >= MAX_CLIENTS_PER_ROOM:
                return "room"
        self._pending_total += 1
        if room_id and client_type in VIEWER_TYPES:
            self._pending_rooms[room_id] = self._pending_rooms.get(room_id, 0) + 1
        return None

    def _unreserve(self, client_type: str, room_id: str | None) -> None:
        """Give back a slot taken by `_reserve`. Idempotent by construction."""
        self._pending_total = max(0, self._pending_total - 1)
        if room_id and client_type in VIEWER_TYPES:
            remaining = self._pending_rooms.get(room_id, 0) - 1
            if remaining > 0:
                self._pending_rooms[room_id] = remaining
            else:
                self._pending_rooms.pop(room_id, None)

    async def connect(self, websocket: WebSocket, client_type: str, room_id: str | None = None) -> str:
        """Register a client and give it a queue, but start nothing yet.

        Delivery does not begin here. The caller still has frames to send that
        must arrive first — the room's config and its connection snapshot — and
        those are written to the socket directly, outside this queue. Starting the
        writer now meant an event broadcast in the gap landed in the queue, was
        picked up by the writer, and reached the client *before* the config it was
        supposed to be styled by: an overlay attaching to a styled room came up on
        its defaults and stayed there until something else restyled it.

        So the socket is registered here and the drain starts at `prime()`, once
        the caller has finished its opening frames. Registration is still eager
        because `room_clients` is what `broadcast` routes on, and a room's first
        event must find this client already in the map — queued behind the config
        it is waiting for, not lost.

        Returns an empty string when a cap is reached, having closed the socket
        first. A refusal nobody asked for is not an error, and it used to be one:
        this raised, nothing caught it, and uvicorn logged an ERROR traceback for
        every socket over the cap. Those went to the root logger, which is where
        `logbuffer` keeps the ring the dashboard's Logs page reads — so a caller
        walking into the ceiling evicted the real errors that page exists to show,
        repeatably, without a credential, using any made-up room id.
        """
        # Reserved before `accept`, released after registration or on failure.
        # The caps are the only thing between an unauthenticated path and a
        # process out of file descriptors, so the check and the slot it guards
        # have to be one step — see `_reserve`.
        refusal = self._reserve(client_type, room_id)
        if refusal is not None:
            _metrics.ws_refuse(refusal)
            await websocket.close(
                code=1013,
                reason="server at capacity" if refusal == "total" else "room is full",
            )
            return ""

        try:
            await websocket.accept()
        except BaseException:
            # The handshake itself failed — the peer vanished, or the server is
            # shutting the socket down. The slot goes back whether or not
            # anything was registered, and the exception propagates: a failed
            # handshake is the caller's to handle, and swallowing it here would
            # leave the route believing it had a client.
            self._unreserve(client_type, room_id)
            raise

        client_id = str(uuid.uuid4())
        self.active[client_id] = websocket
        self._queues[client_id] = asyncio.Queue(maxsize=CLIENT_QUEUE_LIMIT)
        if room_id:
            self.room_clients[client_id] = room_id
        if client_type == CUSTOMIZER:
            self.customizer_clients.add(client_id)
        # Registered, so the caps count this client from here on and the
        # in-flight reservation is no longer needed.
        self._unreserve(client_type, room_id)
        _metrics.ws_connect()
        return client_id

    def prime(self, client_id: str) -> None:
        """Start draining a client's queue, after its opening frames are sent.

        Called once by the socket handler, immediately after the config and status
        frames are written. Everything queued in the meantime — events that
        arrived while those were being sent — is delivered now, in order, behind
        them.

        Idempotent in effect: a second call replaces the task, and a call for a
        client that has already disconnected does nothing. The latter matters
        because `disconnect` can run from the writer itself (a send that timed
        out), so this is reachable with the id already gone.
        """
        if client_id not in self.active or client_id not in self._queues:
            return
        existing = self._writers.pop(client_id, None)
        if existing is not None:
            existing.cancel()
        self._writers[client_id] = asyncio.create_task(
            self._writer(client_id, self.active[client_id])
        )

    def queued_messages(self) -> int:
        """How many messages are waiting across every client.

        A method rather than letting the metric read `_queues` directly: the
        queue map is this class's own bookkeeping, and a metric that reaches into
        it is a caller that breaks silently the day the map is renamed or split.
        """
        return sum(q.qsize() for q in self._queues.values())

    def queue_high_water(self) -> int:
        """The deepest any single client queue has been since boot."""
        return _metrics.client_queue_high_water

    def disconnect(self, client_id: str) -> None:
        # Only a client that was actually connected counts. `disconnect` is called
        # from the socket teardown, and a duplicate call for an id already gone
        # would otherwise inflate the total.
        if client_id in self.active:
            self.disconnected_clients_count += 1
        self.active.pop(client_id, None)
        self.room_clients.pop(client_id, None)
        self.customizer_clients.discard(client_id)
        self._queues.pop(client_id, None)
        self._strikes.pop(client_id, None)
        self._held_viewers.pop(client_id, None)
        task = self._writers.pop(client_id, None)
        if task is not None:
            task.cancel()

    async def _writer(self, client_id: str, ws: WebSocket) -> None:
        """Drain one client's queue, on that client's own clock."""
        # Taken with a default rather than indexed: `connect` creates the task and
        # this coroutine does not run until it is scheduled, so a `disconnect` in
        # between has already popped the queue and this line raised KeyError from
        # a task nobody was awaiting.
        queue = self._queues.get(client_id)
        if queue is None:
            return

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

            if not await self._deliver(client_id, ws, message):
                return

            # The queue is drained, so anything held back can go now, and it is
            # the newest count rather than the oldest.
            held = self._held_viewers.pop(client_id, None)
            if held is not None:
                if not await self._deliver(client_id, ws, held):
                    return

    async def _deliver(self, client_id: str, ws: WebSocket, message: _Outgoing) -> bool:
        """Write one message to one socket, and clean up if it cannot be.

        Returns False when the client is gone, so the writer stops. Every
        failure path ends here rather than being written twice, and every one of
        them drops the client: a send that timed out, a socket the peer tore
        down mid-write and a serialisation that raised are all the same answer
        from this side — this client is not coming back.
        """
        try:
            await asyncio.wait_for(
                ws.send_text(json.dumps(message, ensure_ascii=False)),
                timeout=SEND_TIMEOUT_S,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            # A source OBS tore down mid-send, or one that stopped reading long
            # enough to time out. Either way it is not coming back.
            _metrics.dead_client()
            self.disconnect(client_id)
            return False
        # Measured here rather than at enqueue: the queue wait is part of what
        # the client experiences, and a number that only counted the send would
        # hide the backlog that is the actual problem. A payload that arrived
        # without a stamp — a test putting one straight into the queue — is
        # sent and simply not measured.
        enqueued_at = getattr(message, "enqueued_at", None)
        if enqueued_at is not None:
            _metrics.sent(time.monotonic() - enqueued_at)
        return True

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
            if client_id in self._held_viewers:
                # A count was already waiting and this one replaces it. Counted,
                # because "the overlay is being sent fewer audience updates than
                # the room produces" is a fact worth being able to see.
                _metrics.coalesce_viewer()
            self._held_viewers[client_id] = _Outgoing(message)
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
            queue.put_nowait(_Outgoing(message))
            self._strikes[client_id] = 0
            _metrics.note_client_depth(queue.qsize())
        except asyncio.QueueFull:
            self._strikes[client_id] = self._strikes.get(client_id, 0) + 1
            if self._strikes[client_id] >= CLIENT_OVERFLOW_STRIKES:
                _metrics.slow_client()
                _metrics.drop_client()
                self.disconnect(client_id)

    def _targets(self, client_type: str | None, room_id: str | None) -> set[str]:
        """Who should receive this message.

        A room id is a boundary, not a hint. Every producer passes one and
        none of them pass a client type, so a filter that only applied when
        `client_type == ROOM` fell straight through to "everyone" — and two
        streams on the same backend received each other's comments, each other's
        config and each other's connection status. A room's own id decides who
        hears about it, whatever kind of client is listening.
        """
        if room_id:
            return {cid for cid, oid in self.room_clients.items() if oid == room_id}
        if client_type == CUSTOMIZER:
            return self.customizer_clients.copy()
        if client_type == ROOM:
            # Rooms with no id, kept apart from any stray client that never
            # named a room.
            return set(self.room_clients.keys())
        # Fallback when no room_id is given: broadcast to every connected client.
        # Currently unreachable (events.emit always passes room_id), but a future
        # caller that omits it would silently fan out to all rooms — a footgun
        # worth naming rather than a silent default.
        return set(self.active.keys())

    async def broadcast(
        self,
        message: dict[str, Any],
        client_type: str | None = None,
        room_id: str | None = None,
    ) -> None:
        targets = self._targets(client_type, room_id)
        if not targets:
            return

        for cid in targets:
            if cid not in self.active:
                continue
            self._send(cid, message)


hub = Hub()
