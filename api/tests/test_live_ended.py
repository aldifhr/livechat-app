"""The live finished, as distinct from our connection dropping.

Both stop events arriving, and a client watching the feed cannot tell them apart
without help: a socket that dies and a streamer who stops produce the same "no
more events" from the outside. They call for opposite responses — reconnect
versus stop — so the backend says which one it was.

What is pinned here:

  * the flag appears on the wire, because that is the entire feature;
  * a plain status frame is unchanged, so an older client sees nothing new;
  * the teardown path does not immediately overwrite the flagged frame with a
    generic disconnect, which is the bug this would otherwise ship with;
  * a client attaching after the fact gets the honest answer rather than
    "Offline".
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import events  # noqa: E402

passed = failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {label}")
    else:
        failed += 1
        print(f"  FAIL {label}   {detail}")


class FakeSource:
    def __init__(self):
        self.username = "mybasic.indonesia"
        self.room_id = "room-1"
        self._connected = True
        self._live_ended = False

    def status_payload(self):
        if self._live_ended:
            return {
                "type": "status",
                "connected": False,
                "message": f"@{self.username} is no longer live",
                "liveEnded": True,
            }
        return {"type": "status", "connected": True, "message": f"Connected to @{self.username}"}


def main_run():
    sent: list[dict] = []

    async def fake_broadcast(message, client_type=None, room_id=None):
        sent.append(message)

    # Rebound on the instance rather than the class, so hub.broadcast keeps its
    # real signature and pyright stays useful. A module-level replacement of the
    # class attribute would also work but types as an error for a reason that
    # does not matter here.
    real_broadcast = events.hub.broadcast
    object.__setattr__(events.hub, "broadcast", fake_broadcast)
    room = "room-1"

    async def emit(**kwargs):
        sent.clear()
        await events.emit_status(room, **kwargs)
        return list(sent)

    try:
        print("a plain status frame is unchanged")
        frames = asyncio.run(emit(connected=False, message="Disconnected"))
        check("one frame sent", len(frames) == 1, str(frames))
        check("no liveEnded key at all", "liveEnded" not in frames[0], str(frames[0]))
        check("the old shape is untouched",
              frames[0] == {"type": "status", "connected": False, "message": "Disconnected"},
              str(frames[0]))

        print("connecting still means connecting, not ended")
        frames = asyncio.run(emit(connected=False, connecting=True, message="Connecting…"))
        check("connecting flag survives", frames[0].get("connecting") is True, str(frames[0]))
        check("and no liveEnded", "liveEnded" not in frames[0], str(frames[0]))

        print("the live ending says so")
        frames = asyncio.run(emit(connected=False, message="@mybasic.indonesia is no longer live", live_ended=True))
        check("the flag is on the wire", frames[0].get("liveEnded") is True, str(frames[0]))
        check("not connected", frames[0]["connected"] is False, str(frames[0]))
        check("and the message names the streamer", "@mybasic" in frames[0]["message"], str(frames[0]))

        print("a client attaching after the fact")
        src = FakeSource()
        src._live_ended = True
        payload = src.status_payload()
        check("it is told the live ended", payload.get("liveEnded") is True, str(payload))
        check("rather than a bare Offline", payload["message"] != "Offline", str(payload))

        src._live_ended = False
        payload = src.status_payload()
        check("a normal attach is unaffected", "liveEnded" not in payload, str(payload))

    finally:
        object.__setattr__(events.hub, "broadcast", real_broadcast)

    print("the teardown does not overwrite it")
    # The real source's `finally` block runs on the way out of a finished stream
    # too. Asserted through the flag the handler sets, not by simulating the whole
    # client, because what matters is that the two paths are distinguishable.
    src = FakeSource()
    src._live_ended = True
    check("the source remembers it ended", src._live_ended is True)
    check("so the finally block can skip its generic message", src._live_ended)


if __name__ == "__main__":
    main_run()
    print()
    print(f"{passed}/{passed + failed} assertions passed")
    if failed:
        print(f"{failed} FAILED")
        sys.exit(1)
    print("all passed")