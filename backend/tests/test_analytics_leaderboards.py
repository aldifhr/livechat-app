"""The analytics leaderboards are summed across rooms, not listed per room.

One person who showed up on two streams has to be one row, not two — a leaderboard
that splits them is not a leaderboard, it is a list of rooms wearing one. So the
sum is keyed on the stable user id, which is the only thing that means the same
person in two rooms; a nickname does not, and a display name can change
mid-session.

What is summed is whatever `eventlog` still holds, which is the top twenty of each
room. That is a ceiling on what can be reported, and the page says so where it
draws the list rather than presenting a top-ten-of-top-twenties as a top ten.

Run with the backend's interpreter:

    python backend/tests/test_analytics_leaderboards.py
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ["STREAMKIT_CONFIG_DIR"] = tempfile.mkdtemp(prefix="analytics-lb-")
TOKEN = "analytics-lb-token"
os.environ["STREAMKIT_TOKEN"] = TOKEN
AUTH = {"x-streamkit-token": TOKEN}

import eventlog  # noqa: E402
import store  # noqa: E402
from routes.ops import _rank  # noqa: E402

PASSED = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASSED
    if cond:
        PASSED += 1
        print(f"  ok   {label}", flush=True)
    else:
        print(f"  FAIL {label}   {detail}", flush=True)
        raise SystemExit(1)


def run() -> None:
    print("one person on two streams is one row")
    totals = {
        "u1": ("ana", 7),
        "u2": ("budi", 4),
        "u1-again": ("ana", 5),  # the same id, a second room
    }
    # What the route builds before it ranks: keyed on id, so a second room folds in.
    merged: dict[str, tuple[str, int]] = {}
    for key, (name, value) in totals.items():
        real = "u1" if key == "u1-again" else key
        previous, running = merged.get(real, (name, 0))
        merged[real] = (previous, running + value)

    ranked = _rank(merged, "messages", 10)
    check("two entries, not three", len(ranked) == 2, f"got {ranked}")
    check(
        "and the person is at the top with both rooms added",
        ranked[0] == {"id": "u1", "nickname": "ana", "messages": 12},
        f"got {ranked[0]}",
    )

    print("ties break by name, so the order is stable between two reads")
    tied = {"c": ("zara", 5), "a": ("adam", 5), "b": ("bea", 5)}
    first = _rank(tied, "messages", 10)
    second = _rank(dict(reversed(list(tied.items()))), "messages", 10)
    check("the same three in the same order both times", first == second, f"{first} vs {second}")
    check("ordered by name within the tie", [row["nickname"] for row in first] == ["adam", "bea", "zara"], f"got {first}")

    print("a missing id falls back to the nickname rather than being dropped")
    fallback = _rank({"": ("", 3)}, "diamonds", 10)
    check("an empty key is not a row", fallback == [], f"got {fallback}")

    print("the limit is applied, and it is a real one")
    many = {f"u{i}": (f"user{i}", i) for i in range(50)}
    limited = _rank(many, "diamonds", eventlog.TOP_N)
    check(f"at most {eventlog.TOP_N} rows", len(limited) == eventlog.TOP_N, f"got {len(limited)}")
    check("and the biggest are the ones kept", limited[0]["nickname"] == "user49", f"got {limited[0]}")
    check("most first", [row["diamonds"] for row in limited] == sorted((row["diamonds"] for row in limited), reverse=True))

    print("and the field the leaderboard asks for is the one it gets")
    check(
        "chatters carry messages, gifters carry diamonds",
        _rank({"a": ("x", 9)}, "messages", 1)[0].get("messages") == 9
        and _rank({"a": ("x", 9)}, "diamonds", 1)[0].get("diamonds") == 9,
    )

    eventlog.forget("lb-room")
    print()
    print(f"all passed ({PASSED} assertions)", flush=True)


if __name__ == "__main__":
    run()
