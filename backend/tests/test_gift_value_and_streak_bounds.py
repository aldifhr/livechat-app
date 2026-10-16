"""The two per-viewer maps must not grow without bound, and a gift's value must
be the same number whichever route posted it.

Both of these are memory and accounting, which is the kind of thing that is fine
on the day it is written and wrong a month later, so they are pinned here:

`_gift_streaks` holds one entry per gift combo that has started and not finished.
Nothing removes an entry but its own final frame, so a viewer who walks away
mid-combo — a disconnect, a reload, the stream ending — leaves one behind for the
life of the source. `eventlog` has the same shape and its own cap, added
separately; this suite is about the adapter's.

`/api/hooks/{id}` and `/api/rooms/{id}/trigger` are two spellings of one operation,
and they disagreed about a gift's diamonds: the trigger route set `meta["value"]`
and the hook route did not, so `eventlog` — which counts `value` — recorded every
hook gift as worth nothing. The hook has since been given a `value`, but it is a
float where everything else is a whole number, and `RoomLog.total_diamonds` is
declared `int`. One float is how a declared type quietly stops being true.

Run with the backend's interpreter:

    python backend/tests/test_gift_value_and_streak_bounds.py
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ["STREAMKIT_CONFIG_DIR"] = tempfile.mkdtemp(prefix="gift-bounds-")
TOKEN = "gift-bounds-token"
os.environ["STREAMKIT_TOKEN"] = TOKEN
AUTH = {"x-streamkit-token": TOKEN}

import eventlog  # noqa: E402
from sources.tiktok import MAX_OPEN_STREAKS, streak_step  # noqa: E402

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
    print("an unfinished gift combo is remembered, and the map is still bounded")
    streaks: dict[str, dict[str, int]] = {}
    for index in range(MAX_OPEN_STREAKS + 500):
        # A first frame — `repeat_end == 0` — which is what creates the entry and
        # is the frame a viewer who disconnects mid-combo never sends the end of.
        streak_step(streaks, f"user-{index}", gift_id=7, repeat_count=1, diamond_count=5, repeat_end=0)
    check(
        f"{MAX_OPEN_STREAKS + 500} open combos leave at most {MAX_OPEN_STREAKS}",
        len(streaks) <= MAX_OPEN_STREAKS,
        f"got {len(streaks)}",
    )

    print("what survives is the combo with something behind it")
    streaks = {}
    # A thousand one-gift combos, then one real ten-shot.
    for index in range(MAX_OPEN_STREAKS):
        streak_step(streaks, f"small-{index}", 7, 1, 5, 0)
    streak_step(streaks, "the-real-one", 7, 10, 5, 0)
    check("the busy combo was kept", "the-real-one" in streaks, f"got {list(streaks)[:3]}…")
    check(
        "and it kept its running total",
        streaks.get("the-real-one", {}).get("count") == 10,
        f"got {streaks.get('the-real-one')}",
    )

    print("a viewer whose combo is dropped still reports correctly afterwards")
    # `repeat_count` is cumulative, so the next frame carries the whole total and
    # the entry rebuilds itself. This is why evicting the smallest is safe.
    step = streak_step(streaks, "the-real-one", 7, 12, 5, 0)
    check("a running frame dispatches nothing", step is None, f"got {step}")
    final = streak_step(streaks, "the-real-one", 7, 12, 5, 1)
    check("the ending frame reports the cumulative count", final == (12, 60), f"got {final}")
    check("and the entry is gone once it ends", "the-real-one" not in streaks)

    print("a hook gift is worth what it says, and worth a whole number")
    import asyncio

    import store
    from models import HookRequest
    from routes.ops import webhook

    room_id = store.create_room("Gift room", {})["id"]

    # The route emits through `events.emit`, so the frame is read back off the wire
    # the same way an overlay or the desktop app reads it — asserting on the
    # handler's own arguments would only prove the handler agrees with itself. The
    # event is kept as well, because `diamonds` is a gift field and an alert
    # deliberately never carries it, so the meta can only be checked from here.
    import events

    seen: list[tuple[object, dict]] = []
    original_emit = events.emit

    async def capture(target, event):
        seen.append((event, events.to_wire(event)))
        # Recorded here rather than delegating, which would count the same event
        # twice and double the diamond total the assertions below check.
        eventlog.record(
            target,
            event.kind,
            user=event.user,
            text=event.value,
            meta=event.meta,
            user_id=event.user_id,
        )

    def fire(body: HookRequest) -> dict:
        seen.clear()
        events.emit = capture
        try:
            asyncio.run(webhook(room_id, body))
        finally:
            events.emit = original_emit
        return seen[-1][1]

    wire = fire(HookRequest(kind="gift", user="giver", user_id="g1", amount=9999))
    check("the hook emitted a gift", wire.get("type") == "gift", f"got {wire}")
    check("carrying the amount as its value", wire.get("value") == 9999, f"got {wire}")
    check(
        "and a whole number, because diamonds are",
        isinstance(wire.get("value"), int),
        f"got {wire.get('value')!r} of type {type(wire.get('value')).__name__}",
    )
    check("named for what was posted, not for its own price", wire.get("giftName") == "Gift", f"got {wire}")

    print("a fractional amount is announced exactly, and counted as whole diamonds")
    seen.clear()
    events.emit = capture
    try:
        asyncio.run(
            webhook(room_id, HookRequest(kind="alert", user="donor", user_id="d1", text="thanks", amount=12.5))
        )
    finally:
        events.emit = original_emit
    alert_event, alert_wire = seen[-1]
    check(
        "an alert keeps the amount as posted, to the cent",
        alert_wire.get("amount") == 12.5,
        f"got {alert_wire.get('amount')!r}",
    )
    check(
        "and never carries the gift fields an alert has no use for",
        "diamonds" not in alert_wire and "giftName" not in alert_wire,
        f"got {alert_wire}",
    )
    check(
        "the diamond fields it does build are still whole",
        isinstance(alert_event.meta.get("diamonds"), int) and isinstance(alert_event.meta.get("value"), int),
        f"got {alert_event.meta.get('diamonds')!r} / {alert_event.meta.get('value')!r}",
    )

    print("and it lands in the session totals as an int")
    snapshot = eventlog.snapshot(room_id)
    check(
        "total_diamonds is an int, as RoomLog declares",
        isinstance(snapshot["total_diamonds"], int),
        f"got {snapshot['total_diamonds']!r} of type {type(snapshot['total_diamonds']).__name__}",
    )
    check(
        "and the gifter is on the board",
        snapshot["topGifters"][0]["nickname"] == "giver",
        f"got {snapshot['topGifters']}",
    )

    eventlog.forget(room_id)
    print()
    print(f"all passed ({PASSED} assertions)", flush=True)


if __name__ == "__main__":
    run()
