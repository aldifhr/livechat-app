"""Whether a gift combo is counted once or many times.

TikTok sends one frame per shot of a combo, and `repeat_count` on each frame is
the *running total* of that combo — not the number of shots that frame added. The
handler used to add each frame's value to a running sum, which is a triangular
series: a ten-Rose combo (ten diamonds) came out as 1+2+…+10 = 55. The final
frame was worse still — the old code read the total from the cache and never
added the last shot at all.

`streak_step` holds the arithmetic, extracted from the socket handler because a
nested function cannot be reached from a test — the same trap that let the poll
gate and the `viewers` branch go unnoticed.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sources.tiktok import streak_step  # noqa: E402

FAILS: list[str] = []
COUNT = 0


def check(name: str, ok: bool, extra: object = "") -> bool:
    global COUNT
    COUNT += 1
    if not ok:
        FAILS.append(name)
        print(f"  FAIL {name}" + (f" — {extra}" if extra != "" else ""))
    return ok


print("\na combo is its total, not the sum of its frames")
# Rose is one diamond. Frame N of a ten-shot combo carries N; only the tenth
# ends the streak. The old code summed the ten frames into 55.
streaks: dict[str, dict[str, int]] = {}
seen = None
for shot in range(1, 11):
    seen = streak_step(streaks, "ana", 1, shot, 1, 1 if shot == 10 else 0)
check("a ten-Rose combo is ten diamonds, not fifty-five", seen == (10, 10), seen)
check("the streak state is cleared once it ends", "ana" not in streaks, streaks)

streaks = {}
mid = [streak_step(streaks, "ana", 1, n, 1, 0) for n in range(1, 10)]
check("no mid-combo frame reports a total", all(v is None for v in mid), mid)

print("\nthe last shot of a combo is not dropped")
streaks = {}
streak_step(streaks, "ana", 1, 3, 2, 0)  # three shots so far, two diamonds each
final = streak_step(streaks, "ana", 1, 4, 2, 1)  # the fourth, which ends it
check("the final shot is counted", final == (4, 8), final)

print("\na gift that never streaks is its own total")
check("a single gift is itself", streak_step({}, "budi", 5, 1, 100, 1) == (1, 100))

print("\ncombos do not bleed into one another")
streaks = {}
streak_step(streaks, "ana", 1, 5, 1, 0)  # first combo, five Roses in
streak_step(streaks, "ana", 1, 1, 1, 0)  # a fresh combo starts at one
check("a new combo starts over", streak_step(streaks, "ana", 1, 2, 1, 1) == (2, 2))

streaks = {}
streak_step(streaks, "ana", 1, 7, 1, 0)  # seven Roses in progress
check("a different gift is its own total", streak_step(streaks, "ana", 2, 3, 5, 1) == (3, 15))

streaks = {}
streak_step(streaks, "ana", 1, 6, 1, 0)
check("a count-less final frame falls back to the last total", streak_step(streaks, "ana", 1, 0, 1, 1) == (6, 6))
check("but not for a gift with no streak behind it", streak_step({}, "ana", 9, 0, 1, 1) == (0, 0))

print()
if FAILS:
    print(f"{len(FAILS)} failed of {COUNT}")
    for f in FAILS:
        print("  - " + f)
    raise SystemExit(1)
print(f"all passed ({COUNT} assertions)")
