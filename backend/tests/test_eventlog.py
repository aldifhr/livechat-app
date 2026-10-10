"""The event log has to survive being read by a person under pressure.

These assert the two things that actually get asked of it: did anything arrive,
and was it the same person every time. A log that prints but cannot answer those
is worse than no log, because it looks like an answer.
"""

import io
import logging
import os
import sys
from pathlib import Path

# `apps/api`, not this directory: the modules under test live one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import eventlog  # noqa: E402

passed = 0
failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {label}")
    else:
        failed += 1
        print(f"  FAIL {label}   {detail}")


def capture(fn=None):
    """Run fn with the log pointed at a string buffer."""
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(logging.Formatter("%(message)s"))
    log = logging.getLogger("streamkit.events")
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    try:
        if fn is not None:
            fn()
    finally:
        log.removeHandler(handler)
    return buf.getvalue()


print("counts are per kind, and they are sequential")
out = capture(lambda: [
    eventlog.record("comment", user="Udang", text="GG"),
    eventlog.record("comment", user="Monmon", text="kelaz"),
    eventlog.record("comment", user="Udang", text="GG lagi"),
    eventlog.record("like", user="S.R.M", meta={"count": 5}),
])
check("the first comment is #1", "comment #1" in out)
check("the second is #2", "comment #2" in out)
check("the third is #3", "comment #3" in out)
check("a different kind starts at 1 again", "like #1" in out)
check("the speaker is named", "Udang" in out)
check("the text is included", "kelaz" in out)
check("a like batch shows its multiplier", "x5" in out)

eventlog.set_connected(True, "@reset")
print("a kind that never arrives is visible as such")
# The question this log exists to answer: is the kind being produced at all. If
# the counter never moves there is no line at all, which is the answer — but only
# if the absence can be told from silence.
out = capture(lambda: [eventlog.record("comment", user="A", text="x") for _ in range(3)])
check("comments were counted", "comment #3" in out)
check("gift produced no line", "gift" not in out)

eventlog.set_connected(True, "@reset")
print("long text is trimmed to one line")
out = capture(lambda: eventlog.record("comment", user="A", text="x" * 300))
line = [l for l in out.strip().splitlines() if l][0]
check("one line only", len(out.strip().splitlines()) == 1, out[:200])
check("trimmed to 60 characters", "x" * 60 in line and "x" * 61 not in line)

eventlog.set_connected(True, "@reset")
print("newlines in a message cannot forge log lines")
# A comment containing a newline would otherwise write a line that looks like a
# real entry, which is the one way a log of untrusted text can lie.
out = capture(lambda: eventlog.record("comment", user="A", text="hi\nERROR fake line"))
check("the text is collapsed to one line", len(out.strip().splitlines()) == 1, repr(out))

eventlog.set_connected(True, "@reset")
print("viewers is state, not activity")
# Counted as an event it would arrive roughly once a second and bury every
# comment, so it is printed as a value instead.
out = capture(lambda: [
    eventlog.record("viewers", meta={"count": 11634}),
    eventlog.record("viewers", meta={"count": 11700}),
])
check("the value is printed", "viewers=11634" in out and "viewers=11700" in out)
check("it is not numbered as an event", "viewers #" not in out)
snap = eventlog.snapshot()
check("the latest count is kept", snap["viewers"] == 11700)

print("a new connection resets the counters")
eventlog.set_connected(True, "@chan")
for i in range(5):
    eventlog.record("comment", user=f"u{i}", text="x")
before = eventlog.snapshot()["totals"]["comment"]
check("five counted", before == 5, str(before))
eventlog.set_connected(True, "@other")
check("reset on reconnect", eventlog.snapshot()["totals"].get("comment", 0) == 0)
check("still connected", eventlog.is_connected() is True)
eventlog.set_connected(False, "")
check("a disconnect is recorded", eventlog.is_connected() is False)

print("repeats are counted, because one person filling the chat is a problem")
eventlog.set_connected(True, "@chan")
for _ in range(4):
    eventlog.record("comment", user="Spammer", text="buy this")
snap = eventlog.snapshot()
check("the same person four times", snap["totals"]["comment"] == 4)
check("three were repeats of the last", snap["repeats"]["comment"] == 3, str(snap["repeats"]))

print("an event with nothing in it does not crash the log")
# The log runs in emit, on the hot path of every event. A handler raising here
# would take down the broadcast with it, so the shapes have to be survivable.
for bad in [None, "", {}, []]:
    capture(lambda b=bad: eventlog.record("comment", user=b or "", text=b or ""))
check("odd values survive", True)

print()
if failed:
    print("FAILED")
    sys.exit(1)
print(f"all passed ({passed} assertions)")
