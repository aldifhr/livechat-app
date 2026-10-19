"""Whether a room's audience figure may be sent on.

DATA-01 asked for validation that would notice an implausible viewer count, and for
the difference between the room's size, the number of people who have joined, and
the number of residents drawn to be written down rather than assumed.

`viewers_count.judge` is where that decision lives, extracted from the socket
handler because a test cannot reach a nested function — the same trap that let
the poll gate and the `viewers` branch go unnoticed.

Run with the backend's interpreter:

    apps/api/.venv/bin/python apps/api/tests/test_viewers_guard.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sources.viewers_count import JUMP_REPORT_RATIO, MAX_PLAUSIBLE_VIEWERS, judge  # noqa: E402

state = {"failed": False}


def check(label, cond, detail=""):
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}   {detail}")
        state["failed"] = True


# --- a live audience figure goes through -------------------------------------
v = judge(0, 0, 0)
check("zero is a real answer for an empty room", v.count == 0, f"got {v.count}")
check("and it is not treated as missing", v.warning is None, str(v.warning))

v = judge(11_000, 0, 11_000)
check("a normal room passes", v.count == 11_000, f"got {v.count}")
check("quietly", v.warning is None, str(v.warning))
check("and becomes the baseline for next time", v.last == 11_000, f"got {v.last}")

# --- numbers nobody means are refused ----------------------------------------
v = judge(-1, 0, 500)
check("a negative count is not sent", v.count is None, f"got {v.count}")
check("and is said out loud", v.warning is not None and "out of range" in v.warning, str(v.warning))
check("the cumulative figure rides along for comparison", "500" in (v.warning or ""), str(v.warning))

v = judge(MAX_PLAUSIBLE_VIEWERS + 1, 0, 999)
check("an absurd count is not sent", v.count is None, f"got {v.count}")

# The shape of the failure this guard exists for: the right number arriving in the
# wrong field. It is in range and sane-looking, so the guard lets it through —
# only measurement caught that one, and saying so is the point.
v = judge(627_555, 0, 627_555)
check("a cumulative figure is in range, so the guard cannot catch it",
      v.count == 627_555, f"got {v.count}")

# --- a jump is reported without being refused --------------------------------
check("a steady count is quiet", judge(12_000, 12_000, 0).warning is None)

v = judge(900_000, 12_000, 900_000)
check("a 75x jump is still delivered", v.count == 900_000, f"got {v.count}")
check("but reported", v.warning is not None and "jumped" in v.warning, str(v.warning))
check("and it names both ends and the cumulative figure",
      all(x in (v.warning or "") for x in ("12000", "900000", "900000")), str(v.warning))

v = judge(200, 12_000, 0)
check("a large drop is reported too", v.warning is not None and "jumped" in v.warning, str(v.warning))

just_under = int(12_000 * JUMP_REPORT_RATIO) - 1
check("a move under the threshold is quiet", judge(just_under, 12_000, 0).warning is None,
      f"{just_under} should not be reported")
check("a move over it is not", judge(int(12_000 * JUMP_REPORT_RATIO) + 1, 12_000, 0).warning is not None,
      f"{int(12_000 * JUMP_REPORT_RATIO) + 1} should be reported")

# --- the first count has nothing to be compared against ----------------------
v = judge(999_999, 0, 0)
check("no jump is reported on the first reading", v.warning is None, str(v.warning))
check("and it is accepted", v.count == 999_999, f"got {v.count}")

# --- a refused count does not become the baseline ----------------------------
last = judge(11_000, 0, 0).last
last = judge(-3, last, 0).last
check("a nonsense reading leaves the last good figure alone", last == 11_000, f"got {last}")
check("so the next real reading is judged against the last real one",
      judge(11_500, last, 0).warning is None)

print()
if state["failed"]:
    print("FAILED")
    sys.exit(1)
print("all passed")