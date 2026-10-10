"""The one instrument that can see a loop which has stopped yielding.

Every other check in this backend runs inside the event loop: an endpoint, a
queue depth, a source status. The production failure this exists for defeated all
of them — the API stopped answering, the process was alive and warm at 100% CPU,
and nothing in the log said so, because a loop with no `await` cannot log.

So these tests assert the observer reports a stale heartbeat, reports it once, and
stays quiet while the loop is beating. They drive the clock directly rather than
sleeping, so they test the decision rather than the timing.
"""

import asyncio
import logging
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from watchdog import BEAT_INTERVAL_S, LivenessWatchdog, STALL_AFTER_S  # noqa: E402

FAILS: list[str] = []
COUNT = 0


def check(name: str, ok: bool, extra: object = "") -> bool:
    global COUNT
    COUNT += 1
    if not ok:
        FAILS.append(name)
        print(f"  FAIL {name}" + (f" — {extra}" if extra != "" else ""))
    return ok


class Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    @property
    def criticals(self) -> list[logging.LogRecord]:
        return [r for r in self.records if r.levelno >= logging.CRITICAL]


watchdog_log = logging.getLogger("streamkit.watchdog")

print("\na heartbeat that is fresh is not a stall")
w = LivenessWatchdog(check_interval=0.01, stall_after=5.0, beat_interval=0.01)
cap = Capture()
watchdog_log.addHandler(cap)
watchdog_log.setLevel(logging.DEBUG)
w.start()
for _ in range(20):
    w.beat()
    time.sleep(0.01)
check("nothing is reported", cap.criticals == [], len(cap.criticals))

print("\na heartbeat that stopped is a stall")
# Age the beat past the threshold without waiting for it.
w._last_beat = time.monotonic() - (STALL_AFTER_S + 1)
for _ in range(5):
    time.sleep(0.02)
check("it is reported", len(cap.criticals) >= 1, len(cap.criticals))
if cap.criticals:
    msg = cap.criticals[0].getMessage()
    check("the report names the symptom", "cannot answer" in msg, msg[:80])
    check("and says the loop stopped beating", "not yielded" in msg, msg[:80])
    check("and carries stacks", "_watch" in msg or "File " in msg, msg[-120:])

print("\nreported once, not every tick")
before = len(cap.criticals)
w._last_beat = time.monotonic() - (STALL_AFTER_S + 1)
for _ in range(20):
    time.sleep(0.02)
check("a stuck loop is not re-reported", len(cap.criticals) == before, f"{before} -> {len(cap.criticals)}")

print("\na resumed loop silences it again")
w.beat()
check("the report is cleared", w._reported is False, w._reported)

print("\nthe defaults are ordered so a stall is reported before anyone gives up")
check("the loop beats faster than it is checked", BEAT_INTERVAL_S < 2.0, BEAT_INTERVAL_S)
check("the stall threshold is several checks", STALL_AFTER_S >= 3 * 2.0, STALL_AFTER_S)

print("\nthe heartbeat runs inside the loop, so a stuck loop stops it")


async def beating() -> int:
    w = LivenessWatchdog(check_interval=0.01, stall_after=0.05, beat_interval=0.01)
    w.start()
    await asyncio.sleep(0.12)
    return w._heartbeat_task is not None and not w._heartbeat_task.done()


check("it is scheduled and keeps beating", asyncio.run(beating()) is True)


async def cancelled() -> bool:
    w = LivenessWatchdog(check_interval=0.01, stall_after=5.0, beat_interval=0.01)
    w.start()
    running = w._heartbeat_task is not None
    w.stop()
    await asyncio.sleep(0.03)
    return running and (w._heartbeat_task is None or w._heartbeat_task.cancelled() or w._heartbeat_task.done())


check("and it is stopped on shutdown", asyncio.run(cancelled()) is True)

print("\nan observer with no loop still works, which is how a test uses it")
w.stop()
w = LivenessWatchdog(check_interval=0.01, stall_after=0.0, beat_interval=1.0)
w.start()
time.sleep(0.05)
w.stop()
check("starting without a running loop does not raise", True)

watchdog_log.removeHandler(cap)

print()
if FAILS:
    print(f"{len(FAILS)} failed of {COUNT}")
    for f in FAILS:
        print("  - " + f)
    raise SystemExit(1)
print(f"all passed ({COUNT} assertions)")