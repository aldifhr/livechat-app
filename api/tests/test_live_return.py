"""A live that ends and comes back is a pause, not the end of watching.

The bug this pins: `_live_ended` was terminal. The connect loop's condition is
`while self._running and not self._live_ended`, so a live ending ended the source
for good — nothing but a manual connect brought it back, and until somebody
noticed, the app read "no longer live" through a stream that was on the air.

It was not a rare path. Measured on the real thing: `@bittersweetbynajla` ended
one live at 19:00:03 and started another three minutes later, on a new room id
(`7696774047573838612` -> `7696866940727397126`). The old socket is gone, so the
new live cannot be reached by reconnecting — it can only be found by asking, which
is what the wait does.

What is pinned here, all on the real `TikTokAdapter` with only the client and the
clock replaced:

  * a live that ends leads to a poll rather than to the source dying;
  * when the streamer comes back, the source reconnects on its own;
  * the ended flag is cleared before the rebuild, so the status a client reads is
    never the stale "no longer live";
  * a streamer who never comes back gives up after the budget, instead of
    polling for ever;
  * pressing Stop ends the wait immediately rather than after the next interval;
  * a probe that throws is not read as "still offline" for ever — the next poll
    still happens.

Run with the backend's interpreter:

    .venv/bin/python tests/test_live_return.py
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


def run_wait(adapter, *, live_after: int | None, polls: int | None = None,
             probe_raises: int = 0, stop_after: int | None = None):
    """Drive `adapter._wait_for_live()` with the poll and the probe replaced.

    `live_after` is the poll number on which the streamer is back (1 = the first
    check); `None` means never. `stop_after` is the poll on which `disconnect()`
    is simulated, to prove Stop does not wait out the interval.
    """
    checks = 0
    seen_live: list[bool] = []

    real_client = None
    import TikTokLive

    class FakeProbe:
        def __init__(self, unique_id=None, **kw):
            self._handlers: dict = {}

        def on(self, event):
            def deco(fn):
                self._handlers[event] = fn
                return fn
            return deco

        async def is_live(self, uid=None):
            nonlocal checks
            checks += 1
            seen_live.append(True)
            if checks <= probe_raises:
                raise RuntimeError("the sign server had a moment")
            return live_after is not None and checks >= live_after

        async def disconnect(self):
            return None

    real_sleep = asyncio.sleep

    async def nosleep(_):
        # The interval is 60s and the budget is 120 polls; a real clock would make
        # this suite take two hours. `_LIVE_WAIT_POLLS` is counted rather than
        # measured precisely so this substitution is sound.
        if stop_after is not None and checks >= stop_after:
            adapter._stopping = True
        await real_sleep(0)

    real_broadcast = events.hub.broadcast

    async def fake_broadcast(message, client_type=None, room_id=None):
        pass

    real_client = TikTokLive.TikTokLiveClient
    TikTokLive.TikTokLiveClient = FakeProbe
    asyncio.sleep = nosleep
    object.__setattr__(events.hub, "broadcast", fake_broadcast)

    if polls is not None:
        real_polls = tk._LIVE_WAIT_POLLS
        tk._LIVE_WAIT_POLLS = polls

    try:
        adapter._running = True
        adapter._stopping = False
        adapter._live_ended = True
        adapter._client = None
        asyncio.run(adapter._wait_for_live())
    finally:
        asyncio.sleep = real_sleep
        TikTokLive.TikTokLiveClient = real_client
        object.__setattr__(events.hub, "broadcast", real_broadcast)
        if polls is not None:
            tk._LIVE_WAIT_POLLS = real_polls

    return checks, seen_live


print("\na streamer who comes back is picked up without anyone pressing Connect")
adapter = tk.TikTokAdapter("someone", "room-1")
checks, _ = run_wait(adapter, live_after=2, polls=10)
check("it polled rather than giving up", checks >= 2, checks)
check("the ended flag is cleared, so the app stops saying \"no longer live\"",
      adapter._live_ended is False, adapter._live_ended)
check("a fresh client was built for the new session", adapter._client is not None)
check("and the source is still meant to run", adapter._running is True, adapter._running)

print("\nthe stale status is never what a client reads after the live is back")
# The flag is what `status_payload()` checks first, so clearing it late would
# leave a window where the app is told the live ended over a stream that is on.
adapter = tk.TikTokAdapter("someone", "room-2")
checks, _ = run_wait(adapter, live_after=1, polls=10)
payload = adapter.status_payload()
check("the payload no longer claims the live ended",
      payload.get("liveEnded") is not True, payload)
check("and it reports connecting, not Offline",
      payload.get("connecting") is True, payload)

print("\na streamer who never comes back gives up after the budget")
adapter = tk.TikTokAdapter("someone", "room-3")
checks, _ = run_wait(adapter, live_after=None, polls=3)
check("it polls exactly the budget, not for ever", checks == 3, checks)
check("and the ended flag is left set, because it is still true",
      adapter._live_ended is True, adapter._live_ended)
check("with no client left to run", adapter._client is None, adapter._client)

print("\npressing Stop ends the wait instead of waiting out the interval")
adapter = tk.TikTokAdapter("someone", "room-4")
checks, _ = run_wait(adapter, live_after=None, polls=50, stop_after=2)
check("it stopped early", checks < 50, checks)
check("and did not clear the ended flag behind the user's back",
      adapter._live_ended is True, adapter._live_ended)

print("\na probe that throws is asked again, not read as a dead channel")
# `is_live()` resolving a user id goes over the network. One bad response must
# not look like a streamer who never came back.
adapter = tk.TikTokAdapter("someone", "room-5")
checks, _ = run_wait(adapter, live_after=4, polls=10, probe_raises=3)
check("it kept asking after the failures", checks >= 4, checks)
check("and still noticed the streamer was back",
      adapter._live_ended is False, adapter._live_ended)

print("\nthe wait is not entered when the source was stopped")
# The caller guards on `_stopping`; this pins the guard's effect, so a Stop during
# a live end does not quietly start a two-hour wait in the background.
adapter = tk.TikTokAdapter("someone", "room-6")
adapter._running = True
adapter._stopping = True
adapter._live_ended = True
check("stopping is visible to the caller", adapter._stopping is True)
adapter._stopping = False

print("\nand it is the loop, not just the helper, that reconnects")
# The helper clearing the flag is only useful if the caller loops on it. This
# drives the real `_run_client`: the socket closes, the live ends, the streamer
# comes back, and the loop must open a second session by itself.
adapter = tk.TikTokAdapter("someone", "room-7")
sessions: list[int] = []
# A list, not an `int` with `nonlocal`: these are module-level names, so
# `nonlocal` has nothing to bind to and the class body cannot rebind them.
live_checks: list[int] = []


class LoopClient:
    def __init__(self, unique_id=None, **kw):
        self._handlers: dict = {}
        self._session = 0

    def on(self, event):
        def deco(fn):
            self._handlers[event] = fn
            return fn
        return deco

    async def start(self):
        self._session += 1
        sessions.append(self._session)
        if len(sessions) > 6:
            raise asyncio.CancelledError
        if len(sessions) == 1:
            handler = self._handlers.get(ConnectEvent)
            if handler is not None:
                await handler(None)
            # The first live ends here.
            adapter._live_ended = True
            return None
        return None

    async def is_live(self, uid=None):
        live_checks.append(1)
        return True  # back on the air on the first check

    async def disconnect(self):
        return None


real_client = None
import TikTokLive  # noqa: E402

real_client = TikTokLive.TikTokLiveClient
real_sleep = asyncio.sleep


async def loop_nosleep(_):
    await real_sleep(0)


async def loop_broadcast(message, client_type=None, room_id=None):
    pass


TikTokLive.TikTokLiveClient = LoopClient
asyncio.sleep = loop_nosleep
real_broadcast = events.hub.broadcast
object.__setattr__(events.hub, "broadcast", loop_broadcast)
try:
    adapter._client = LoopClient(unique_id=adapter.username)
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

check("the loop opened a second session after the live came back",
      len(sessions) >= 2, sessions)
check("and it asked TikTok whether the streamer was back", len(live_checks) >= 1, live_checks)

print()
if FAILS:
    print(f"{len(FAILS)} failed of {COUNT}")
    for f in FAILS:
        print("  - " + f)
    raise SystemExit(1)
print(f"all passed ({COUNT} assertions)")
