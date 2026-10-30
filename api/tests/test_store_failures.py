"""What the store does when a write cannot reach the disk.

The failure mode this pins is silence. A full disk, a read-only mount or a
volume that went away used to be swallowed: the write raised, nothing caught it
in a way the caller could see, and the operator's saved settings simply were not
there. The fix that landed propagates the failure and keeps the in-memory roster
coherent, so a retry after freeing the disk writes the whole thing rather than a
fragment.

Both halves are load-bearing and both are asserted here. The second one is the
part a future change is most likely to get wrong: rolling the cache back on a
failed flush *looks* like the more principled design — "the cache must never be
ahead of the file" — and for a store that rewrites one whole file it is the worse
outcome, because it throws away a streamer's new room to a transient disk error
that the next successful write would have persisted anyway.

The exception *type* is asserted too, because that is what turns a 500 with a
traceback into a 503 that says the disk is full. `StorageError` subclasses
`OSError` for exactly that reason: the pre-existing contract is "an OSError
reaches the caller", and a new type that broke `isinstance(..., OSError)` would
have been a silent behaviour change dressed up as a refactor.

Run with the backend's interpreter:

    python api/tests/test_store_failures.py
"""

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_tmp = Path(tempfile.mkdtemp())
os.environ["STREAMKIT_CONFIG_DIR"] = str(_tmp)

import store  # noqa: E402

store.CONFIG_DIR = _tmp
store.ROOMS_FILE = _tmp / "rooms.json"

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
    """An empty store on a clean file, with no cached state."""
    store._cache = None
    if store.ROOMS_FILE.exists():
        store.ROOMS_FILE.unlink()


def break_disk():
    """Make every flush fail the way a full disk does: the rename raises.

    Only the final rename is broken, which is what a full disk looks like from
    here — the temp write succeeds and the store is otherwise intact. That is
    the interesting case, because it is the one where the file on disk is still
    good and the only question is what the cache does about it.
    """
    real_replace = store.os.replace

    def failing_replace(src, dst):
        raise OSError(28, "No space left on device")

    store.os.replace = failing_replace
    return real_replace


print("\nthe failure is named, and it is still an OSError")
fresh()
check("StorageError is an OSError", issubclass(store.StorageError, OSError),
      "a caller catching OSError must keep working")
check("AutoRoomQuotaError is not an OSError",
      not issubclass(store.AutoRoomQuotaError, OSError),
      "a quota refusal is not a disk failure and must not be caught as one")

print("\nevery mutator propagates a failed flush, and keeps the mutation")
# The mutation staying in memory is the contract, not an oversight. Each of
# these asserts it, because each of these is a place a future "cleanup" could
# add a rollback and quietly start losing data on a full disk.
#
# The expectation is spelled out per mutator rather than shared, because they do
# different things to the roster and one assertion cannot describe all four.
cases = (
    ("create_room", lambda: store.create_room("during", {"theme": "z"}),
     {"before", "during", "after"}),
    ("update_room", lambda: store.update_room(kept_id, name="renamed"),
     {"renamed", "after"}),
    ("set_config", lambda: store.set_config(kept_id, {"theme": "broken"}),
     {"before", "after"}),
    ("delete_room", lambda: store.delete_room(kept_id),
     {"after"}),
)
for label, mutate, expected in cases:
    fresh()
    kept_id = store.create_room("before", {"theme": "z"})["id"]
    on_disk_before = json.loads(store.ROOMS_FILE.read_text())

    real_replace = break_disk()
    raised = None
    try:
        mutate()
    except OSError as exc:  # noqa: BLE001 — the type is the assertion
        raised = exc
    finally:
        store.os.replace = real_replace

    check(f"{label} raises StorageError", isinstance(raised, store.StorageError), repr(raised))
    check(f"{label} still raises something an OSError handler catches",
          raised is not None, "the failure was swallowed")
    check(f"{label} left the file untouched",
          json.loads(store.ROOMS_FILE.read_text()) == on_disk_before,
          "a write that could not finish modified the live file")

    # The mutation is still in memory, so the retry lands everything the failed
    # write was carrying rather than a fragment of it.
    try:
        store.create_room("after", {"theme": "z"})
    except store.StorageError:
        check(f"{label} retried cleanly", False, "the retry also failed")
        continue
    names = {rec["name"] for rec in store.all_rooms().values()}
    check(f"{label} kept the mutation for the retry",
          names == expected,
          f"expected {sorted(expected)}, got {sorted(names)}")

print("\na read of a missing id costs no write at all")
# A room that does not exist must not flush: with a broken disk that would turn
# a 404 into a 503, and a caller asking about a room that was never there has
# not asked the store to do anything.
fresh()
real_replace = break_disk()
try:
    check("update of a missing id is None", store.update_room("nope", name="x") is None)
    check("set_config of a missing id is False", store.set_config("nope", {}) is False)
    check("delete of a missing id is False", store.delete_room("nope") is False)
    check("username_of a missing id is empty", store.username_of("nope") == "")
    check("provider_of a missing id is empty", store.provider_of("nope") == "")
    check("find_room_by_username of a missing handle is None",
          store.find_room_by_username("nobody") is None)
finally:
    store.os.replace = real_replace

print("\nthe quota refusal is not a disk failure")
fresh()
raised = None
try:
    store.find_or_create_room_for_username("first", limit=0)
except store.AutoRoomQuotaError as exc:
    raised = exc
check("a zero limit refuses", raised is not None, "no exception")
check("and it names the limit", "limit 0" in str(raised), str(raised))
check("no room was created", store.all_rooms() == {}, str(store.all_rooms()))

print("\nthe message carries the reason, for the log line")
fresh()
try:
    store.find_or_create_room_for_username("x", limit=1)
    store.find_or_create_room_for_username("y", limit=1)
except store.AutoRoomQuotaError as exc:
    check("the message is the one the route answers with",
          str(exc) == "too many auto-created rooms (limit 1); delete some first",
          str(exc))

print()
print(f"all passed ({PASSED} assertions)", flush=True)
