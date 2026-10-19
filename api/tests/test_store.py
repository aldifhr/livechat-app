"""Regression tests for the persistence layer.

Separate from `test_api.py` because this is a different kind of test: those
exercise the HTTP contract, this one exercises the properties the store has to
hold when two things touch it at once or when the process dies mid-write. Those
are the cases the route tests cannot reach, because TestClient is single-threaded
and never crashes halfway through a save.

Every test here was written after a real bug, and the bug is named in the title
so a future failure points at the thing that regressed rather than at a line
number. Run: python apps/api/test_store.py
"""

import json
import os
import sys
import tempfile
import threading
from pathlib import Path

# `apps/api`, not this directory: the modules under test live one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

_tmp = Path(tempfile.mkdtemp())
os.environ["STREAMKIT_CONFIG_DIR"] = str(_tmp)

import store  # noqa: E402

store.CONFIG_DIR = _tmp
store.ROOMS_FILE = _tmp / "rooms.json"
# The module caches the parsed file forever, so a test that writes it has to
# invalidate that cache or the next test reads the previous test's data.
store._cache = None

failures: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        failures.append(label)


def fresh() -> None:
    """An empty store on disk and in the cache."""
    store._cache = None
    store.ROOMS_FILE.unlink(missing_ok=True)


print("concurrent creates all survive")
# The original loader re-read and re-wrote the whole file per request, so two
# writes in the same tick each held their own copy and the loser was discarded
# silently. Fifty at once is a reasonable stand-in for a burst of users.
fresh()
created = []
lock = threading.Lock()


def make(i: int) -> None:
    rec = store.create_room(f"room {i}", {"theme": "streamline"})
    with lock:
        created.append(rec["id"])


threads = [threading.Thread(target=make, args=(i,)) for i in range(50)]
for t in threads:
    t.start()
for t in threads:
    t.join()
check("all 50 created", len(created) == 50, f"got {len(created)}")
check("all 50 unique", len(set(created)) == 50)
on_disk = json.loads(store.ROOMS_FILE.read_text())
check("all 50 on disk", len(on_disk) == 50, f"got {len(on_disk)}")
check("no id lost", set(created) <= set(on_disk))

print("a torn file is quarantined, not fatal")
# A half-written file used to raise out of _data() on the next request and take
# the whole API down with it, since every route reads the store.
store._cache = None
store.ROOMS_FILE.write_text('{"broken": tru', encoding="utf-8")
recs = store.all_rooms()
check("read survives a corrupt file", recs == {}, json.dumps(recs)[:80])
check(
    "the bad copy is kept for inspection",
    store.ROOMS_FILE.with_suffix(".json.corrupt").exists(),
)
check("the live file is usable again", store.create_room("after", {})["id"])

print("writes are atomic")
# A reader must never see a partial file, so the write goes to a temp file and
# is renamed. The rename is what guarantees that; writing in place does not.
fresh()
store.create_room("keeper", {"theme": "x"})
stop = threading.Event()
torn: list[str] = []


def writer() -> None:
    i = 0
    while not stop.is_set():
        store.create_room(f"churn {i}", {"theme": "y"})
        i += 1


def reader() -> None:
    for _ in range(300):
        if stop.is_set():
            return
        try:
            json.loads(store.ROOMS_FILE.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001 - the point is that none escape
            torn.append(type(exc).__name__)
            return


w = threading.Thread(target=writer)
r = threading.Thread(target=reader)
w.start()
r.start()
r.join(timeout=5)
stop.set()
w.join()
check("a reader never saw a half-written file", not torn, f"saw {torn[:2]}")

print("a failed write is loud, and the roster is not corrupted")
# A full disk used to be invisible: the write was swallowed, the API answered
# 200, and the operator's saved settings simply were not there. Propagating is
# the better failure — they see the error and can act on it. What still has to
# hold is that the in-memory roster stays coherent, so a retry after freeing the
# disk writes the whole thing rather than a fragment.
fresh()
kept_id = store.create_room("before the failure", {"theme": "z"})["id"]
saved_on_disk = json.loads(store.ROOMS_FILE.read_text())

# Only the final rename fails, which is what a full disk looks like from here:
# the temp write succeeds and the store is otherwise intact.
real_replace = store.os.replace


def failing_replace(src, dst):
    raise OSError("no space left on device")


raised = None
failed_id = None
try:
    store.os.replace = failing_replace
    failed_id = store.create_room("during the failure", {"theme": "z"})["id"]
except OSError as exc:
    raised = exc
finally:
    store.os.replace = real_replace

check("the failure reaches the caller", isinstance(raised, OSError), repr(raised))
check("the file on disk is untouched by a failed write",
      json.loads(store.ROOMS_FILE.read_text()) == saved_on_disk,
      "the live file was modified by a write that could not finish")
check("what was already saved is still readable", kept_id in store.all_rooms())

# The retry is the part that matters: the room that failed to persist is
# still in memory, so writing again lands both records rather than a fragment.
store.create_room("after the retry", {"theme": "z"})
names = {rec["name"] for rec in store.all_rooms().values()}
check("nothing was lost across the failure",
      {"before the failure", "during the failure", "after the retry"} <= names,
      json.dumps(sorted(names)))

print("get_room hands back a copy")
# A caller that mutated the returned dict would be editing the cache without
# going through _flush, and the next save would write it back as if it were real.
fresh()
only_id = store.create_room("isolated", {"theme": "original"})["id"]
stolen = store.get_room(only_id)
assert stolen is not None
stolen["name"] = "tampered"
stolen["config"]["theme"] = "tampered"
kept = store.get_room(only_id)
assert kept is not None
check("mutating the result does not touch the store", kept["name"] == "isolated",
      json.dumps(kept))

print("update and delete report honestly")
fresh()
oid = store.create_room("target", {"theme": "t"})["id"]
check("update of a missing id is None", store.update_room("nope", name="x") is None)
check("update returns the record", store.update_room(oid, name="renamed")["name"] == "renamed")
check("an unset field is left alone", store.get_room(oid)["config"] == {"theme": "t"})
check("delete of a missing id is False", store.delete_room("nope") is False)
check("delete returns True once", store.delete_room(oid) is True)
check("delete twice is False", store.delete_room(oid) is False)

print("username_of is safe on a missing id")
check("missing id gives an empty string", store.username_of("nope") == "")

print("a config directory that does not exist yet is created whole")
# STREAMKIT_CONFIG_DIR is a path the deploy chose, and it is the sort of path that
# arrives several levels deep and empty — a persistent volume mounted at
# /var/lib/myapp. `mkdir(exist_ok=True)` creates only the last component, so the
# first write raised FileNotFoundError and the request that created the room
# failed with a 500 that said nothing about a directory. The default
# `api/config` already exists, which is why a checkout never saw it.
deep = _tmp / "var" / "lib" / "myapp" / "streamkit" / "config"
store.CONFIG_DIR = deep
store.ROOMS_FILE = deep / "rooms.json"
store._cache = None
check("the parent really is missing first", not deep.parent.exists())

made = store.create_room("on a fresh volume", {"theme": "deep"})
check("creating a room works", bool(made["id"]))
check("the whole path was created", deep.is_dir(), str(deep))
check("the file landed in it", (deep / "rooms.json").exists())
check(
    "the room is on disk",
    made["id"] in json.loads((deep / "rooms.json").read_text(encoding="utf-8")),
)

# A second write, because the first one only has to create the directory; the
# update is what proves the store is usable rather than merely writable.
store.set_config(made["id"], {"theme": "changed"})
store.update_room(made["id"], name="renamed on a fresh volume")

# Reloaded from disk with the cache dropped, so this is what a process restart
# would see rather than what this process happens to still be holding.
store._cache = None
reloaded = store.get_room(made["id"])
check("the update survived a reload", reloaded is not None and reloaded["config"] == {"theme": "changed"},
      json.dumps(reloaded))
check("the rename survived a reload", reloaded is not None and reloaded["name"] == "renamed on a fresh volume")
check("a second room also writes", bool(store.create_room("second", {})["id"]))

# Back to the shared directory for anything that follows.
store.CONFIG_DIR = _tmp
store.ROOMS_FILE = _tmp / "rooms.json"
store._cache = None

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("all passed")
