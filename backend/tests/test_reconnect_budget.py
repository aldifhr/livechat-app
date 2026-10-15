"""Reconnect budgets that survive a live stream, not just a bad minute.

Three things were each described in a comment as bounding *consecutive* failures
and each actually accumulated for the whole life of the source:

  * the reconnect budget (`_attempt`) was a local in `_run_client`, so ten drops
    spread over an evening — the recoverable case, every one of them — ended the
    source permanently on the tenth;
  * the circuit breaker's sign-failure streak was a local for the same reason;
  * `_running` was never cleared when the loop ended on a live end, so
    `is_running()` reported a dead source as live and the router skipped
    replacing it.

The old suite could not see any of this: `test_live_ended.py` asserts against a
`FakeSource` that checks `_live_ended` first, and no test touched the counters.
These assertions drive the real `TikTokAdapter`, with only the socket replaced.

Run with the backend's interpreter:

    .venv/bin/python tests/test_reconnect_budget.py
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import events  # noqa: E402
import sources.tiktok as tk  # noqa: E402
from TikTokLive.events import ConnectEvent  # noqa: E402

FAILS: list[str] = []
COUNT = 0


def check(name: str, ok: bool, extra: object = "") -> bool:
    global COUNT
    COUNT += 1
    if not ok:
        FAILS.append(name)
        print(f"  FAIL {name}" + (f" — {extra}" if extra != "" else ""))
    return ok


# --------------------------------------------------------------------------
# status_payload, on the real adapter rather than a stand-in
# --------------------------------------------------------------------------

print("\nthe real adapter, just after the live ended")
adapter = tk.TikTokAdapter("someone", "room-1")
# Exactly the state `on_live_end` leaves behind: the flag is set and the connect
# loop has not unwound yet, so `_running` is still true.
adapter._running = True
adapter._connected = False
adapter._live_ended = True
payload = adapter.status_payload()
check("it is told the live ended", payload.get("liveEnded") is True, payload)
check("not that we are still connecting", "connecting" not in payload, payload)
check("and the message says so", "no longer live" in payload["message"], payload)

print("\nthe real adapter while genuinely connecting")
adapter = tk.TikTokAdapter("someone", "room-2")
adapter._running = True
payload = adapter.status_payload()
check("connecting is reported as connecting", payload.get("connecting") is True, payload)
check("and not as an ended live", "liveEnded" not in payload, payload)

print("\nthe real adapter that never ran")
adapter = tk.TikTokAdapter("someone", "room-3")
check("it is Offline", adapter.status_payload()["message"] == "Offline", adapter.status_payload())


# --------------------------------------------------------------------------
# The headcount rides on the connected payload
# --------------------------------------------------------------------------

# The Overview page reads `/api/rooms/{id}/status` rather than the socket, so it
# only ever sees this payload. Without the count here it had nothing to show
# until the next `RoomUserSeqEvent` — and that is edge-triggered, so a room that
# has gone quiet can leave it blank for minutes.
print("\nthe connected payload carries the headcount")
adapter = tk.TikTokAdapter("someone", "room-4")
adapter._running = True
adapter._connected = True
adapter._last_viewers = 1234
payload = adapter.status_payload()
check("it is connected", payload.get("connected") is True, payload)
check("and the viewers are on it", payload.get("viewers") == 1234, payload)

print("\nthe count is the one judge() accepted, not the raw field")
# `_last_viewers` is only ever written from `Verdict.last`, which is the value
# `judge` approved. A count it refused never reaches this payload, so an
# implausible figure cannot be served to the Overview page.
adapter = tk.TikTokAdapter("someone", "room-5")
adapter._running = True
adapter._connected = True
adapter._last_viewers = 0
check("an unmeasured room reports zero rather than nothing",
      adapter.status_payload().get("viewers") == 0, adapter.status_payload())
adapter._last_viewers = 42
check("and a measured one reports its number",
      adapter.status_payload().get("viewers") == 42, adapter.status_payload())

print("\nthe other states are unchanged")
# The count belongs to a live connection. A live that ended, a connection in
# progress and a room that was never read must all answer exactly as before, or
# the Overview page would read a headcount for a stream that is not on.
adapter = tk.TikTokAdapter("someone", "room-6")
adapter._running = True
adapter._connected = False
adapter._live_ended = True
adapter._last_viewers = 999
ended = adapter.status_payload()
check("an ended live says so", ended.get("liveEnded") is True, ended)
check("and carries no viewers", "viewers" not in ended, ended)

adapter = tk.TikTokAdapter("someone", "room-7")
adapter._running = True
adapter._connected = False
adapter._live_ended = False
adapter._last_viewers = 999
connecting = adapter.status_payload()
check("connecting is still connecting", connecting.get("connecting") is True, connecting)
check("and carries no viewers", "viewers" not in connecting, connecting)

adapter = tk.TikTokAdapter("someone", "room-8")
adapter._last_viewers = 999
offline = adapter.status_payload()
check("a source that never ran is Offline", offline.get("message") == "Offline", offline)
check("and carries no viewers", "viewers" not in offline, offline)


# --------------------------------------------------------------------------
# The connect loop, driven for real with the socket replaced
# --------------------------------------------------------------------------

#: A ceiling on the loop. With the fix a healthy source no longer gives up on
#: its own, so without this a regression would show up as a hang rather than a
#: failure. Well past the ten-attempt budget, so it cannot mask a real give-up.
HARD_CAP = 40


def run_loop(adapter, mode, live_end_after=None):
    """Drive `adapter._run_client()` with `start` standing in for the socket.

    `mode` decides what each cycle does:
      * "healthy"  — the handshake completes (ConnectEvent fires, as the library
                     fires it), then the socket closes: a recoverable drop;
      * "fail"     — the connect raises a generic error;
      * "sign"     — the connect raises a sign/block error (trips the breaker).
    """
    cycles = 0
    frames: list[dict] = []

    class FakeClient:
        def __init__(self, unique_id=None, **kw):
            self._handlers: dict = {}

        def on(self, event):
            def deco(fn):
                self._handlers[event] = fn
                return fn
            return deco

        async def start(self):
            nonlocal cycles
            cycles += 1
            if cycles > HARD_CAP:
                # Only reached if the loop refuses to stop on its own. Raising
                # CancelledError unwinds it without a "gave up" frame, and the
                # assertion on `cycles` below reports the real problem.
                raise asyncio.CancelledError
            if mode == "healthy":
                handler = self._handlers.get(ConnectEvent)
                if handler is not None:
                    await handler(None)
                if live_end_after is not None and cycles >= live_end_after:
                    adapter._live_ended = True
                return None  # socket closed; `_run_client` sees a normal drop
            if mode == "sign":
                raise RuntimeError("sign server returned 403 blocked")
            raise RuntimeError("TikTok is having a moment")

        async def disconnect(self):
            return None

    import TikTokLive

    real_client = TikTokLive.TikTokLiveClient
    TikTokLive.TikTokLiveClient = FakeClient

    real_sleep = asyncio.sleep

    async def nosleep(_):
        # Backoff is irrelevant to what is measured; ten-plus cycles would
        # otherwise take minutes of real wall clock.
        await real_sleep(0)

    asyncio.sleep = nosleep

    async def fake_broadcast(message, client_type=None, room_id=None):
        frames.append(message)

    real_broadcast = events.hub.broadcast
    object.__setattr__(events.hub, "broadcast", fake_broadcast)

    try:
        adapter._client = FakeClient(unique_id=adapter.username)
        adapter._running = True
        try:
            asyncio.run(adapter._run_client())
        except asyncio.CancelledError:
            pass  # the hard cap unwinding, already recorded in `cycles`
    finally:
        asyncio.sleep = real_sleep
        TikTokLive.TikTokLiveClient = real_client
        object.__setattr__(events.hub, "broadcast", real_broadcast)

    return cycles, frames


print("\ntwelve healthy drops over one stream, then the live ends")
#: Past the ten the old code gave up at, so reaching this count is the proof.
TARGET = 12
adapter = tk.TikTokAdapter("someone", "room-4")
cycles, frames = run_loop(adapter, "healthy", live_end_after=TARGET)
gave_up = [f for f in frames if "Gave up" in f.get("message", "")]
check("every cycle ran", cycles == TARGET, cycles)
check("the budget was not spent by recoverable drops", not gave_up, [f["message"] for f in gave_up])
check("and the source is not left marked running", adapter.is_running() is False, adapter._running)

print("\na run of failures still exhausts the budget")
adapter = tk.TikTokAdapter("someone", "room-5")
cycles, frames = run_loop(adapter, "fail")
gave_up = [f for f in frames if "Gave up" in f.get("message", "")]
check("it gives up", bool(gave_up), [f["message"] for f in frames])
check("at ten attempts", cycles == 10, cycles)
check("and reports itself not running", adapter.is_running() is False, adapter._running)

print("\nthree consecutive sign failures still trip the breaker")
adapter = tk.TikTokAdapter("someone", "room-6")
cycles, frames = run_loop(adapter, "sign")
check("the breaker trips before the retry budget", cycles == 3, cycles)
check("and reports itself not running", adapter.is_running() is False, adapter._running)


# --------------------------------------------------------------------------
# A streamer who is not live is not a failure
# --------------------------------------------------------------------------

# The bug this pins: `UserOfflineError` reached the generic handler, so an
# offline streamer was retried like a network blip — ten attempts and about two
# minutes of backoff (2s, 4s, 8s … 30s) rediscovering something that was already
# certain, with the app reading "Connecting" throughout. Measured on the real
# thing with `@itswyss`. At the end the source gave up for good, so the stream
# that came later was never picked up and the room stayed dead until somebody
# pressed Connect.
#
# What is pinned here: an offline error spends no retry budget, says so honestly
# instead of claiming to be connecting, keeps a source running so the stream can
# be picked up, and comes back on its own when the streamer does go live.

from TikTokLive.client.errors import UserOfflineError  # noqa: E402


def run_offline(adapter, *, is_live_after=None, polls=None):
    """Drive `_run_client` with the socket refusing because nobody is live.

    `is_live_after` is the poll on which the streamer goes live (1 = the first
    check); `None` means never. Mirrors `run_wait` in `test_live_return`, with
    the whole loop rather than just the wait under test.
    """
    attempts: list[int] = []
    frames: list[dict] = []
    live_checks = [0]
    starts = [0]

    class OfflineClient:
        def __init__(self, unique_id=None, **kw):
            self._handlers: dict = {}

        def on(self, event):
            def deco(fn):
                self._handlers[event] = fn
                return fn
            return deco

        async def start(self):
            starts[0] += 1
            if is_live_after is not None and live_checks[0] >= is_live_after:
                # Back on the air: handshake completes, then the socket drops.
                # CancelledError unwinds instead of looping, because a healthy
                # drop would start spending the budget the test is about.
                handler = self._handlers.get(ConnectEvent)
                if handler is not None:
                    await handler(None)
                raise asyncio.CancelledError
            raise UserOfflineError("The requested TikTok LIVE user is offline.")

        async def is_live(self, uid=None):
            live_checks[0] += 1
            return is_live_after is not None and live_checks[0] >= is_live_after

        async def disconnect(self):
            return None

    import TikTokLive

    real_client = TikTokLive.TikTokLiveClient
    TikTokLive.TikTokLiveClient = OfflineClient

    real_sleep = asyncio.sleep

    async def nosleep(_):
        # The poll interval is 60s; a real clock would make this take hours.
        await real_sleep(0)

    asyncio.sleep = nosleep

    async def fake_broadcast(message, client_type=None, room_id=None):
        frames.append(message)

    real_broadcast = events.hub.broadcast
    object.__setattr__(events.hub, "broadcast", fake_broadcast)

    real_polls = tk._LIVE_WAIT_POLLS
    if polls is not None:
        tk._LIVE_WAIT_POLLS = polls

    # Counted so "the budget was not spent" can be asserted on a number rather
    # than on the absence of a log line.
    real_warning = tk.logger.warning

    def counting_warning(msg, *args, **kw):
        text = msg % args if args else msg
        if "attempt" in text:
            attempts.append(1)
        real_warning(msg, *args, **kw)

    tk.logger.warning = counting_warning

    try:
        adapter._client = OfflineClient(unique_id=adapter.username)
        adapter._running = True
        adapter._stopping = False
        try:
            asyncio.run(adapter._run_client())
        except asyncio.CancelledError:
            pass
    finally:
        asyncio.sleep = real_sleep
        TikTokLive.TikTokLiveClient = real_client
        object.__setattr__(events.hub, "broadcast", real_broadcast)
        tk.logger.warning = real_warning
        if polls is not None:
            tk._LIVE_WAIT_POLLS = real_polls

    return attempts, frames, live_checks[0], starts[0]


print("\nan offline streamer spends no retry budget and says so")
adapter = tk.TikTokAdapter("someone", "room-7")
attempts, frames, checks, starts = run_offline(adapter, is_live_after=3, polls=10)
check("no reconnect attempts were spent", attempts == [], attempts)
# Two starts, and neither is a retry: the first is the attempt that found nobody
# live, the second is the session the poll opened when the streamer came back.
# The count is what proves the second happened without a retry in between.
check("and it opened exactly one new session once the streamer was live", starts == 2, starts)
waiting = [f for f in frames if f.get("waiting")]
check("a waiting frame went out", bool(waiting), [f.get("message") for f in frames])
check("which says the streamer is not live", bool(waiting) and "not live" in waiting[0]["message"], waiting)
check("and is not reported as a live that ended", bool(waiting) and "liveEnded" not in waiting[0], waiting)
check("and it is still marked connecting, so a client keeps waiting",
      bool(waiting) and waiting[0].get("connecting") is True, waiting)
check("it polled for the streamer", checks >= 3, checks)

print("\nand it comes back on its own when the streamer goes live")
check("it asked TikTok whether the streamer was live", checks >= 1, checks)
# The loop only ends here because the fake socket raises CancelledError to unwind;
# what matters is that it got there by itself, without giving up on a retry budget.
check("it reached the live without spending the retry budget", attempts == [], attempts)
# The second start is the rebuilt client opening the session the poll found.
check("a fresh session was opened without anyone pressing Connect", starts >= 2, starts)
back = [f for f in frames if "is live" in f.get("message", "")]
check("and it announced the streamer going live", bool(back), [f.get("message") for f in frames])

print("\nthe status while waiting is honest and escapable")
# Read off the real adapter, because this is what the endpoint serves and what
# the app renders. `waiting` is what gives the user a Stop instead of a disabled
# "Connecting…" for a wait that can last two hours.
adapter = tk.TikTokAdapter("someone", "room-8")
adapter._running = True
adapter._connected = False
adapter._offline_waiting = True
payload = adapter.status_payload()
check("it reports waiting", payload.get("waiting") is True, payload)
check("and connecting, so a client that knows nothing about waiting still waits",
      payload.get("connecting") is True, payload)
check("but not that a live ended", "liveEnded" not in payload, payload)
check("and the message says what is happening", "not live" in payload["message"], payload)

print("\na live that ended and is being waited on is still escapable")
# Found by auditing production: two rooms were mid-wait — the log said "watching
# for it, up to 120 minutes" — while the endpoint served a bare `liveEnded` with
# no `waiting`. The app therefore offered Connect for a room whose source was
# still running, and the wait could not be called off from the UI at all. Same
# trap as the offline case, in the other branch.
adapter = tk.TikTokAdapter("someone", "room-8b")
adapter._running = True
adapter._connected = False
adapter._live_ended = True
adapter._awaiting_live = True
payload = adapter.status_payload()
check("it still says the live ended", payload.get("liveEnded") is True, payload)
check("and that a wait is in progress", payload.get("waiting") is True, payload)
check("so the client can offer a way out", payload.get("connecting") is True, payload)

print("\nbut once the wait has given up it is a plain ended live")
# The budget spent, nothing running: `waiting` must go away, or the app would
# keep offering Stop for a source that is gone.
adapter = tk.TikTokAdapter("someone", "room-8c")
adapter._running = False
adapter._connected = False
adapter._live_ended = True
adapter._awaiting_live = False
payload = adapter.status_payload()
check("it says the live ended", payload.get("liveEnded") is True, payload)
check("and nothing about waiting", "waiting" not in payload, payload)
check("and not that it is connecting", "connecting" not in payload, payload)

print("\na streamer who never goes live gives up after the budget")
adapter = tk.TikTokAdapter("someone", "room-9")
attempts, frames, checks, starts = run_offline(adapter, is_live_after=None, polls=3)
check("it polled exactly the budget, not for ever", checks == 3, checks)
check("still without spending a retry", attempts == [], attempts)
check("and gave up rather than running for ever", adapter.is_running() is False, adapter._running)

print("\nonly an offline error is read this way")
# The distinction is the whole point: a network failure must still be retried,
# or the backoff budget would stop protecting against real blips.
check("a plain error is not offline", tk._is_offline_error(RuntimeError("TikTok is having a moment")) is False)
check("a sign failure is not offline", tk._is_offline_error(RuntimeError("sign server returned 403 blocked")) is False)
check("but UserOfflineError is", tk._is_offline_error(UserOfflineError("offline")) is True)
# The message test is the fallback for a wrapped error, where the type is gone.
check("and a reworded copy of it is still caught",
      tk._is_offline_error(RuntimeError("TikTokLive v7.0.1 -> UserOfflineError")) is True)

print()
if FAILS:
    print(f"{len(FAILS)} failed of {COUNT}")
    for f in FAILS:
        print("  - " + f)
    raise SystemExit(1)
print(f"all passed ({COUNT} assertions)")
