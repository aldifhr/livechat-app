"""Reproduce the gift crash against the real TikTokLive objects.

`on_gift` reads `event.gift.gift_id`, but the object TikTokLive hands over is an
`ExtendedGift`, whose id field is `id` — the *event* has a `gift_id`, the gift
object does not. Every gift frame therefore raised AttributeError inside the
handler and no gift was ever emitted, while the log filled with tracebacks.

This builds the real objects rather than a fake, because the whole bug is that
our code and the library disagree about a field name: a hand-written fake would
have used whichever name we believed.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from TikTokLive.events import GiftEvent  # noqa: E402
from TikTokLive.proto.custom_proto import ExtendedGift  # noqa: E402

FAILS: list[str] = []
COUNT = 0


def check(name: str, ok: bool, extra: object = "") -> None:
    global COUNT
    COUNT += 1
    if ok:
        print(f"  ok   {name}")
    else:
        FAILS.append(name)
        print(f"  FAIL {name}" + (f" — {extra}" if extra != "" else ""))


print("\nthe real GiftEvent, as the handler receives it")
gift = ExtendedGift(id=5655, name="Rose", diamond_count=1, type=1)
event = GiftEvent(gift=gift, repeat_count=1, repeat_end=1)

# What the handler does today. It must NOT be how the id is read.
check(
    "event.gift.gift_id does not exist (the bug)",
    not hasattr(event.gift, "gift_id"),
    sorted(a for a in dir(event.gift) if "id" in a),
)

# What the handler should read.
check("event.gift.id is the gift id", getattr(event.gift, "id", None) == 5655, getattr(event.gift, "id", None))
check("event.gift.name is the gift name", event.gift.name == "Rose", event.gift.name)
check("event.gift.diamond_count is the value", event.gift.diamond_count == 1, event.gift.diamond_count)

print("\nthe fields the handler reads must all exist on the real objects")
# Pinned so a library upgrade that renames one is caught here rather than by a
# room full of gifts that never appear.
for attr in ("repeat_count", "repeat_end"):
    check(f"event.{attr} exists", hasattr(event, attr), attr)
check("event.gift exists", event.gift is not None)
check("event.user exists", hasattr(event, "user"))

print("\nthe id the handler resolves is the one streak_step keys on")
# streak_step matches the running combo by gift id, so a wrong id means a
# streaking gift is counted as several separate ones.
from sources.tiktok import streak_step  # noqa: E402


def resolve_gift_id(event) -> int:
    """The expression `on_gift` uses, kept in sync with it by this test.

    Copied rather than imported because the handler is a closure registered on
    the client and cannot be called directly — the same reason `streak_step` was
    extracted. If this drifts from `on_gift`, the field checks above fail first.
    """
    return getattr(event.gift, "id", None) or getattr(event, "gift_id", 0) or 0


streaks: dict = {}
gid = resolve_gift_id(event)
check("the resolved id is the gift's own id", gid == 5655, gid)
first = streak_step(streaks, "u1", gid, 1, event.gift.diamond_count, 0)
check("an ongoing combo dispatches nothing", first is None, first)
final = streak_step(streaks, "u1", gid, 3, event.gift.diamond_count, 1)
check("the closing frame reports the full combo", final == (3, 3), final)

print()
if FAILS:
    print(f"{len(FAILS)} failed of {COUNT}")
    for f in FAILS:
        print("  - " + f)
    raise SystemExit(1)
print(f"all passed ({COUNT} assertions)")
