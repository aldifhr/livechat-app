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

print()
if FAILS:
    print(f"{len(FAILS)} failed of {COUNT}")
    for f in FAILS:
        print("  - " + f)
    raise SystemExit(1)
print(f"all passed ({COUNT} assertions)")
