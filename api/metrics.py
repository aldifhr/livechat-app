"""In-process counters for the event pipeline, exposed through `/metrics`.

There was no instrumentation anywhere: a dropped event, a coalesced viewer
count, a slow client cut off and a queue grown to its ceiling all looked
exactly like nothing happening. The questions that come up during an incident
— is the pipeline keeping up, is one client the problem, are events being
dropped and where — could only be answered by attaching a socket and reading
it by eye.

A dependency was considered and not added. Prometheus client, `prometheus-client`
or a statsd backend would each be another service in the deployment, another
port, and another thing that has to be up for a number to be readable; the
existing `/metrics` endpoint already answers as JSON for a simple scraper, and
every counter here is a plain integer on one process. What is actually missing
is the *numbers*, not the transport.

Label cardinality is the constraint that shapes this module. A metric with a
username, a message body or a room id in it is a metric that grows without
bound and eventually costs more memory than the thing it measures — so every
counter here is either a single integer or keyed on a **fixed** set: the event
kinds `events.py` defines, and a handful of refusal reasons written as
literals. A new kind is one line in `events.py`; a new reason is one literal
here. Neither is caller-supplied.

Everything is mutated from the event loop and read from the event loop, so
there is no lock. The one exception is `loop_lag_max`, which the watchdog
thread writes from outside the loop; a single float assignment is atomic under
the GIL, and a stale read of a lag figure is not worth a lock.
"""

from __future__ import annotations

from collections import deque
from typing import Any

#: How many recent send latencies to keep for percentiles.
#:
#: A reservoir rather than a full histogram: the question is "what does the
#: tail look like right now", and 512 samples over the last few seconds answers
#: it without an unbounded list or a bucket-boundary argument.
LATENCY_SAMPLES = 512

#: Ceiling on the per-kind event counters. `events.py` defines a fixed set of
#: kinds and `to_wire` maps anything unknown to `alert`, so this can only be
#: reached by a caller constructing `Event` directly with a novel kind — which
#: is exactly the caller that should not be able to grow a dict forever.
MAX_KINDS = 64


class _Latency:
    """Send latencies: count, total, max, and a recent sample for percentiles."""

    __slots__ = ("count", "total", "max", "samples")

    def __init__(self) -> None:
        self.count = 0
        self.total = 0.0
        self.max = 0.0
        self.samples: deque[float] = deque(maxlen=LATENCY_SAMPLES)

    def add(self, seconds: float) -> None:
        self.count += 1
        self.total += seconds
        if seconds > self.max:
            self.max = seconds
        self.samples.append(seconds)

    def percentiles(self, prefix: str = "") -> dict[str, float]:
        """p50/p95/p99 of the recent samples, in milliseconds.

        Nearest-rank on a sorted copy: the sample is small and this is read by
        a human looking at a dashboard, not in a hot loop.

        `prefix` exists because these keys land in a flat JSON object on
        `/metrics`, where a bare `p50_ms` does not say what it is a percentile
        *of* — and the day a second latency is measured, two `p50_ms` keys
        collide and one silently wins. The snapshot passes the prefix; a caller
        that nests the result under its own key (the benchmark does) leaves it
        empty and gets the short names back.
        """
        if not self.samples:
            return {f"{prefix}p50_ms": 0.0, f"{prefix}p95_ms": 0.0, f"{prefix}p99_ms": 0.0}
        ordered = sorted(self.samples)

        def at(fraction: float) -> float:
            index = min(len(ordered) - 1, max(0, int(round(fraction * (len(ordered) - 1)))))
            return ordered[index]

        return {
            f"{prefix}p50_ms": round(at(0.50) * 1000, 3),
            f"{prefix}p95_ms": round(at(0.95) * 1000, 3),
            f"{prefix}p99_ms": round(at(0.99) * 1000, 3),
        }


class Metrics:
    """Every counter the pipeline reports. One instance, module-level."""

    def __init__(self) -> None:
        # --- the event pipeline -------------------------------------------
        #: Events normalised and handed to `hub.broadcast`, by kind.
        self.events_by_kind: dict[str, int] = {}
        #: Events dropped at the source queue because it was full. `low` is a
        #: replaceable update (viewers, likes, joins) and `keeper` is one that
        #: must arrive (a comment, a gift) — the split is the whole point of
        #: counting them separately: one is expected under load and the other
        #: is a room losing chat.
        self.dropped_source_low = 0
        self.dropped_source_keeper = 0
        #: Events dropped at a client queue because it stayed full past the
        #: strike threshold.
        self.dropped_client_overflow = 0
        #: Clients cut off for staying behind, and for a send that failed or
        #: timed out. Counted rather than logged because the log already says
        #: it once and a counter is what shows a pattern.
        self.slow_client_disconnects = 0
        self.dead_client_disconnects = 0
        #: Viewer counts coalesced away by the per-client hold slot.
        self.coalesced_viewers = 0
        #: How long a message waited in a client queue plus its send, from the
        #: moment `events.emit` handed it over.
        self.send_latency = _Latency()
        #: High-water marks, so a spike that has already passed is still
        #: visible. A gauge read at the wrong moment reads zero.
        self.client_queue_high_water = 0
        self.source_queue_high_water = 0

        # --- connections ---------------------------------------------------
        self.ws_connects = 0
        #: Refused handshakes by reason. The reasons are literals in `hub` and
        #: `wsguard`, never caller-supplied.
        self.ws_refused: dict[str, int] = {}
        #: Handshakes that presented a token which did not validate.
        self.ws_token_refused = 0
        self.ws_origin_refused = 0
        #: Sources started and stopped, so a leak shows as a difference that
        #: never returns to zero.
        self.sources_started = 0
        self.sources_stopped = 0

        # --- runtime -------------------------------------------------------
        #: Longest gap between watchdog beats, written from the watchdog
        #: thread. This is the event loop's own lag, which no counter in this
        #: process can see and the watchdog exists to see.
        self.loop_lag_max = 0.0
        #: Observer tasks that ended on an exception rather than a stop.
        self.observer_failures = 0

    # --- recording -------------------------------------------------------
    def event_in(self, kind: str) -> None:
        if kind not in self.events_by_kind and len(self.events_by_kind) >= MAX_KINDS:
            return
        self.events_by_kind[kind] = self.events_by_kind.get(kind, 0) + 1

    def drop_source(self, keeper: bool) -> None:
        if keeper:
            self.dropped_source_keeper += 1
        else:
            self.dropped_source_low += 1

    def drop_client(self) -> None:
        self.dropped_client_overflow += 1

    def slow_client(self) -> None:
        self.slow_client_disconnects += 1

    def dead_client(self) -> None:
        self.dead_client_disconnects += 1

    def coalesce_viewer(self) -> None:
        self.coalesced_viewers += 1

    def sent(self, seconds: float) -> None:
        self.send_latency.add(seconds)

    def note_client_depth(self, depth: int) -> None:
        if depth > self.client_queue_high_water:
            self.client_queue_high_water = depth

    def note_source_depth(self, depth: int) -> None:
        if depth > self.source_queue_high_water:
            self.source_queue_high_water = depth

    def ws_connect(self) -> None:
        self.ws_connects += 1

    def ws_refuse(self, reason: str) -> None:
        self.ws_refused[reason] = self.ws_refused.get(reason, 0) + 1

    def source_started(self) -> None:
        self.sources_started += 1

    def source_stopped(self) -> None:
        self.sources_stopped += 1

    # --- reading ---------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        """Every counter as plain JSON, for `/metrics`.

        Gauges that need a live object (queue depths, task count, memory) are
        filled in by the caller through `runtime`; this method owns only what
        it can answer from its own state.
        """
        out: dict[str, Any] = {
            # The pipeline, as rates would be read off it: what came in, what
            # was dropped and where.
            "events_in_total": sum(self.events_by_kind.values()),
            "events_in_by_kind": dict(self.events_by_kind),
            "events_dropped_source_low_total": self.dropped_source_low,
            "events_dropped_source_keeper_total": self.dropped_source_keeper,
            "events_dropped_client_overflow_total": self.dropped_client_overflow,
            "viewers_coalesced_total": self.coalesced_viewers,
            "slow_client_disconnects_total": self.slow_client_disconnects,
            "dead_client_disconnects_total": self.dead_client_disconnects,
            "client_queue_high_water": self.client_queue_high_water,
            "source_queue_high_water": self.source_queue_high_water,
            # Connections.
            "ws_connects_total": self.ws_connects,
            "ws_refused_total": dict(self.ws_refused),
            "ws_token_refused_total": self.ws_token_refused,
            "ws_origin_refused_total": self.ws_origin_refused,
            "sources_started_total": self.sources_started,
            "sources_stopped_total": self.sources_stopped,
            # Delivery latency: queue wait plus send, ingest to wire. Named
            # `<name>_<unit>` throughout, so the percentile keys carry their unit
            # the same way the average and the maximum do.
            "send_latency_count": self.send_latency.count,
            "send_latency_avg_ms": (
                round(self.send_latency.total / self.send_latency.count * 1000, 3)
                if self.send_latency.count else 0.0
            ),
            "send_latency_max_ms": round(self.send_latency.max * 1000, 3),
            **self.send_latency.percentiles("send_latency_"),
            # The loop's own health.
            "event_loop_lag_max_s": round(self.loop_lag_max, 3),
            "observer_failures_total": self.observer_failures,
        }
        return out


def runtime_gauges() -> dict[str, Any]:
    """Live process gauges, read at scrape time.

    Deliberately cheap and dependency-free: peak RSS from `resource`, the task
    count from `asyncio`, the loop lag from the watchdog's own beat. Current
    RSS is not read because the portable way to get it is a `/proc` read that
    does not exist on macOS and a `ps` fork that is worse than the number is
    worth; the high-water mark answers "is this process growing" for the
    long-running case that matters.
    """
    import asyncio
    import resource

    try:
        # `/metrics` is an async handler, so there is a running loop here; the
        # guard is for a caller that is not (a script, a test) where the count
        # is not worth an exception.
        tasks = len(asyncio.all_tasks())
    except RuntimeError:
        tasks = 0
    gauges: dict[str, Any] = {
        "asyncio_tasks": tasks,
        "memory_peak_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024), 1),
    }
    return gauges


#: The one instance. Imported by the modules that record and by `/metrics`.
metrics = Metrics()

__all__ = ["metrics", "runtime_gauges", "Metrics"]
