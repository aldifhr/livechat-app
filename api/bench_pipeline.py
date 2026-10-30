"""Measure the event pipeline, so a claim about it is a measurement.

There was no way to ask "is this keeping up" without attaching a socket and
reading it by eye, which means every performance statement about this backend
has been a feeling. This drives the real pipeline — `events.emit` through
`hub.broadcast` to real per-client queues and writer tasks — at a controlled
rate, with a controlled number of rooms and clients, and reports what happened.

Nothing here is a load test in the sense of finding a breaking point. It is a
*comparison* harness: run it before a change, run it after, and the numbers are
comparable because the inputs are the same. The absolute figures depend entirely
on the machine.

What it reports, and why each one is there:

  throughput      events per second actually delivered, against the rate asked
                  for. The gap between the two is the pipeline falling behind.
  latency p50/95/99  queue wait plus send, from `events.emit` to the bytes
                  leaving. The tail is the number that matters: an overlay is a
                  browser, and a browser that is 400ms behind is visibly behind.
  queue high water  the deepest any single client queue reached. A number
                  pinned at the limit means clients are not draining.
  drops           events dropped at the source queue and at client queues,
                  split by kind. Zero is the expected result at a rate the
                  pipeline can hold; a non-zero number at a low rate is a bug.
  loop lag        the longest gap between watchdog beats, which is the event
                  loop's own lag and the one number nothing inside the process
                  can see for itself.
  memory          peak RSS, so a leak shows as a number that climbs between two
                  runs of the same configuration.

Usage:

    python api/bench_pipeline.py
    python api/bench_pipeline.py --rooms 4 --clients 8 --rate 500 --duration 20
    python api/bench_pipeline.py --slow-clients 2 --rate 2000
    python api/bench_pipeline.py --mix viewers,likes,comments --rate 1000
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

_tmp = Path(tempfile.mkdtemp())
os.environ["STREAMKIT_CONFIG_DIR"] = str(_tmp)

import events  # noqa: E402
from events import Event  # noqa: E402
from hub import OVERLAY, ROOM, hub  # noqa: E402
from metrics import metrics as _metrics, runtime_gauges  # noqa: E402

#: The kinds the emitter cycles through, and their relative weight in the
#: default mix. Weighted towards the cheap ones because that is what a real
#: room looks like: a busy chat is mostly comments and likes, with a gift every
#: so often and a viewer count on its own interval.
DEFAULT_MIX = {
    "comment": 60,
    "like": 25,
    "join": 8,
    "gift": 4,
    "follow": 2,
    "share": 1,
}


class BenchSocket:
    """A websocket that records what it was sent and how long each send took.

    `delay` is what makes a client slow: the writer's `send_text` suspends, the
    queue backs up behind it, and the pipeline's behaviour under a client that
    is not keeping up becomes measurable rather than theoretical.
    """

    def __init__(self, delay: float = 0.0) -> None:
        self.delay = delay
        self.sent = 0
        self.bytes_out = 0
        self.closed: tuple[int, str] | None = None

    async def accept(self) -> None:
        return None

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)

    async def send_text(self, text: str) -> None:
        if self.delay:
            await asyncio.sleep(self.delay)
        self.sent += 1
        self.bytes_out += len(text)


def reset_metrics() -> None:
    """Zero every counter, so one run's numbers are one run's numbers."""
    _metrics.events_by_kind.clear()
    _metrics.dropped_source_low = 0
    _metrics.dropped_source_keeper = 0
    _metrics.dropped_client_overflow = 0
    _metrics.slow_client_disconnects = 0
    _metrics.dead_client_disconnects = 0
    _metrics.coalesced_viewers = 0
    _metrics.client_queue_high_water = 0
    _metrics.source_queue_high_water = 0
    _metrics.send_latency.count = 0
    _metrics.send_latency.total = 0.0
    _metrics.send_latency.max = 0.0
    _metrics.send_latency.samples.clear()
    _metrics.loop_lag_max = 0.0


def build_mix(spec: str) -> dict[str, int]:
    """`comments,likes` or `comment:60,like:25` into a weighted kind map."""
    if not spec:
        return dict(DEFAULT_MIX)
    weights: dict[str, int] = {}
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        kind, _, weight = part.partition(":")
        weights[kind.strip()] = int(weight) if weight.strip() else 1
    return weights or dict(DEFAULT_MIX)


def pick_kind(mix: dict[str, int]) -> str:
    total = sum(mix.values())
    roll = random.uniform(0, total)
    for kind, weight in mix.items():
        roll -= weight
        if roll <= 0:
            return kind
    return next(iter(mix))


def make_event(kind: str, index: int, payload_bytes: int) -> Event:
    """One event of `kind`, shaped the way the TikTok adapter shapes it.

    The shapes matter: `eventlog.record` calls `.split()` on a comment's text,
    and a like carries its count in `meta` rather than in `value` — which is
    what the real adapter does. An event built with the wrong shape is not a
    benchmark input, it is a crash.
    """
    if kind == "comment":
        text = ("x" * max(1, payload_bytes - 32)) + f"{index:08d}"
        return Event(kind="comment", user=f"bench{index % 500}", user_id=f"b{index % 500}",
                     value=text)
    if kind == "gift":
        return Event(kind="gift", user=f"bench{index % 50}", user_id=f"b{index % 50}",
                     value="Rose",
                     meta={"giftName": "Rose", "value": 1, "count": 1})
    if kind == "viewers":
        count = 1000 + (index % 500)
        return Event(kind="viewers", value=count, meta={"count": count})
    if kind == "follow":
        return Event(kind="follow", user=f"bench{index % 300}", user_id=f"b{index % 300}")
    if kind == "share":
        return Event(kind="share", user=f"bench{index % 300}", user_id=f"b{index % 300}")
    if kind == "join":
        return Event(kind="join", user=f"bench{index % 800}", user_id=f"b{index % 800}")
    return Event(kind="like", user=f"bench{index % 400}", user_id=f"b{index % 400}",
                 meta={"count": 1, "totalLikes": index})


async def attach_clients(room_ids: list[str], per_room: int, slow: int) -> tuple[list[BenchSocket], int]:
    """Attach `per_room` clients to every room, `slow` of them lagging on send.

    Returns the sockets and how many handshakes the hub refused. The refusal
    count is reported rather than ignored: `hub.connect` answers an empty string
    and closes the socket when a cap is reached, so a configuration that asks
    for more clients per room than `MAX_CLIENTS_PER_ROOM` silently attaches
    fewer than it claims — and a benchmark that does not say so is measuring a
    different configuration from the one it printed.
    """
    sockets: list[BenchSocket] = []
    refused = 0
    slow_left = slow
    for room_id in room_ids:
        for _ in range(per_room):
            # The first `slow` clients in the whole run are the slow ones, so a
            # run with two of them has two rather than two per room.
            delay = 0.02 if slow_left > 0 else 0.0
            if slow_left > 0:
                slow_left -= 1
            socket = BenchSocket(delay)
            client_id = await hub.connect(socket, OVERLAY, room_id)  # type: ignore[arg-type]
            if not client_id:
                refused += 1
                continue
            sockets.append(socket)
    # The opening frames are written straight to the socket by the route in the
    # real app; here there are none, so the writer starts immediately.
    for client_id in list(hub.active):
        hub.prime(client_id)
    return sockets, refused


async def run_bench(args: argparse.Namespace) -> dict:
    reset_metrics()
    room_ids = [f"bench-room-{i}" for i in range(args.rooms)]
    sockets, refused = await attach_clients(room_ids, args.clients, args.slow_clients)
    total_clients = len(sockets)

    mix = build_mix(args.mix)
    interval = 1.0 / args.rate if args.rate > 0 else 0.0

    print(f"  rooms={args.rooms} clients={total_clients} "
          f"(slow={args.slow_clients}) rate={args.rate}/s "
          f"duration={args.duration}s payload={args.payload}B")
    print(f"  mix={mix}")
    if refused:
        # Said out loud, because the alternative is a report that describes a
        # configuration the run did not actually use.
        print(f"  NOTE {refused} handshake(s) refused at admission "
              f"(per-room cap is {hub.MAX_CLIENTS_PER_ROOM}); "
              f"they are not counted anywhere below.")

    emitted = 0
    started = time.perf_counter()
    next_tick = started
    deadline = started + args.duration

    try:
        while time.perf_counter() < deadline:
            # Pace against a schedule rather than sleeping a fixed interval, so
            # a slow iteration does not permanently reduce the rate — it catches
            # up on the next tick instead.
            next_tick += interval
            kind = pick_kind(mix)
            room_id = random.choice(room_ids)
            await events.emit(room_id, make_event(kind, emitted, args.payload))
            emitted += 1
            now = time.perf_counter()
            if now < next_tick:
                await asyncio.sleep(min(next_tick - now, deadline - now))
    finally:
        elapsed = time.perf_counter() - started

    # Let the writers drain what is already queued, so the numbers describe the
    # run rather than the moment it stopped. The deadline has to be generous
    # when a client is deliberately slow: a client that takes 20ms per send and
    # is sitting on a few thousand queued messages needs a minute, not ten
    # seconds, and cutting it off early would report a backlog that was still
    # draining rather than one that had stalled.
    drain_started = time.perf_counter()
    drain_deadline = drain_started + args.drain
    while time.perf_counter() < drain_deadline:
        if hub.queued_messages() == 0:
            break
        await asyncio.sleep(0.05)
    drain_seconds = time.perf_counter() - drain_started

    delivered = sum(socket.sent for socket in sockets)
    lat = _metrics.send_latency.percentiles()

    report = {
        "config": {
            "rooms": args.rooms,
            "clients_attached": total_clients,
            "clients_refused_at_admission": refused,
            "slow_clients": args.slow_clients,
            "rate_requested": args.rate,
            "duration_s": round(elapsed, 2),
            "payload_bytes": args.payload,
            "mix": mix,
        },
        "throughput": {
            "events_emitted": emitted,
            "events_per_s_emitted": round(emitted / elapsed, 1) if elapsed else 0.0,
            "messages_delivered": delivered,
            "messages_per_s_delivered": round(delivered / elapsed, 1) if elapsed else 0.0,
            # The opening config and status frames each client gets on attach
            # are not counted as delivered events; they are subtracted so the
            # delivered figure is comparable to the emitted one.
            "delivered_minus_opening_frames": delivered - total_clients * 2,
        },
        "latency_ms": {
            "count": _metrics.send_latency.count,
            "avg": round(_metrics.send_latency.total / _metrics.send_latency.count * 1000, 3)
            if _metrics.send_latency.count else 0.0,
            "max": round(_metrics.send_latency.max * 1000, 3),
            # `avg` and `max` are exact over every send in the run. The
            # percentiles are not: they come from a bounded reservoir of the
            # most recent sends, so when some clients lag they describe the
            # laggards rather than the population. Both are reported, labelled,
            # and neither is presented as the other.
            "percentile_window_sends": len(_metrics.send_latency.samples),
            **lat,
        },
        "drops": {
            "source_low_priority": _metrics.dropped_source_low,
            "source_keeper": _metrics.dropped_source_keeper,
            "client_overflow": _metrics.dropped_client_overflow,
            "viewers_coalesced": _metrics.coalesced_viewers,
        },
        "clients": {
            "slow_disconnects": _metrics.slow_client_disconnects,
            "dead_disconnects": _metrics.dead_client_disconnects,
            "still_attached": len(hub.active),
            "queue_high_water": _metrics.client_queue_high_water,
            "queued_now": hub.queued_messages(),
            "drain_seconds": round(drain_seconds, 2),
        },
        "runtime": {
            "event_loop_lag_max_s": round(_metrics.loop_lag_max, 4),
            **runtime_gauges(),
        },
    }

    for client_id in list(hub.active):
        hub.disconnect(client_id)
    await asyncio.sleep(0)
    return report


def render(report: dict) -> None:
    print()
    print("  throughput")
    for key, value in report["throughput"].items():
        print(f"    {key:<32} {value}")
    print("  latency (queue wait + send, ingest to wire)")
    for key, value in report["latency_ms"].items():
        print(f"    {key:<32} {value}")
    print("      avg and max are exact over every send; the percentiles cover only")
    print(f"      the most recent {report['latency_ms']['percentile_window_sends']} sends, so a run")
    print("      with lagging clients describes the laggards in its tail.")
    print("  drops")
    for key, value in report["drops"].items():
        print(f"    {key:<32} {value}")
    print("  clients")
    for key, value in report["clients"].items():
        print(f"    {key:<32} {value}")
    print("  runtime")
    for key, value in report["runtime"].items():
        print(f"    {key:<32} {value}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark the StreamKit event pipeline.")
    parser.add_argument("--rooms", type=int, default=2, help="rooms receiving events")
    parser.add_argument("--clients", type=int, default=4, help="clients attached per room")
    parser.add_argument("--rate", type=float, default=200.0, help="events per second to emit")
    parser.add_argument("--duration", type=float, default=10.0, help="seconds to run for")
    parser.add_argument("--drain", type=float, default=60.0,
                        help="seconds to let writers drain after the run stops")
    parser.add_argument("--payload", type=int, default=120, help="comment payload size in bytes")
    parser.add_argument("--slow-clients", type=int, default=0,
                        help="how many clients lag on every send (20ms each)")
    parser.add_argument("--mix", type=str, default="",
                        help="comma-separated kinds, optionally weighted: comment:60,like:25")
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    parser.add_argument("--seed", type=int, default=1234, help="seed for the mix and room choice")
    args = parser.parse_args()

    if args.rate < 0 or args.duration <= 0:
        parser.error("--rate must be >= 0 and --duration must be > 0")

    random.seed(args.seed)
    report = asyncio.run(run_bench(args))
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        render(report)


if __name__ == "__main__":
    main()
