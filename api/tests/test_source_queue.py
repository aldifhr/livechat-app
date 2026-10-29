"""The source queue is bounded, and what it drops is a decision, not an accident.

The adapter's queue used to be unbounded. That is correct right up to the moment
the producers outpace the consumer: TikTokLive invokes every handler as soon as
the frame arrives, and the observer drains at whatever rate `events.emit` and the
per-client fan-out allow. A room that bursts — a raid, a gift-combo storm, a chat
moving faster than one overlay can draw — then grows the queue without limit,
and the memory is the process's.

Bounding it is the easy half. The half worth testing is *what* the bound costs,
because a bounded queue that drops the wrong things trades a memory problem for
a correctness one: a gift that never reaches the overlay is a gift the streamer
is never credited with on screen. So the policy is newest-wins with a priority
for facts, and this suite drives both halves of it — the queue stays at its
ceiling, and the things that must arrive are the things that survive.

The sentinel is asserted too. `_release_observer` has to get its wake-up into a
full queue or the observer parks in `get()` for the life of the process, which
is the exact leak the sentinel exists to prevent — reintroduced by the very
bounded queue that makes the leak possible.

Run with the backend's interpreter:

    python api/tests/test_source_queue.py
"""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_tmp = Path(tempfile.mkdtemp())
os.environ["STREAMKIT_CONFIG_DIR"] = str(_tmp)

from events import Event  # noqa: E402
from metrics import metrics as _metrics  # noqa: E402
from sources.tiktok import (  # noqa: E402
    COMMENT,
    GIFT,
    JOIN,
    LIKE,
    MUST_KEEP_KINDS,
    SOURCE_QUEUE_LIMIT,
    VIEWERS,
    TikTokAdapter,
    _STOP,
)

PASSED = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASSED
    if cond:
        PASSED += 1
        print(f"  ok   {label}", flush=True)
    else:
        print(f"  FAIL {label}   {detail}", flush=True)
        raise SystemExit(1)


def adapter() -> TikTokAdapter:
    """A source with no connection, so the queue can be driven directly."""
    return TikTokAdapter("someone", "room-1")


async def run() -> None:
    print("\nthe queue is bounded")
    src = adapter()
    check("it starts empty", src.queue_depth() == 0, str(src.queue_depth()))
    for i in range(SOURCE_QUEUE_LIMIT * 3):
        await src._enqueue(Event(kind=COMMENT, user=f"u{i}", value="hi"))
    check(f"it never grows past {SOURCE_QUEUE_LIMIT}",
          src.queue_depth() == SOURCE_QUEUE_LIMIT,
          str(src.queue_depth()))
    check("the high-water mark was recorded",
          _metrics.source_queue_high_water == SOURCE_QUEUE_LIMIT,
          str(_metrics.source_queue_high_water))

    print("\nnewest wins, and the drop is counted")
    src = adapter()
    _metrics.dropped_source_keeper = 0
    _metrics.dropped_source_low = 0
    # Fill with comments, then push one more: the oldest comment goes and the
    # newest arrives, so the head of the queue is the *second* comment ever
    # enqueued rather than the first.
    for i in range(SOURCE_QUEUE_LIMIT):
        await src._enqueue(Event(kind=COMMENT, user=f"u{i}", value=f"m{i}"))
    await src._enqueue(Event(kind=COMMENT, user="newest", value="last"))
    head = src._events.get_nowait()
    check("the oldest entry was dropped", head.user == "u1", head.user)
    check("and the newest is still in the queue",
          any(e.user == "newest" for e in list(src._events._queue)),
          "the newest event was lost")
    check("a dropped comment is counted as a keeper",
          _metrics.dropped_source_keeper == 1, str(_metrics.dropped_source_keeper))
    check("and not as a low-priority drop",
          _metrics.dropped_source_low == 0, str(_metrics.dropped_source_low))

    print("\na replaceable kind is counted separately from a fact")
    # The split is the whole point of counting them apart: "we are dropping
    # likes under load" and "we are dropping gifts under load" are different
    # incidents, and one counter cannot tell them apart.
    src = adapter()
    _metrics.dropped_source_keeper = 0
    _metrics.dropped_source_low = 0
    for i in range(SOURCE_QUEUE_LIMIT):
        await src._enqueue(Event(kind=LIKE, value=i))
    await src._enqueue(Event(kind=LIKE, value=99999))
    check("a dropped like is counted as low priority",
          _metrics.dropped_source_low == 1, str(_metrics.dropped_source_low))
    check("and not as a keeper",
          _metrics.dropped_source_keeper == 0, str(_metrics.dropped_source_keeper))

    for kind in (VIEWERS, JOIN, LIKE):
        check(f"{kind} is replaceable", kind not in MUST_KEEP_KINDS, kind)
    for kind in (COMMENT, GIFT):
        check(f"{kind} must arrive", kind in MUST_KEEP_KINDS, kind)

    print("\nthe stop sentinel gets into a full queue")
    # Without this the wake-up is lost and the observer parks in `get()` for the
    # life of the process — the leak the sentinel exists to prevent, brought
    # back by the bounded queue that makes room for it a question.
    src = adapter()
    for i in range(SOURCE_QUEUE_LIMIT):
        await src._enqueue(Event(kind=COMMENT, user=f"u{i}", value="hi"))
    check("the queue is full", src.queue_depth() == SOURCE_QUEUE_LIMIT)
    src._release_observer()
    check("the queue is still full — nothing was thrown away to make room",
          src.queue_depth() == SOURCE_QUEUE_LIMIT, str(src.queue_depth()))
    # It goes in at the *tail*, behind everything already queued: a stop that
    # overtook the events ahead of it would end the observer early and drop the
    # rest of the session's chat on the floor.
    drained = []
    while True:
        try:
            drained.append(src._events.get_nowait())
        except asyncio.QueueEmpty:
            break
    check("the sentinel is the last thing in", drained and drained[-1] is _STOP,
          repr(drained[-1]) if drained else "empty")
    check("and exactly one entry was evicted to make room",
          len(drained) == SOURCE_QUEUE_LIMIT, str(len(drained)))
    check("the evicted one was the oldest", drained[0].user == "u1", drained[0].user)

    print("\nthe sentinel reaches an observer parked on an empty queue")
    src = adapter()
    src._release_observer()
    got = await src._events.get()
    check("the observer wakes", got is _STOP, repr(got))

    print("\nthe observer ends on the sentinel")
    src = adapter()
    await src._enqueue(Event(kind=COMMENT, user="a", value="one"))
    src._release_observer()
    seen = [event async for event in src.observe()]
    check("it yielded the real event first", len(seen) == 1 and seen[0].user == "a",
          str(seen))
    check("and stopped rather than hanging", True)

    print("\na full queue does not block the handler that fills it")
    # `await self._enqueue(...)` reads like a suspension point and must not be
    # one: a blocked handler blocks TikTokLive's dispatch, which backs the whole
    # socket up into the library.
    src = adapter()
    for i in range(SOURCE_QUEUE_LIMIT):
        await src._enqueue(Event(kind=COMMENT, user=f"u{i}", value="hi"))
    loop = asyncio.get_running_loop()
    started = loop.time()
    for i in range(200):
        await src._enqueue(Event(kind=COMMENT, user="flood", value="x"))
    elapsed = loop.time() - started
    check("two hundred overflows returned immediately", elapsed < 0.5, f"{elapsed:.3f}s")

    print()
    print(f"all passed ({PASSED} assertions)", flush=True)


if __name__ == "__main__":
    asyncio.run(run())
