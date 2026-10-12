"""The event log has to survive being read by a person under pressure.

These assert the two things that actually get asked of it: did anything arrive,
and was it the same person every time. A log that prints but cannot answer those
is worse than no log, because it looks like an answer.

Every counter belongs to a room, so most of what follows uses one room and says
so with `_ROOM`. The last block is the point of the module: two rooms live at
once, and neither may answer for the other.
"""

import io
import logging
import sys
from pathlib import Path

# `apps/api`, not this directory: the modules under test live one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import eventlog  # noqa: E402

passed = 0
failed = 0

# One room for everything that is not about room isolation. Any id will do; a
# real one would read more like the thing being tested.
_ROOM = "room-under-test"


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
    eventlog.record(_ROOM, "comment", user="Udang", text="GG"),
    eventlog.record(_ROOM, "comment", user="Monmon", text="kelaz"),
    eventlog.record(_ROOM, "comment", user="Udang", text="GG lagi"),
    eventlog.record(_ROOM, "like", user="S.R.M", meta={"count": 5}),
])
check("the first comment is #1", "comment #1" in out)
check("the second is #2", "comment #2" in out)
check("the third is #3", "comment #3" in out)
check("a different kind starts at 1 again", "like #1" in out)
check("the speaker is named", "Udang" in out)
check("the text is included", "kelaz" in out)
check("a like batch shows its multiplier", "x5" in out)
check("the room is named on every line", out.count(f"[{_ROOM}]") == 4, out[:200])

eventlog.set_connected(_ROOM, True, "@reset")
print("a kind that never arrives is visible as such")
# The question this log exists to answer: is the kind being produced at all. If
# the counter never moves there is no line at all, which is the answer — but only
# if the absence can be told from silence.
out = capture(lambda: [eventlog.record(_ROOM, "comment", user="A", text="x") for _ in range(3)])
check("comments were counted", "comment #3" in out)
check("gift produced no line", "gift" not in out)

eventlog.set_connected(_ROOM, True, "@reset")
print("long text is trimmed to one line")
out = capture(lambda: eventlog.record(_ROOM, "comment", user="A", text="x" * 300))
line = [l for l in out.strip().splitlines() if l][0]
check("one line only", len(out.strip().splitlines()) == 1, out[:200])
check("trimmed to 60 characters", "x" * 60 in line and "x" * 61 not in line)

eventlog.set_connected(_ROOM, True, "@reset")
print("newlines in a message cannot forge log lines")
# A comment containing a newline would otherwise write a line that looks like a
# real entry, which is the one way a log of untrusted text can lie.
out = capture(lambda: eventlog.record(_ROOM, "comment", user="A", text="hi\nERROR fake line"))
check("the text is collapsed to one line", len(out.strip().splitlines()) == 1, repr(out))

eventlog.set_connected(_ROOM, True, "@reset")
print("viewers is state, not activity")
# Counted as an event it would arrive roughly once a second and bury every
# comment, so it is printed as a value instead.
out = capture(lambda: [
    eventlog.record(_ROOM, "viewers", meta={"count": 11634}),
    eventlog.record(_ROOM, "viewers", meta={"count": 11700}),
])
check("the value is printed", "viewers=11634" in out and "viewers=11700" in out)
check("it is not numbered as an event", "viewers #" not in out)
snap = eventlog.snapshot(_ROOM)
check("the latest count is kept", snap["viewers"] == 11700)

print("a new connection resets the counters")
eventlog.set_connected(_ROOM, True, "@chan")
for i in range(5):
    eventlog.record(_ROOM, "comment", user=f"u{i}", text="x")
before = eventlog.snapshot(_ROOM)["totals"]["comment"]
check("five counted", before == 5, str(before))
eventlog.set_connected(_ROOM, True, "@other")
check("reset on reconnect", eventlog.snapshot(_ROOM)["totals"].get("comment", 0) == 0)
check("still connected", eventlog.is_connected(_ROOM) is True)
eventlog.set_connected(_ROOM, False, "")
check("a disconnect is recorded", eventlog.is_connected(_ROOM) is False)

print("repeats are counted, because one person filling the chat is a problem")
eventlog.set_connected(_ROOM, True, "@chan")
for _ in range(4):
    eventlog.record(_ROOM, "comment", user="Spammer", text="buy this")
snap = eventlog.snapshot(_ROOM)
check("the same person four times", snap["totals"]["comment"] == 4)
check("three were repeats of the last", snap["repeats"]["comment"] == 3, str(snap["repeats"]))

print("an event with nothing in it does not crash the log")
# The log runs in emit, on the hot path of every event. A handler raising here
# would take down the broadcast with it, so the shapes have to be survivable.
for bad in [None, "", {}, []]:
    capture(lambda b=bad: eventlog.record(_ROOM, "comment", user=b or "", text=b or ""))
check("odd values survive", True)

print("the leaderboard ranks by messages, and only comments count")
eventlog.set_connected(_ROOM, True, "@chan")
for name, n in [("ana", 3), ("budi", 5), ("citra", 1)]:
    for _ in range(n):
        eventlog.record(_ROOM, "comment", user=name, text="hi", user_id=name)
# A gift is not someone talking, so it must not climb the board.
eventlog.record(_ROOM, "gift", user="ana", text="Rose", meta={"count": 1})
top = eventlog.top_chatters(_ROOM)
check("ranked most messages first", [c["nickname"] for c in top] == ["budi", "ana", "citra"], str(top))
check("the counts are right", top[0]["messages"] == 5 and top[1]["messages"] == 3, str(top))
check("a gift did not add to the chatter's count", top[1]["messages"] == 3, str(top))

print("one person is one row however the display name is spelled")
# Keyed on the stable handle: the same account showing two nicknames is one
# chatter, not two, or the leaderboard splits them and undercounts both.
eventlog.set_connected(_ROOM, True, "@chan")
eventlog.record(_ROOM, "comment", user="Ana", text="a", user_id="u1")
eventlog.record(_ROOM, "comment", user="anaaa", text="b", user_id="u1")
top = eventlog.top_chatters(_ROOM)
check("one row for the stable id", len(top) == 1 and top[0]["messages"] == 2, str(top))

print("the board is capped at ten")
eventlog.set_connected(_ROOM, True, "@chan")
for i in range(15):
    eventlog.record(_ROOM, "comment", user=f"user{i}", text="hi", user_id=f"user{i}")
check("at most ten are ranked", len(eventlog.top_chatters(_ROOM)) == 10, str(len(eventlog.top_chatters(_ROOM))))

print("a room nobody has heard from answers empty rather than raising")
# The WebSocket is unauthenticated and the room id arrives in the URL, so a read
# for a room that does not exist is a thing a stranger can ask for. It must not
# raise, and it must not allocate: an entry created here would be one an
# anonymous caller could grow at will.
empty = eventlog.snapshot("never-seen-this-room")
check("it is not connected", empty["connected"] is False)
check("no counters", empty["totals"] == {} and empty["viewers"] is None)
check("an empty leaderboard", eventlog.top_chatters("never-seen-this-room") == [])
check("reading did not allocate", "never-seen-this-room" not in eventlog._rooms)

print("two rooms do not answer for each other")
# This is what the per-room state exists for. Two rooms can be live at once, and
# with one set of globals the second to connect cleared the first's counters, the
# leaderboard mixed both rooms' viewers, and the same handle in either room read
# as a repeat of itself.
a, b = "room-alpha", "room-beta"
eventlog.set_connected(a, True, "@alpha")
eventlog.record(a, "comment", user="Ana", text="from A", user_id="ana")
eventlog.record(a, "comment", user="Ana", text="from A again", user_id="ana")
eventlog.record(a, "viewers", meta={"count": 100})

# B connects. This used to clear everything, including A's.
eventlog.set_connected(b, True, "@beta")
check("B connecting left A's comments alone", eventlog.snapshot(a)["totals"].get("comment") == 2,
      str(eventlog.snapshot(a)["totals"]))
check("B connecting left A's repeats alone", eventlog.snapshot(a)["repeats"].get("comment") == 1,
      str(eventlog.snapshot(a)["repeats"]))
check("B connecting left A's viewer count alone", eventlog.snapshot(a)["viewers"] == 100,
      str(eventlog.snapshot(a)["viewers"]))
check("B has its own empty counters", eventlog.snapshot(b)["totals"] == {}, str(eventlog.snapshot(b)["totals"]))

# B speaks, including from the same handle A used.
eventlog.record(b, "comment", user="Ana", text="from B", user_id="ana")
eventlog.record(b, "comment", user="Budi", text="from B", user_id="budi")
check("A did not count B's messages", eventlog.snapshot(a)["totals"]["comment"] == 2,
      str(eventlog.snapshot(a)["totals"]))
check("B counted its own two", eventlog.snapshot(b)["totals"]["comment"] == 2,
      str(eventlog.snapshot(b)["totals"]))
check("the shared handle is not a repeat across rooms",
      eventlog.snapshot(b)["repeats"].get("comment", 0) == 0, str(eventlog.snapshot(b)["repeats"]))

print("each leaderboard holds only its own room")
board_a = eventlog.top_chatters(a)
board_b = eventlog.top_chatters(b)
check("A's board is just A", [c["nickname"] for c in board_a] == ["Ana"], str(board_a))
check("B's board is just B", [c["nickname"] for c in board_b] == ["Ana", "Budi"], str(board_b))
check("A's viewer count is A's", board_a[0]["messages"] == 2, str(board_a))
check("B's viewer count is B's", [c["messages"] for c in board_b] == [1, 1], str(board_b))

print("one room dropping does not disturb the other")
eventlog.set_connected(b, False, "B dropped")
check("B reads disconnected", eventlog.is_connected(b) is False)
check("A still reads connected", eventlog.is_connected(a) is True)
check("A kept its comments", eventlog.snapshot(a)["totals"]["comment"] == 2,
      str(eventlog.snapshot(a)["totals"]))
check("A kept its leaderboard", [c["nickname"] for c in eventlog.top_chatters(a)] == ["Ana"],
      str(eventlog.top_chatters(a)))
check("A kept its viewer count", eventlog.snapshot(a)["viewers"] == 100)
check("B still reports what it sent before it dropped",
      eventlog.snapshot(b)["totals"].get("comment") == 2, str(eventlog.snapshot(b)["totals"]))

print("a deleted room stops holding a leaderboard")
# Left behind, a room that no longer exists would still answer a request with the
# viewers it used to have.
eventlog.forget(a)
check("it answers empty", eventlog.top_chatters(a) == [])
check("and no longer holds state", "room-alpha" not in eventlog._rooms)
check("B is untouched by A being forgotten", eventlog.snapshot(b)["totals"].get("comment") == 2,
      str(eventlog.snapshot(b)["totals"]))

print()
if failed:
    print("FAILED")
    sys.exit(1)
print(f"all passed ({passed} assertions)")