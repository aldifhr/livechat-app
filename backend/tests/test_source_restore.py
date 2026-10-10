"""A backend restart should not kill every live stream.

The channel each room is aimed at was already stored per room — it is what
the editor writes — so the data needed to come back was sitting there and nothing
read it at boot. A restart therefore left every live stream silent until somebody
noticed and called the reconnect endpoint by hand, which on the day this was
written is exactly what happened.

Two things are worth being careful about and neither is the happy path:

- One room that refuses to come back must not stop the others, and must not take
  the API down with it. A backend that cannot start is a backend nobody can reach
  to fix the one that would not connect.
- An room with no channel must be skipped quietly. Most rooms have no
  channel, and logging them would bury the ones that matter.

Run with the backend's interpreter:

    apps/api/.venv/bin/python apps/api/tests/test_source_restore.py
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402
import store  # noqa: E402

state = {"failed": False}


def check(label, cond, detail=""):
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}   {detail}")
        state["failed"] = True


calls: list[tuple[str, str]] = []


async def fake_connect(room_id: str, username: str) -> dict:
    # Async because `restore_sources` awaits it. A synchronous fake failed with
    # "object dict can't be used in 'await' expression" on every call, which made
    # the "one room failing" case pass for the wrong reason — the healthy rooms
    # were failing too, just with a different error.
    calls.append((room_id, username))
    return {"status": "connecting", "username": username, "room_id": room_id}


main._connect_room = fake_connect  # type: ignore[assignment]


def with_rooms(records: dict) -> None:
    store._cache = dict(records)


original_cache = store._cache

print("nothing stored means nothing to restore")
with_rooms({})
calls.clear()

restored = asyncio.run(main.restore_sources())
check("no channels, no reconnects", calls == [], f"called {calls}")
check("and it reports nothing", restored == [], f"got {restored}")

print("an room with a channel comes back on its own")
with_rooms({
    "ov-live": {"id": "ov-live", "username": "room.live", "config": {}},
    "ov-idle": {"id": "ov-idle", "username": "", "config": {}},
})
calls.clear()

restored = asyncio.run(main.restore_sources())
check("only the aimed one is reconnected", calls == [("ov-live", "room.live")], f"called {calls}")
# The report carries the platform: at a glance on a boot log, which room is on
# which source is the first thing anyone asks.
check("and it is reported", restored == ["ov-live@room.live"], f"got {restored}")

print("a leading @ does not change the channel")
with_rooms({"ov": {"id": "ov", "username": "@room.live", "config": {}}})
calls.clear()

asyncio.run(main.restore_sources())
check("the @ is stripped", calls == [("ov", "room.live")], f"called {calls}")

print("whitespace and empties are skipped")
with_rooms({
    "a": {"id": "a", "username": "   "},
    "b": {"id": "b", "username": "@"},
    "c": {"id": "c"},
    "d": {"id": "d", "username": None},
})
calls.clear()

restored = asyncio.run(main.restore_sources())
check("nothing blank is connected", calls == [], f"called {calls}")
check("and nothing blank is reported", restored == [], f"got {restored}")

print("one room failing does not stop the rest")
with_rooms({
    "ov-a": {"id": "ov-a", "username": "a.room"},
    "ov-bad": {"id": "ov-bad", "username": "bad.room"},
    "ov-c": {"id": "ov-c", "username": "c.room"},
})


async def half_broken(room_id: str, username: str) -> dict:
    calls.append((room_id, username))
    if room_id == "ov-bad":
        raise RuntimeError("TikTok refused the connection")
    return {"status": "connecting"}


main._connect_room = half_broken  # type: ignore[assignment]
calls.clear()

restored = asyncio.run(main.restore_sources())
check("the healthy ones still come back",
      ("ov-a", "a.room") in calls and ("ov-c", "c.room") in calls, f"called {calls}")
check("the broken one is not in the report", "ov-bad" not in restored, f"got {restored}")
check("and the others are", len(restored) == 2, f"got {restored}")

print("a config file that cannot be read does not stop the API")


def unreadable():
    raise OSError("permission denied")


main._connect_room = fake_connect  # type: ignore[assignment]
real_all = store.all_rooms
store.all_rooms = unreadable  # type: ignore[assignment]
calls.clear()

try:
    restored = asyncio.run(main.restore_sources())
    check("it survives", restored == [], f"got {restored}")
    check("and connects nothing", calls == [], f"called {calls}")
except Exception as exc:  # noqa: BLE001
    check("it survives", False, f"raised {exc!r}")
finally:
    store.all_rooms = real_all  # type: ignore[assignment]

store._cache = original_cache

print()
if state["failed"]:
    print("FAILED")
    sys.exit(1)
print("all passed")