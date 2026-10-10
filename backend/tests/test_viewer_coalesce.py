"""How viewer counts get coalesced, and what that used to cost the event loop.

The previous version coalesced inside the queue: it asked `qsize()`, pulled the
oldest item, and — when that item was a comment rather than a viewer count —
put it straight back and asked again. That scan is what wedged the backend.

py-spy found the process parked in `qsize()` with the GIL held, which is why the
API stopped answering entirely while the source kept logging events. The frame
here that fails is the whole regression: `qsize` is monkeypatched to raise, and
the hub must not touch it. Any future version that reintroduces the scan fails
loudly instead of hanging a production overlay.
"""

import asyncio
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import hub  # noqa: E402

FAILS: list[str] = []
COUNT = 0


def check(name: str, ok: bool, extra: object = "") -> bool:
    global COUNT
    COUNT += 1
    if not ok:
        FAILS.append(name)
        print(f"  FAIL {name}" + (f" — {extra}" if extra != "" else ""))
    return ok


class FakeWS:
    def __init__(self, delay: float = 0.0) -> None:
        self.delay = delay
        self.sent: list[dict] = []

    async def send_text(self, text: str) -> None:
        import json

        if self.delay:
            await asyncio.sleep(self.delay)
        self.sent.append(json.loads(text))


def attach(h: hub.Hub, cid: str, delay: float = 0.0) -> FakeWS:
    """Register a client and its queue. No writer: these checks read the queue
    directly, and spawning a task needs a running loop."""
    ws = FakeWS(delay)
    any_ws: Any = ws  # the hub is typed for a WebSocket; this is a stand-in
    h.active[cid] = any_ws
    h.overlay_clients[cid] = "ov"
    h._queues[cid] = asyncio.Queue(maxsize=hub.CLIENT_QUEUE_LIMIT)
    return ws


def start_writer(h: hub.Hub, cid: str) -> None:
    """Must be called from inside a running loop."""
    h._writers[cid] = asyncio.create_task(h._writer(cid, h.active[cid]))


async def drain(h: hub.Hub, cid: str, seconds: float = 2.5) -> None:
    await asyncio.sleep(seconds)


print("\nthe hub must never reach into the queue")
h = hub.Hub()
ws = attach(h, "c1")

_pulled = {"n": 0}
_real_get = asyncio.Queue.get_nowait


def counting_get_nowait(self):
    _pulled["n"] += 1
    return _real_get(self)


asyncio.Queue.get_nowait = counting_get_nowait  # type: ignore[assignment]
try:
    # A backlog of chat with a viewer count arriving on top of it: the exact
    # state that used to hang. Each of these pulls the oldest item, sees it is
    # not a viewer count, puts it back and asks again, for ever.
    for i in range(50):
        h._send("c1", {"type": "comment", "user": f"u{i}", "text": "x"})
        h._send("c1", {"type": "viewers", "meta": {"count": i}})
    check("a hundred sends finish", True)
except AssertionError as exc:
    check("a hundred sends finish", False, exc)
finally:
    asyncio.Queue.get_nowait = _real_get  # type: ignore[assignment]
check("and never pull an item out to look at it", _pulled["n"] == 0, _pulled)
check("all fifty comments are still queued", h._queues["c1"].qsize() == 50, h._queues["c1"].qsize())

print("\na viewer count over a backlog must not spin")


async def no_spin() -> float:
    import time

    h = hub.Hub()
    attach(h, "c9")
    for i in range(200):
        h._queues["c9"].put_nowait({"type": "comment", "text": f"c{i}"})
    start = time.perf_counter()
    for n in range(20):
        h._send("c9", {"type": "viewers", "meta": {"count": n}})
    return time.perf_counter() - start


elapsed = asyncio.run(no_spin())
check("twenty sends over a backlog return at once", elapsed < 0.5, f"{elapsed:.3f}s")

print("\nonly the newest viewer count survives")
h = hub.Hub()
ws = attach(h, "c2")
for n in (10, 11, 12, 13):
    h._send("c2", {"type": "viewers", "meta": {"count": n}})
held = h._held_viewers.get("c2")
check("one count is held", held is not None)
check("and it is the newest", held == {"type": "viewers", "meta": {"count": 13}}, held)

print("\ncomments are never dropped or reordered")
h = hub.Hub()
ws = attach(h, "c3")
for i in range(5):
    h._send("c3", {"type": "comment", "text": f"c{i}"})
h._send("c3", {"type": "viewers", "meta": {"count": 99}})
q = h._queues["c3"]
check("all five comments are queued", q.qsize() == 5, q.qsize())
drained = [q.get_nowait() for _ in range(5)]
check("in order", [m["text"] for m in drained] == ["c0", "c1", "c2", "c3", "c4"], drained)

print("\na viewer count goes out on its own, with no chat to carry it")


async def solo() -> list[dict]:
    h = hub.Hub()
    ws = attach(h, "c4")
    start_writer(h, "c4")
    h._send("c4", {"type": "viewers", "meta": {"count": 4242}})
    # Long enough for at least one flush tick.
    await asyncio.sleep(hub.VIEWER_FLUSH_S + 0.4)
    return ws.sent


sent = asyncio.run(solo())
check("it arrives", len(sent) == 1, len(sent))
check("with the right number", bool(sent) and sent[0]["meta"]["count"] == 4242, sent)

print("\nstill under load: comments arrive, and the newest count follows")


async def busy() -> list[dict]:
    h = hub.Hub()
    ws = attach(h, "c5")
    start_writer(h, "c5")
    for i in range(200):
        h._send("c5", {"type": "comment", "text": f"c{i}"})
        if i % 10 == 0:
            h._send("c5", {"type": "viewers", "meta": {"count": i}})
    await asyncio.sleep(0.6)
    return ws.sent


sent = asyncio.run(busy())
comments = [m for m in sent if m["type"] == "comment"]
counts = [m for m in sent if m["type"] == "viewers"]
check("every comment arrived", len(comments) == 200, len(comments))
check("comments kept their order", [m["text"] for m in comments] == [f"c{i}" for i in range(200)])
check("a viewer count went out", len(counts) >= 1, len(counts))
check("only the newest", bool(counts) and counts[-1]["meta"]["count"] == 190, counts[-1] if counts else None)

print("\na disconnect clears the held count")


async def leave() -> dict[str, int]:
    h = hub.Hub()
    ws = attach(h, "c6")
    start_writer(h, "c6")
    h._send("c6", {"type": "viewers", "meta": {"count": 7}})
    held = dict(h._held_viewers)
    h.disconnect("c6")
    return {**{"before": len(held)}, "after": len(h._held_viewers)}


counts_left = asyncio.run(leave())
check("it was held", counts_left["before"] == 1, counts_left)
check("and gone after", counts_left["after"] == 0, counts_left)

print()
if FAILS:
    print(f"{len(FAILS)} failed of {COUNT}")
    for f in FAILS:
        print("  - " + f)
    raise SystemExit(1)
print(f"all passed ({COUNT} assertions)")