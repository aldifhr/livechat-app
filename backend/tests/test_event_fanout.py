"""A burst of events must not be able to starve the event loop.

The original failure: every event awaited the socket send directly, so one
stalled browser source back-pressured the whole stream, and a burst of two
thousand comments became two thousand tasks competing for the same loop. That
is the shape that took the API down once.

The fix is NOT a concurrency gate on the fan-out — an earlier version added one
(`dispatch()`/`_gate()`/`MAX_INFLIGHT`) and it was dead code that never ran in
production. Delivery was reworked instead: `hub.broadcast` hands each message to
a bounded per-client queue with `put_nowait` and a writer task drains it, so
`emit` never awaits a socket and cannot block. This pins THAT property, which is
the one that actually holds — plus the overflow policy, since a queue that fills
is the only place a burst can now turn into a dropped client.

Run with the backend's interpreter:

    .venv/bin/python tests/test_event_fanout.py
"""

import asyncio
import os
import sys
import time
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import events  # noqa: E402
import hub as hub_module  # noqa: E402

CHECKS = 0
FAILS = 0


def check(name, cond, extra=None):
    global CHECKS, FAILS
    CHECKS += 1
    if cond:
        print(f"  ok   {name}")
    else:
        FAILS += 1
        print("  FAIL", name, "" if extra is None else "—", extra)


async def emit_never_blocks():
    """`emit` must return without waiting on a slow client's socket.

    The queue is filled to its limit first, so a `put_nowait`-based `_send` has
    to either queue or strike — and the call must still return promptly rather
    than park on a send that is not happening.
    """
    hub = hub_module.Hub()
    client_id = "c1"
    hub.active[client_id] = object()  # type: ignore[assignment]
    hub.room_clients[client_id] = "ov"
    hub._queues[client_id] = asyncio.Queue(maxsize=4)

    # Nothing drains the queue, so the first few fit and the rest overflow.
    burst = 200
    t0 = time.perf_counter()
    for _ in range(burst):
        hub._send(client_id, {"type": "comment", "text": "hi"})
    elapsed = time.perf_counter() - t0

    check("a 200-message burst to a stuck client returns at once", elapsed < 0.5, f"{elapsed*1000:.1f}ms")

    # A stuck client is dropped once it has been behind CLIENT_OVERFLOW_STRIKES
    # times, not on the first overflow. The drop also clears its queue, so the
    # "held its bound" claim is checked on a client that has NOT yet been dropped.
    check("the stuck client was eventually dropped",
          client_id not in hub.active, sorted(hub.active))
    check("and that is counted as a disconnect", hub.disconnected_clients_count == 1,
          hub.disconnected_clients_count)

    # A fresh client keeps its bound and is NOT dropped: more messages than it
    # can hold, but the overflows stay under CLIENT_OVERFLOW_STRIKES.
    hub2 = hub_module.Hub()
    hub2.active["c2"] = object()  # type: ignore[assignment]
    hub2._queues["c2"] = asyncio.Queue(maxsize=4)
    for _ in range(6):
        hub2._send("c2", {"type": "comment", "text": "hi"})
    check("a client under the strike limit keeps its bound",
          hub2._queues["c2"].qsize() == 4, hub2._queues["c2"].qsize())
    check("and is still connected", "c2" in hub2.active, sorted(hub2.active))


async def one_slow_client_does_not_delay_others():
    """Two clients, one draining and one stuck: the healthy one keeps receiving.

    This is the property the per-client queue and writer exist for. Sending
    inline would serialise them behind the stuck socket.
    """
    hub = hub_module.Hub()

    class FakeWS:
        def __init__(self):
            self.sent: list[str] = []

        async def accept(self) -> None:
            return None

        async def send_text(self, text: str) -> None:
            self.sent.append(text)

    healthy_ws = FakeWS()
    stuck_ws = FakeWS()

    hid = await hub.connect(healthy_ws, hub_module.ROOM, "ov")  # type: ignore[arg-type]
    sid = await hub.connect(stuck_ws, hub_module.ROOM, "ov")  # type: ignore[arg-type]

    # Both clients' opening frames are already sent in production before the
    # drain starts, so priming here is what the socket handler does.
    hub.prime(hid)
    hub.prime(sid)

    # Make the stuck client's writer never run, so its queue is the only thing
    # receiving; the healthy one drains normally.
    hub._writers[sid].cancel()

    for i in range(10):
        hub._send(sid, {"type": "comment", "text": f"n{i}"})
        hub._send(hid, {"type": "comment", "text": f"n{i}"})

    # Let the healthy writer drain.
    for _ in range(50):
        await asyncio.sleep(0.005)
        if len(healthy_ws.sent) >= 10:
            break

    check("the healthy client received everything", len(healthy_ws.sent) >= 10, len(healthy_ws.sent))
    check("while the stuck one received nothing", stuck_ws.sent == [], stuck_ws.sent)


async def viewers_coalesce_rather_than_queue():
    """A viewer count is held in its own slot, never queued.

    Only the newest count is ever true, so it must not take a place in line
    behind a backlog of comments — and it must not touch the strike counter,
    which answers "is this client draining?".
    """
    hub = hub_module.Hub()
    cid = "c1"
    hub.active[cid] = object()  # type: ignore[assignment]
    hub._queues[cid] = asyncio.Queue(maxsize=4096)
    hub._strikes[cid] = 7

    for n in (1, 2, 3):
        hub._send(cid, {"type": "viewers", "count": n})

    check("the queue stayed empty", hub._queues[cid].qsize() == 0, hub._queues[cid].qsize())
    check("only the newest count is held", hub._held_viewers[cid]["count"] == 3,
          hub._held_viewers[cid])
    check("and the drain-strike counter was not touched", hub._strikes[cid] == 7, hub._strikes[cid])


async def queued_messages_counts_every_client():
    """The metric reads the hub's own method, not its private map.

    `/metrics` used to sum `hub._queues` directly, so the metric was a caller of
    private bookkeeping and would break silently if that map were renamed or
    split. This pins both halves: the method adds up every client, and an empty
    hub reports zero rather than raising.
    """
    hub = hub_module.Hub()
    check("an empty hub queues nothing", hub.queued_messages() == 0, hub.queued_messages())

    for cid, n in (("c1", 3), ("c2", 2)):
        hub._queues[cid] = asyncio.Queue(maxsize=4096)
        for i in range(n):
            hub._queues[cid].put_nowait({"type": "comment", "text": f"m{i}"})

    check("every client's backlog is counted", hub.queued_messages() == 5, hub.queued_messages())

    # A client that goes away takes its backlog out of the total, or the number
    # would only ever climb.
    hub._queues.pop("c1", None)
    check("a gone client stops counting", hub.queued_messages() == 2, hub.queued_messages())


async def main():
    print("emit does not block on a stuck client")
    await emit_never_blocks()

    print("\none slow client does not delay the others")
    await one_slow_client_does_not_delay_others()

    print("\nviewer counts coalesce")
    await viewers_coalesce_rather_than_queue()

    print("\nthe queue metric adds up the hub's own backlog")
    await queued_messages_counts_every_client()


if __name__ == "__main__":
    asyncio.run(main())
    if FAILS:
        print(f"\n{FAILS} failed of {CHECKS}")
        raise SystemExit(1)
    print(f"\nall passed ({CHECKS} assertions)")
