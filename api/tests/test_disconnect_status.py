"""A client already attached is told when a room stops being read.

The bug this pins: `source.stop()` is a teardown and emits nothing. It is not the
adapter's `disconnect()` — that is a lost socket the run loop means to retry, and
it does broadcast — so the three paths that deliberately stop a source all ended
with every attached client holding the last status it was ever handed.

That matters most for the client that never asks again. An OBS overlay attaches
once, at the start of a stream, and reads the status line for the whole session:
told "Connected to @someone" and then nothing, it keeps saying it over a stream
that ended, or over a handle that has been replaced, or over a room that no longer
exists. The app is not the problem case — it reconnects by hand — but the overlay
has no such door.

What is pinned, one test per path:

  * `/api/disconnect` broadcasts a disconnected status after stopping;
  * replacing a room's handle broadcasts, and does so *after* the counters are
    dropped, so the frame cannot resurrect the previous streamer's totals;
  * deleting a room broadcasts, for the same reason;
  * none of them broadcast when there was no source to stop — nothing changed, and
    a client attaching later is told "Offline" at attach anyway.

The tests call the handlers directly, as the other route suites do, with the
source map and the hub replaced by fakes. No server, no socket.

Run with the backend's interpreter:

    .venv/bin/python tests/test_disconnect_status.py
"""

import asyncio
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import eventlog  # noqa: E402
import events  # noqa: E402
import store  # noqa: E402

store.ROOMS_FILE = Path(tempfile.mkdtemp()) / "rooms.json"
store._cache = None

import routes.live as live  # noqa: E402
import routes.rooms as rooms  # noqa: E402
from models import ConnectRequest, UpdateRoomRequest  # noqa: E402

# The handlers take the source map and its lock from state bound at startup. A
# real lock, not a stub: `disconnect` holds it across the pop and the stop, and
# substituting something that does not serialise would test a different function.
_lock = asyncio.Lock()
live.bind_state(live._state["sources"], _lock, events.hub)
rooms.bind_state(rooms._state["sources"], _lock, {})

FAILS: list[str] = []
COUNT = 0


def check(name: str, ok: bool, extra: object = "") -> bool:
    global COUNT
    COUNT += 1
    if not ok:
        FAILS.append(name)
        print(f"  FAIL {name}" + (f" — {extra}" if extra != "" else ""))
    return ok


#: Every status frame the hub was asked to deliver, in order.
sent: list[dict[str, Any]] = []
#: The order in which the paths ran, so "after the stop" can be asserted and not
#: merely hoped for. A frame emitted before the teardown would describe a
#: connection that is still up.
timeline: list[str] = []


class FakeSource:
    """A source that records its own teardown in the shared timeline."""

    def __init__(self, room_id: str, username: str = "someone") -> None:
        self.room_id = room_id
        self.username = username

    def is_running(self) -> bool:
        return True

    async def stop(self) -> None:
        timeline.append("stop")

    def status_payload(self) -> dict[str, Any]:
        return {"type": "status", "connected": True, "message": f"Connected to @{self.username}"}


async def fake_broadcast(message: dict[str, Any], client_type: Any = None, room_id: Any = None) -> None:
    sent.append(message)
    timeline.append(f"broadcast:{message.get('type')}")


real_broadcast = events.hub.broadcast
object.__setattr__(events.hub, "broadcast", fake_broadcast)


def reset() -> None:
    sent.clear()
    timeline.clear()
    live._state["sources"].clear()
    rooms._state["sources"].clear()


def statuses() -> list[dict[str, Any]]:
    return [m for m in sent if m.get("type") == "status"]


print("\nStop tells the clients that are already attached")
reset()
live._state["sources"]["ov-1"] = FakeSource("ov-1")
eventlog._rooms.pop("ov-1", None)
asyncio.run(live.disconnect(ConnectRequest(room_id="ov-1")))
check("a status frame went out", len(statuses()) == 1, statuses())
check("and it says the room is not connected", bool(statuses()) and statuses()[0].get("connected") is False, statuses())
# The teardown must land first: a frame that overtakes it would describe a
# connection that is still up, which is the state this whole path exists to leave.
check(
    "and it was sent after the source was stopped, not before",
    timeline.index("stop") < next(i for i, t in enumerate(timeline) if t.startswith("broadcast")),
    timeline,
)
check("the source is out of the map", "ov-1" not in live._state["sources"], live._state["sources"])

print("\nStop with nothing running says nothing")
# Nothing was stopped, so nothing changed. A frame here would be a disconnect
# reported for a room that was already idle — and a client attaching to a
# source-less room is told "Offline" at attach regardless.
reset()
eventlog._rooms.pop("ov-2", None)
asyncio.run(live.disconnect(ConnectRequest(room_id="ov-2")))
check("no status frame was sent", statuses() == [], statuses())

print("\nReplacing a room's handle tells the clients that are already attached")
reset()
rooms._state["sources"]["ov-3"] = FakeSource("ov-3", username="old_handle")
eventlog._rooms.pop("ov-3", None)
eventlog.set_connected("ov-3", True, "old_handle")
store._cache = {"ov-3": {"id": "ov-3", "username": "old_handle", "config": {}}}
asyncio.run(rooms.update_room("ov-3", UpdateRoomRequest(username="new_handle")))
check("a status frame went out", len(statuses()) == 1, statuses())
check("and it says the room is not connected", bool(statuses()) and statuses()[0].get("connected") is False, statuses())
check(
    "and it was sent after the source was stopped",
    timeline.index("stop") < next(i for i, t in enumerate(timeline) if t.startswith("broadcast")),
    timeline,
)
# The counters are dropped before the frame is sent, and `emit_status` skips its
# own bookkeeping on a disconnect, so the frame cannot bring back the totals that
# belong to the handle that just left.
check(
    "the previous handle's counters did not come back",
    not eventlog.is_connected("ov-3"),
    eventlog.is_connected("ov-3"),
)

print("\nReplacing the handle of a room nobody is reading says nothing")
reset()
store._cache = {"ov-4": {"id": "ov-4", "username": "old_handle", "config": {}}}
asyncio.run(rooms.update_room("ov-4", UpdateRoomRequest(username="new_handle")))
check("no status frame was sent", statuses() == [], statuses())

print("\nDeleting a room tells the clients that are already attached")
# These clients have the least chance of noticing on their own: nothing else will
# ever be produced for this room id, so their last frame stands for ever.
reset()
rooms._state["sources"]["ov-5"] = FakeSource("ov-5")
store._cache = {"ov-5": {"id": "ov-5", "username": "someone", "config": {}}}
asyncio.run(rooms.delete_room("ov-5"))
check("a status frame went out", len(statuses()) == 1, statuses())
check("and it says the room is not connected", bool(statuses()) and statuses()[0].get("connected") is False, statuses())
check(
    "and it was sent after the source was stopped",
    timeline.index("stop") < next(i for i, t in enumerate(timeline) if t.startswith("broadcast")),
    timeline,
)

print("\nDeleting a room nobody is reading says nothing")
reset()
store._cache = {"ov-6": {"id": "ov-6", "username": "someone", "config": {}}}
asyncio.run(rooms.delete_room("ov-6"))
check("no status frame was sent", statuses() == [], statuses())

object.__setattr__(events.hub, "broadcast", real_broadcast)

print()
if FAILS:
    print(f"{len(FAILS)} failed of {COUNT}")
    for f in FAILS:
        print("  - " + f)
    raise SystemExit(1)
print(f"all passed ({COUNT} assertions)")
