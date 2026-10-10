"""Measure the three broadcast paths before changing any of them.

The report that raised these asks for numbers before architecture: "measure the
impact before adding architectural complexity", and "fix and measure the
broadcast path before designing a more elaborate queueing system". That is the
right order. Two real bugs in this repo were found by measuring rather than by
reasoning — a layout that silently lost its tier on every shop rebake, and a test
assertion that was measuring a retry's latency instead of its behaviour — and
neither would have been caught by a plausible-sounding redesign.

So this file measures and changes nothing:

- PERF-01: how long a broadcast takes when one recipient is not reading. Each
  client now has its own queue and its own writer task, so this should no longer
  be a function of the slowest client in the set. Measured with one deliberately
  slow socket among several fast ones, waiting for the queues to drain.
- PERF-02: `dispatch` calls `asyncio.create_task` per event with nothing bounding
  it. Measured by how many tasks are alive when events arrive faster than the
  fan-out can finish.
- PERF-03: `store._flush` writes a JSON file synchronously inside an async
  handler. Measured per write, at a realistic number of overlays.

Run with the backend's interpreter:

    apps/api/.venv/bin/python apps/api/tests/measure_broadcast.py
"""

import asyncio
import json
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub import Hub  # noqa: E402
from hub import SEND_TIMEOUT_S  # noqa: E402

SLOW_SEND_S = 0.25  # a browser source that has stalled but is not yet dropped
FAST_CLIENTS = 8


class FakeSocket:
    """A socket whose send can be made to take as long as we like."""

    def __init__(self, name: str, delay: float = 0.0) -> None:
        self.name = name
        self.delay = delay
        self.sent_at: list[float] = []
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def send_text(self, data: str) -> None:
        if self.delay:
            await asyncio.sleep(self.delay)
        self.sent_at.append(time.perf_counter())

    async def receive_text(self) -> str:
        await asyncio.sleep(3600)
        return ""


def stamp(t0: float) -> float:
    return (time.perf_counter() - t0) * 1000


async def measure_perf01() -> None:
    print()
    print("PERF-01 — one slow client among fast ones")
    for label, slow in (("all fast", 0), ("one slow socket", 1)):
        hub = Hub()
        t0 = time.perf_counter()
        slow_id = await hub.connect(
            FakeSocket("slow", SLOW_SEND_S if slow else 0), "overlay", "scene-a"
        )
        for i in range(FAST_CLIENTS):
            await hub.connect(FakeSocket(f"fast{i}"), "overlay", "scene-a")  # type: ignore[arg-type]

        await hub.broadcast({"type": "comment", "text": "halo"}, overlay_id="scene-a")
        # Delivery is queued now, so broadcast returning is not delivery. Wait
        # for the writers to drain before reading timestamps, or this measures
        # the cost of enqueueing and calls it a broadcast.
        deadline = time.perf_counter() + SEND_TIMEOUT_S + 1
        while time.perf_counter() < deadline:
            if all(len(s.sent_at) >= 1 for s in hub.active.values() if s.name.startswith("fast")):
                break
            await asyncio.sleep(0.005)
        wall = stamp(t0)
        fast_socks = [s for s in hub.active.values() if s.name.startswith("fast")]  # type: ignore[union-attr]
        last_fast = max(s.sent_at[-1] for s in fast_socks if s.sent_at)  # type: ignore[union-attr]
        first_fast = min(s.sent_at[0] for s in fast_socks if s.sent_at)  # type: ignore[union-attr]
        for cid in list(hub.active):
            # Without this the writer tasks outlive the run and asyncio reports
            # them as destroyed-while-pending, which buries real warnings.
            hub.disconnect(cid)
        print(f"  {label:16s} wall {wall:7.1f}ms   "
              f"fast spread {stamp(first_fast):6.1f} -> {stamp(last_fast):6.1f}ms   "
              f"all {len(fast_socks)} delivered: {all(len(s.sent_at) == 1 for s in fast_socks)}")  # type: ignore[union-attr]


async def measure_perf02() -> None:
    print()
    print("PERF-02 — tasks created per event, nothing bounding them")
    import events as events_module
    import hub as hub_module

    # A room that receives faster than the fan-out drains.
    received = 0

    class Counting(FakeSocket):
        async def send_text(self, data: str) -> None:
            nonlocal received
            # Slower than a real send, standing in for a fan-out that has work
            # to do rather than an instant no-op.
            await asyncio.sleep(0.002)
            received += 1
            self.sent_at.append(time.perf_counter())

    hub_module.hub = hub = Hub()
    ids = []
    for i in range(4):
        ids.append(await hub.connect(Counting(f"c{i}"), "overlay", "scene-a"))  # type: ignore[arg-type]

    def pending() -> int:
        return sum(1 for t in asyncio.all_tasks() if t is not asyncio.current_task() and "emit" in (t.get_coro().__qualname__ if hasattr(t.get_coro(), "__qualname__") else ""))

    events_module.hub = hub
    baseline = pending()
    burst = 2000
    t0 = time.perf_counter()
    for i in range(burst):
        events_module.dispatch("scene-a", events_module.Event(kind="comment", user=f"u{i}", user_id=f"u{i}", value="x"))
    peak = pending()
    queued = peak - baseline
    await asyncio.sleep(0.05)
    print(f"  dispatched {burst} events in {stamp(t0):7.1f}ms")
    print(f"  emit tasks alive right after the burst: {queued}")
    print(f"  delivered after 50ms: {received} of {burst * 4} fan-out sends")

    t0 = time.perf_counter()
    await asyncio.sleep(1.0)
    print(f"  still pending a second later: {max(0, pending() - baseline)}   ({received} delivered, {stamp(t0):.0f}ms elapsed)")
    for cid in ids:
        hub.disconnect(cid)
    print("  -> nothing bounds this. A room outrunning its own fan-out grows it without limit.")


def measure_perf03() -> None:
    print()
    print("PERF-03 — synchronous JSON write inside an async handler")
    import store

    tmp = Path(tempfile.mkdtemp())
    target = tmp / "overlays.json"
    store.OVERLAYS_FILE = target

    for count in (2, 20, 100, 400):
        # The payload has to go through the module's own cache, because
        # `_flush` serialises `_data()` — writing the file directly just gets
        # overwritten by a cache that was loaded once at import, which measured
        # as a flat 0.3KiB at every size and would have said "fine" about
        # something never actually measured.
        store._cache = {
            f"o{i}": {
                "id": f"o{i}",
                "name": f"overlay {i}",
                "username": f"user{i}",
                "config": {"type": "city", "style": {"max-people": 45, "extra": "x" * 200}},
            }
            for i in range(count)
        }

        times = []
        for _ in range(30):
            t0 = time.perf_counter()
            store._flush()
            times.append((time.perf_counter() - t0) * 1000)
        size = target.stat().st_size
        print(f"  {count:4d} overlays  {size/1024:7.1f}KiB   "
              f"median {statistics.median(times):6.2f}ms   p95 {sorted(times)[int(len(times)*0.95)-1]:6.2f}ms   max {max(times):6.2f}ms")

    print(f"  -> a 60fps frame is 16.7ms. Anything above that is visible stall time on the event loop.")


async def main() -> None:
    print("measuring the current implementation; nothing here is changed")
    await measure_perf01()
    await measure_perf02()
    measure_perf03()
    print()


if __name__ == "__main__":
    asyncio.run(main())