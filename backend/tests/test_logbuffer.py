"""The ring buffer behind the dashboard's log page.

The page exists so that "did something just break" can be answered without
shelling into the server, and it is only worth having if what it shows is the
backend's actual output. So what is pinned here is the capture: that a record
logged through the normal `logging` machinery arrives in the ring with its level,
its source and its traceback intact, and that the filters mean what the page says
they mean.

The failure this is written against is the quiet one — a handler attached to the
wrong logger, or one that drops exceptions, gives a log page with holes in it that
looks complete.

Run with the backend's interpreter:

    .venv/bin/python tests/test_logbuffer.py
"""

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import logbuffer  # noqa: E402

FAILS: list[str] = []
COUNT = 0


def check(name: str, ok: bool, extra: object = "") -> bool:
    global COUNT
    COUNT += 1
    if not ok:
        FAILS.append(name)
        print(f"  FAIL {name}" + (f" — {extra}" if extra != "" else ""))
    return ok


def reset() -> None:
    """Empty the ring between cases, so one case's records are not the next's."""
    with logbuffer._lock:
        logbuffer._records.clear()


# A level the test controls, as `logging_setup` does at boot. Without this the root
# logger's default WARNING would drop every `info` the tests emit, and the ring
# would look broken for a reason that has nothing to do with the ring.
logging.getLogger().setLevel(logging.INFO)
logbuffer.install()

print("\nthe ring catches what the backend logs")
reset()
logging.getLogger("streamkit.tiktok").info("@itswyss has no live stream")
out = logbuffer.read(limit=10, min_level="info")
check("a record arrives", len(out["entries"]) == 1, out["entries"])
entry = out["entries"][0]
check("with its level", entry["level"] == "info", entry)
# The prefix is trimmed so the page shows `tiktok`, not `streamkit.tiktok` — the
# common part is the same on every row and would be a column of noise.
check("with its source, prefix trimmed", entry["source"] == "tiktok", entry)
check("with its message", "@itswyss" in entry["message"], entry)
check("and a timestamp", "T" in entry["at"], entry)

print("\nnewest first")
# A log is read from the bottom of the interesting thing upwards, so the page shows
# the most recent record at the top and the ring serves it that way.
reset()
for n in range(5):
    logging.getLogger("streamkit.test").info("message %d", n)
entries = logbuffer.read(limit=10, min_level="info")["entries"]
check("the newest is first", entries[0]["message"] == "message 4", [e["message"] for e in entries])
check("and the oldest is last", entries[-1]["message"] == "message 0", [e["message"] for e in entries])
check("all five are there", len(entries) == 5, len(entries))

print("\nan exception carries its traceback")
# Without this the page can say something failed and not why, which is the half of
# the answer that does not help.
reset()
try:
    raise ValueError("the sign server had a moment")
except ValueError:
    logging.getLogger("streamkit.test").exception("caught it")
entry = logbuffer.read(limit=10, min_level="info")["entries"][0]
check("the record is there", entry["message"] == "caught it", entry)
check("with a traceback", "traceback" in entry, entry)
check("naming the exception", "the sign server had a moment" in entry.get("traceback", ""), entry.get("traceback", "")[:80])
# A record without one must not carry an empty string, or the page would render an
# expandable "trace" that opens onto nothing.
reset()
logging.getLogger("streamkit.test").info("no exception here")
check("and a plain record has none", "traceback" not in logbuffer.read(limit=10, min_level="info")["entries"][0])

print("\nthe level filter is a floor, not a match")
reset()
logging.getLogger("streamkit.test").debug("quiet detail")
logging.getLogger("streamkit.test").info("ordinary")
logging.getLogger("streamkit.test").warning("worth a look")
logging.getLogger("streamkit.test").error("broken")
check("debug is excluded by default", len(logbuffer.read(limit=10)["entries"]) == 3, len(logbuffer.read(limit=10)["entries"]))
# Debug records only reach the ring when the *root logger* lets them through — the
# process is set to INFO at boot, so in production they are filtered before any
# handler sees them. That is the intended behaviour and it is pinned here rather
# than assumed: a page asking for "everything" shows everything the backend
# actually logged, which at the deployed level does not include debug.
logging.getLogger().setLevel(logging.DEBUG)
reset()
logging.getLogger("streamkit.test").debug("quiet detail")
logging.getLogger("streamkit.test").info("ordinary")
check("with the root at DEBUG they arrive", len(logbuffer.read(limit=10, min_level="debug")["entries"]) == 2, len(logbuffer.read(limit=10, min_level="debug")["entries"]))
logging.getLogger().setLevel(logging.INFO)
reset()
logging.getLogger("streamkit.test").debug("quiet detail")
logging.getLogger("streamkit.test").info("ordinary")
logging.getLogger("streamkit.test").warning("worth a look")
logging.getLogger("streamkit.test").error("broken")
# The page's "Errors only" filter is `error`, and it must not also show warnings.
errors = logbuffer.read(limit=10, min_level="error")["entries"]
check("errors only returns errors", len(errors) == 1 and errors[0]["level"] == "error", errors)
warnings = logbuffer.read(limit=10, min_level="warning")["entries"]
check("warnings and up returns both", len(warnings) == 2, [e["level"] for e in warnings])

print("\na level nobody knows falls back rather than failing")
# A mistyped filter should answer with the default view, not a 500 — the page is
# where you go when something is already wrong.
check("an unknown level is treated as info", len(logbuffer.read(limit=10, min_level="bogus")["entries"]) == 3, len(logbuffer.read(limit=10, min_level="bogus")["entries"]))

print("\nthe search looks at the message and the source")
reset()
logging.getLogger("streamkit.tiktok").info("@itswyss has no live stream")
logging.getLogger("streamkit.api").warning("viewer count jumped")
check("a word in the message matches", len(logbuffer.read(limit=10, min_level="info", search="itswyss")["entries"]) == 1)
check("a module name matches", len(logbuffer.read(limit=10, min_level="info", search="tiktok")["entries"]) == 1)
check("case does not matter", len(logbuffer.read(limit=10, min_level="info", search="ITSWYSS")["entries"]) == 1)
check("and a word nobody said matches nothing", len(logbuffer.read(limit=10, min_level="info", search="nothinglikeit")["entries"]) == 0)
check("an empty search is no filter", len(logbuffer.read(limit=10, min_level="info", search="")["entries"]) == 2)
check("whitespace is not a search either", len(logbuffer.read(limit=10, min_level="info", search="   ")["entries"]) == 2)

print("\nthe ring is bounded")
# It is a window, not the archive. Growing without limit would be a memory leak in
# a process that runs for weeks.
reset()
for n in range(logbuffer.CAPACITY + 50):
    logging.getLogger("streamkit.test").info("filler %d", n)
out = logbuffer.read(limit=logbuffer.CAPACITY * 2, min_level="info")
check("it holds exactly its capacity", out["total"] == logbuffer.CAPACITY, out["total"])
check("the newest survived", out["entries"][0]["message"] == f"filler {logbuffer.CAPACITY + 49}", out["entries"][0]["message"])
# And the oldest was dropped rather than kept, which is what "the last N" means.
check("and the oldest was dropped",
      all(e["message"] != "filler 0" for e in out["entries"]))

print("\nthe limit is clamped rather than trusted")
reset()
for n in range(20):
    logging.getLogger("streamkit.test").info("m%d", n)
check("a small limit is honoured", len(logbuffer.read(limit=3, min_level="info")["entries"]) == 3)
check("a huge limit is clamped to what exists", len(logbuffer.read(limit=10_000, min_level="info")["entries"]) == 20)
# Zero and negative are what a malformed query string produces.
check("zero still returns something", len(logbuffer.read(limit=0, min_level="info")["entries"]) >= 1)

print("\ninstalling twice does not double every line")
# `install` is called from the lifespan, which a test client can enter more than
# once. A second handler would put two copies of every record in the ring.
reset()
before = len(logging.getLogger().handlers)
logbuffer.install()
check("no second handler was added", len(logging.getLogger().handlers) == before, len(logging.getLogger().handlers))
logging.getLogger("streamkit.test").info("once only")
entries = logbuffer.read(limit=10, min_level="info")["entries"]
check("so the record appears once", len(entries) == 1, [e["message"] for e in entries])

print()
if FAILS:
    print(f"{len(FAILS)} failed of {COUNT}")
    for f in FAILS:
        print("  - " + f)
    raise SystemExit(1)
print(f"all passed ({COUNT} assertions)")
