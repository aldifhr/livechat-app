"""The auto-room ceiling has to hold when requests arrive together.

The ceiling used to live in the route, *after* `find_or_create_room_for_username`
had already returned. That is two bugs wearing one coat:

  * the count and the insert were separate steps, so N requests arriving
    together all read the same count and all inserted — the ceiling was a
    number nobody was counting against;
  * a refusal then had to delete the room it had just created, so answering
    "no" cost a create, a flush of the whole store, and a delete — a write
    issued specifically to undo a write that should never have happened.

Both are fixed by moving the check inside the store's critical section, where
the count and the insert are one step. This suite drives that with real
concurrency rather than a sequential loop, because a check that only ever runs
one-at-a-time cannot tell a correct critical section from one that does not
exist — which is precisely how the old version stayed green.

The assertions that matter are the ones about what does *not* happen: no room is
created for a refused handle, and the store does not grow past the limit.

Run with the backend's interpreter:

    python api/tests/test_quota_race.py
"""

import json
import os
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_tmp = Path(tempfile.mkdtemp())
os.environ["STREAMKIT_CONFIG_DIR"] = str(_tmp)

import store  # noqa: E402

store.CONFIG_DIR = _tmp
store.ROOMS_FILE = _tmp / "rooms.json"

LIMIT = 5
PASSED = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASSED
    if cond:
        PASSED += 1
        print(f"  ok   {label}", flush=True)
    else:
        print(f"  FAIL {label}   {detail}", flush=True)
        raise SystemExit(1)


def fresh() -> None:
    store._cache = None
    if store.ROOMS_FILE.exists():
        store.ROOMS_FILE.unlink()


print("\nthe ceiling holds under concurrent requests for different handles")
# Threads, not coroutines: the critical section is a `threading.Lock`, and the
# callers that reach it are `asyncio.to_thread` workers. A single-threaded loop
# cannot express two requests arriving in the same instant, which is the whole
# failure mode.
fresh()
created: list[str] = []
refused: list[str] = []
errors: list[BaseException] = []
lock = threading.Lock()
gate = threading.Barrier(12)


def ask(index: int) -> None:
    try:
        gate.wait()
        record, made = store.find_or_create_room_for_username(f"handle{index}", limit=LIMIT)
        with lock:
            if made:
                created.append(record["id"])
    except store.AutoRoomQuotaError:
        with lock:
            refused.append(f"handle{index}")
    except BaseException as exc:  # noqa: BLE001 — reported below
        with lock:
            errors.append(exc)


threads = [threading.Thread(target=ask, args=(i,)) for i in range(12)]
for t in threads:
    t.start()
for t in threads:
    t.join()

check("nothing raised unexpectedly", not errors, str(errors[:1]))
check(f"exactly {LIMIT} rooms were created", len(created) == LIMIT,
      f"{len(created)} created")
check("the rest were refused", len(refused) == 12 - LIMIT, f"{len(refused)} refused")
check("and the store holds exactly the limit", store.count_auto_rooms() == LIMIT,
      str(store.count_auto_rooms()))
check("the store on disk agrees",
      len(json.loads(store.ROOMS_FILE.read_text())) == LIMIT,
      str(len(json.loads(store.ROOMS_FILE.read_text()))))

print("\nno room is left behind for a handle that was refused")
# The old route created the room and then deleted it, so a refusal was two
# writes and a window where the room existed. Inside the critical section there
# is nothing to clean up, and that is what this asserts.
#
# Driven off the handles that were *actually* refused rather than off an assumed
# ordering: the barrier releases all twelve at once, so which five win is not
# deterministic, and a test that assumed the first five would pass for the wrong
# reason on most runs.
refused_handles = {name for name in refused}
admitted_handles = {f"handle{i}" for i in range(12)} - refused_handles
check("five handles were admitted and seven refused",
      len(admitted_handles) == LIMIT and len(refused_handles) == 12 - LIMIT,
      f"{len(admitted_handles)} admitted, {len(refused_handles)} refused")
for name in sorted(refused_handles):
    check(f"{name} has no room", store.find_room_by_username(name) is None)
for name in sorted(admitted_handles):
    check(f"{name} does have one", store.find_room_by_username(name) is not None)

print("\nan existing room is never blocked by the ceiling")
# A handle a human wired up in the dashboard is not an auto-created room, and
# refusing to connect it would break the room that was working before the store
# filled up. This is the case that makes the ceiling safe to have at all.
fresh()
for i in range(LIMIT + 3):
    store.find_or_create_room_for_username(f"filler{i}", limit=LIMIT + 3)
check("the store is past the ceiling", store.count_auto_rooms() > LIMIT,
      str(store.count_auto_rooms()))
wired = store.create_room("wired by hand", {})
store.update_room(wired["id"], username="already_wired")
record, made = store.find_or_create_room_for_username("already_wired", limit=LIMIT)
check("the existing room is returned", record["id"] == wired["id"], record["id"])
check("and it is not reported as newly created", made is False, str(made))
check("no second room was made for it",
      sum(1 for rec in store.all_rooms().values() if rec.get("username") == "already_wired") == 1)

print("\nthe same handle asked for at once still makes one room")
# The ceiling must not have reopened the hole the single-room guarantee closed.
# Twelve threads, one handle, one limit high enough to admit it all.
fresh()
seen: list[str] = []
errors2: list[BaseException] = []
gate2 = threading.Barrier(12)


def ask_one() -> None:
    try:
        gate2.wait()
        record, _ = store.find_or_create_room_for_username("samehandle", limit=LIMIT)
        with lock:
            seen.append(record["id"])
    except BaseException as exc:  # noqa: BLE001 — reported below
        with lock:
            errors2.append(exc)


threads = [threading.Thread(target=ask_one) for _ in range(12)]
for t in threads:
    t.start()
for t in threads:
    t.join()

check("nothing raised", not errors2, str(errors2[:1]))
check("all twelve got the same room", len(set(seen)) == 1, f"{len(set(seen))} distinct ids")
check("and only one room exists for it",
      sum(1 for rec in store.all_rooms().values() if rec.get("username") == "samehandle") == 1)

print("\nno limit means no ceiling")
fresh()
for i in range(30):
    store.find_or_create_room_for_username(f"free{i}")
check("thirty rooms all exist", store.count_auto_rooms() == 30, str(store.count_auto_rooms()))

print()
print(f"all passed ({PASSED} assertions)", flush=True)
