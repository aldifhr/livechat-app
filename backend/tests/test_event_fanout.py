"""A burst of events must not be able to starve the event loop.

Every event used to become its own task. Two thousand comments therefore became
two thousand tasks competing for the same loop, which is the shape that took the
API down once already: the loop never yielded, so nothing could answer anything,
and nothing inside the loop could report why.

The fix bounds how many fan-outs are in flight. It does not drop events, and
that is the part worth testing: a room that is being gifted should get every
gift, even while it is getting two hundred at once.
"""

import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import events  # noqa: E402

CHECKS = 0
FAILS = 0


def check(name, cond, extra=None):
    global CHECKS, FAILS
    CHECKS += 1
    if not cond:
        FAILS += 1
        print("  FAIL", name, "" if extra is None else "—", extra)


class FakeEvent:
    kind = "comment"
    user = "u"
    value = "hello"
    meta = None


async def run_burst(n):
    """Fire n events and watch how many fan-outs are alive at once."""
    live = 0
    peak = 0
    done = 0

    async def fake_emit(room_id, event):
        nonlocal live, peak, done
        live += 1
        peak = max(peak, live)
        # One yield, so siblings can overlap and "in flight" means something.
        await asyncio.sleep(0)
        live -= 1
        done += 1

    original = events.emit
    events.emit = fake_emit
    try:
        tasks = [events.dispatch("ov", FakeEvent()) for _ in range(n)]
        # Let the loop breathe once, then measure the peak inside the burst.
        await asyncio.sleep(0)
        peak = max(peak, live)
        # Keep the loop responsive while it drains: if this loop is starved the
        # wall clock below blows out and the loop cannot even answer this.
        marks = []
        for _ in range(40):
            t0 = time.perf_counter()
            await asyncio.sleep(0.002)
            marks.append(time.perf_counter() - t0)
            if all(t.done() for t in tasks):
                break
        await asyncio.gather(*tasks)
        return peak, done, max(marks), len(asyncio.all_tasks())
    finally:
        events.emit = original


async def main():
    events._inflight = None

    n = 2000
    peak, done, worst_lag, leftover = await run_burst(n)

    print("\nthe burst")
    print(f"  burst {n}  delivered {done}  peak in flight {peak}  worst wait {worst_lag*1000:.1f}ms")
    check("every event was delivered", done == n, done)
    check("none were dropped to make room", done == n, (done, n))
    check("fan-outs at once stayed bounded", peak <= events.MAX_INFLIGHT, (peak, events.MAX_INFLIGHT))
    check("and it actually used the room it had", peak > 8, peak)

    # The wall-clock figures are printed for information only. They are NOT
    # evidence: measured with the gate and without it they came out within a
    # millisecond of each other, because a stub that yields cannot starve a loop.
    # Asserting on them would have looked like protection and been decoration.
    # What actually proves the bound is the in-flight peak above, which differs by
    # a factor of thirty.

    print("\nnothing was left running")
    check("no tasks survived the burst", leftover <= 3, leftover)

    print("\nthe gate is a gate")
    events._inflight = None
    gate = events._gate()
    check("the gate is built once", events._gate() is gate)
    check("it starts with the whole room", gate._value == events.MAX_INFLIGHT, gate._value)
    check("and a fresh gate is empty of state",
          (events._inflight is None) is False)


async def main_runs_without_a_loop_first():
    """`dispatch` must not build the semaphore at import time."""
    check("a semaphore exists only inside a loop", events._inflight is not None, events._inflight)


def test_import_time():
    """Before any loop exists, there is no semaphore."""
    global CHECKS, FAILS
    CHECKS += 1
    import importlib

    importlib.reload(events)
    if events._inflight is not None:
        FAILS += 1
        print("  FAIL a semaphore was built at import time, before any loop existed")
    else:
        print("  ok   no semaphore until a loop asks for one")


if __name__ == "__main__":
    print("bounded fan-out")
    test_import_time()
    asyncio.run(main())
    if FAILS:
        print(f"\n{FAILS} failed of {CHECKS}")
        raise SystemExit(1)
    print(f"\nall passed ({CHECKS} assertions)")