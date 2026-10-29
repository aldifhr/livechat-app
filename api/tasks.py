"""Background task ownership.

`asyncio.create_task` returns a task and then forgets it. That is fine for work
that finishes on its own and quietly wrong for everything else: a task nobody
holds a reference to is a task nobody can cancel, nobody can await at shutdown,
and — if it raises — a task whose exception is only reported when the object is
garbage-collected, which for a task that is still referenced by the loop is
never. The observer tasks were exactly that: one per room, spawned inside
`_connect_room`, and on shutdown the sources were stopped (which wakes them)
but nothing ever waited for them to actually finish, so a slow drain could
still be mid-broadcast into a closed socket after the process thought it was
down.

This is the smallest thing that fixes it: a registry the spawn goes through, a
done-callback that takes the task back out and reports an exception if there
was one, and a `shutdown` the lifespan calls so the process waits — bounded —
for the work it started.

Not a `TaskGroup`. A task group scopes tasks to a `async with` block, and these
tasks outlive the block that starts them: an observer runs for as long as its
room is connected, which is the whole point. What is wanted here is ownership,
not structure.
"""

from __future__ import annotations

import asyncio
import logging

from metrics import metrics as _metrics

logger = logging.getLogger("streamkit.tasks")

#: Every live background task this process owns.
_tasks: set[asyncio.Task] = set()


def _retire(task: asyncio.Task) -> None:
    """Take a finished task out of the registry, and say so if it failed."""
    _tasks.discard(task)
    if task.cancelled():
        # Cancellation is how these tasks are stopped; it is not news.
        return
    exc = task.exception()
    if exc is not None:
        # Counted as well as logged: one failure is a line in the journal, a
        # pattern of them is a number on `/metrics`, and only the second one is
        # visible without reading every line since boot.
        _metrics.observer_failures += 1
        logger.error(
            "background task %s ended with %s: %s",
            task.get_name(),
            type(exc).__name__,
            exc,
        )


def spawn(coro, name: str) -> asyncio.Task:
    """Start a background task this process owns and can shut down."""
    task = asyncio.create_task(coro, name=name)
    _tasks.add(task)
    task.add_done_callback(_retire)
    return task


def live() -> int:
    """How many background tasks are running right now."""
    return len(_tasks)


async def shutdown(timeout: float = 5.0) -> int:
    """Cancel every owned task and wait, bounded, for them to finish.

    Returns how many were still running when it was called. Bounded because a
    wedged task must not be able to hold the process open: the sources are
    already stopped by the time this runs, so anything still going after the
    timeout is a bug to be logged by the watchdog, not a reason to hang.
    """
    pending = [task for task in list(_tasks) if not task.done()]
    for task in pending:
        task.cancel()
    if not pending:
        return 0
    try:
        await asyncio.wait_for(
            asyncio.gather(*pending, return_exceptions=True),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        logger.error(
            "%d background task(s) did not finish within %.1fs of shutdown",
            len(pending),
            timeout,
        )
    return len(pending)
