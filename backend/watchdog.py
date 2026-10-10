"""Noticing that the event loop has stopped, from something the loop cannot stop.

A backend that spins at 100% inside a loop with no `await` cannot report itself.
There is no exception, no log line, no failed request: the socket stays open and
the process stays warm, so every probe that waits for a reply simply waits. That
is exactly what happened in production — the API stopped answering, no error was
ever written, and nothing in the logs distinguished it from a quiet minute.

Anything running *inside* the loop is in the same blind spot, so the observer has
to be a thread. This one keeps a heartbeat the loop is expected to beat; when the
gap between beats passes the stall threshold, it writes a CRITICAL with the stack
of every thread, which is the only place the answer exists.

The cost is one cheap thread and one wakeup a second, and it is deliberately not
shaped like a health check on the API: an endpoint that returns an answer proves
only that someone answered.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time
import traceback

logger = logging.getLogger("streamkit.watchdog")

#: How often the observer looks. Frequent enough to catch a stall promptly, rare
#: enough that it is not itself load.
CHECK_INTERVAL_S = 2.0
#: How long the loop may go without a beat before it is presumed stuck. Three
#: checks: long enough to survive a slow synchronous write, short enough that a
#: wedge is reported while someone is still looking at the log.
STALL_AFTER_S = 6.0
#: The loop beats this often.
BEAT_INTERVAL_S = 1.0


class LivenessWatchdog:
    """Report a loop that has stopped yielding, from outside it."""

    def __init__(
        self,
        *,
        check_interval: float = CHECK_INTERVAL_S,
        stall_after: float = STALL_AFTER_S,
        beat_interval: float = BEAT_INTERVAL_S,
    ) -> None:
        self._check_interval = check_interval
        self._stall_after = stall_after
        self._beat_interval = beat_interval
        self._last_beat = time.monotonic()
        self._lock = threading.Lock()
        self._reported = False
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._heartbeat_task: asyncio.Task[None] | None = None

    # --- the loop's side ---------------------------------------------------
    def beat(self) -> None:
        with self._lock:
            self._last_beat = time.monotonic()
            self._reported = False

    async def heartbeat(self) -> None:
        """The loop's own proof that it is still scheduling work."""
        while True:
            self.beat()
            await asyncio.sleep(self._beat_interval)

    # --- the observer's side ----------------------------------------------
    def _stalled_for(self) -> float:
        with self._lock:
            return time.monotonic() - self._last_beat

    def _stacks(self) -> str:
        frames = ["thread stacks at the time the loop stopped beating:"]
        for frame in sys_frames():
            frames.append(frame)
        return "\n".join(frames)

    def _watch(self) -> None:
        while not self._stop.wait(self._check_interval):
            if self._stalled_for() < self._stall_after:
                continue
            with self._lock:
                if self._reported:
                    # Already said. A stuck loop stays stuck, and writing the
                    # same page of stacks every two seconds buries everything
                    # after it.
                    continue
                self._reported = True
            logger.critical(
                "event loop has not yielded for %.1fs — the API cannot answer requests "
                "and nothing inside the loop can report it. Stacks follow.\n%s",
                self._stalled_for(),
                self._stacks(),
            )

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        # A daemon, so a wedged process can still be killed, and a thread rather
        # than a task, because a task would need the loop it is watching.
        self._thread = threading.Thread(target=self._watch, name="liveness-watchdog", daemon=True)
        self._thread.start()
        try:
            self._heartbeat_task = asyncio.get_running_loop().create_task(self.heartbeat())
        except RuntimeError:
            # No running loop yet. start() is called from lifespan, so this only
            # happens in a test; the observer still works off a stale beat.
            self._heartbeat_task = None

    def stop(self) -> None:
        self._stop.set()
        task, self._heartbeat_task = self._heartbeat_task, None
        if task is not None:
            task.cancel()
        self._thread = None


def sys_frames() -> list[str]:
    """Every thread's current stack, as text. Best effort by definition."""
    frames: list[str] = []
    for frame in sys._current_frames().values():
        frames.extend(traceback.format_stack(frame))
    return frames
