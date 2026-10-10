"""Check that everything the source emits is something the city can actually use.

A frame arriving is not the same as a frame being usable. Every check in this repo
so far has asked whether the path between TikTok and the screen is open; none of
them asked whether what comes out the other end is well formed. Six bugs in this
repo were all "the data never arrived" — a frame with a missing field fails the
same way as no frame at all, and the difference only shows if the payload itself
is inspected.

So this reads real traffic and judges every frame against what the frontend
normalizer reads, field by field, using the same expectations the TypeScript
side applies. It is a probe, not a test: it needs a live room.

    apps/api/.venv/bin/python apps/api/tests/validate_live_city.py [overlay-id] [seconds]
"""

import asyncio
import json
import re
import sys
from collections import Counter

import websockets

WS = "wss://kit-backend.aldifhr.my.id/ws/overlay/{overlay_id}"

#: What `lib/feed-wire.ts` reads, per kind. A frame missing one of these produces
#: an entry with a hole in it, which then reads as an empty string or NaN in the
#: city rather than as a dropped frame.
REQUIRED = {
    "viewers": ("count",),
    "join": ("user", "userId"),
    "comment": ("user", "userId", "text"),
    "like": ("user", "userId", "count", "totalLikes"),
    "gift": ("user", "userId", "giftName", "count", "value"),
    "follow": ("user", "userId"),
    "share": ("user", "userId", "count"),
}

NUMERIC = {"count", "totalLikes", "value", "diamonds", "popularity"}

#: TikTok substitutes these for a profile it cannot resolve. `tiktok.py` drops
#: them, so seeing one here means the filter did not run.
PLACEHOLDER_NAMES = {"Not found", "?", ""}

BAD_NAME = re.compile(r"[�]")


class Report:
    def __init__(self) -> None:
        self.kinds: Counter[str] = Counter()
        self.problems: list[str] = []
        self.viewers: list[int] = []
        self.names: set[str] = set()
        self.ids: set[str] = set()

    def frame(self, msg: dict) -> None:
        kind = msg.get("type")
        self.kinds[kind] += 1

        if kind in ("config", "status", "error"):
            return

        missing = [f for f in REQUIRED.get(kind, ()) if f not in msg]
        if missing:
            self.problems.append(f"{kind}: missing {', '.join(missing)}   {json.dumps(msg, ensure_ascii=False)[:110]}")
            return

        for field in REQUIRED.get(kind, ()):
            if field in NUMERIC:
                value = msg[field]
                if not isinstance(value, (int, float)) or isinstance(value, bool):
                    self.problems.append(
                        f"{kind}.{field} is {type(value).__name__}, not a number: {value!r}")
                elif value < 0:
                    self.problems.append(f"{kind}.{field} is negative: {value!r}")
            elif isinstance(msg[field], str) and not msg[field].strip():
                self.problems.append(f"{kind}.{field} is empty")

        if kind == "viewers":
            self.viewers.append(int(msg["count"]))
            return

        name = msg.get("user")
        if isinstance(name, str):
            if name in PLACEHOLDER_NAMES:
                self.problems.append(f"{kind}: placeholder name survived: {name!r}")
            if BAD_NAME.search(name):
                self.problems.append(f"{kind}: replacement character in name: {name!r}")
            self.names.add(name)

        uid = msg.get("userId")
        if kind == "gift" or kind == "join":
            # The city's whole identity model is one person per TikTok user id,
            # so a join or a gift without one creates a resident nobody can key.
            if not isinstance(uid, str) or not uid:
                self.problems.append(f"{kind}: no userId, so the person cannot be tracked: {json.dumps(msg, ensure_ascii=False)[:110]}")
            else:
                self.ids.add(uid)


async def main() -> None:
    overlay_id = sys.argv[1] if len(sys.argv) > 1 else "b8069c75-ede2-49b5-b565-f861c4bdd72e"
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 60.0

    report = Report()
    room = None
    print(f"watching {overlay_id} for {seconds:.0f}s")
    try:
        async with websockets.connect(WS.format(overlay_id=overlay_id)) as sock:
            deadline = asyncio.get_event_loop().time() + seconds
            while asyncio.get_event_loop().time() < deadline:
                left = deadline - asyncio.get_event_loop().time()
                if left <= 0:
                    break
                try:
                    raw = await asyncio.wait_for(sock.recv(), timeout=left)
                except asyncio.TimeoutError:
                    break
                msg = json.loads(raw)
                if msg.get("type") == "status":
                    room = msg.get("message")
                report.frame(msg)
    except Exception as exc:  # noqa: BLE001 — a probe reports, it does not judge
        print(f"  socket ended: {type(exc).__name__}: {exc}")

    total = sum(report.kinds.values())
    print(f"\nroom: {room}")
    print(f"{total} frames:")
    for kind, n in report.kinds.most_common():
        print(f"  {kind:10s} {n}")

    if report.kinds.get("config"):
        print("\n(the config frame is what the scene renders; not judged here)")

    print(f"\ndistinct people: {len(report.names)} names, {len(report.ids)} ids")

    if report.viewers:
        first, last = report.viewers[0], report.viewers[-1]
        lo, hi = min(report.viewers), max(report.viewers)
        print(f"audience: {first} -> {last}   range {lo}..{hi}")
        if len(report.viewers) > 1:
            moved_down = any(b < a for a, b in zip(report.viewers, report.viewers[1:]))
            print(f"  falls at least once: {moved_down}  (a cumulative total never falls)")
            print(f"  spread: {hi - lo} on a base of {max(report.viewers[1:])}")

    print()
    if report.problems:
        print(f"{len(report.problems)} problems:")
        seen = set()
        for p in report.problems:
            shape = p.split("   ")[0]
            if shape in seen:
                continue
            seen.add(shape)
            print(f"  {p}")
    else:
        print("no problems: every frame carried what the city reads")

    print()
    print("note: a quiet room proves little. A frame that never arrives cannot be")
    print("wrong, and this room produced", report.kinds.get("comment", 0), "comments and",
          report.kinds.get("gift", 0), "gifts.")


if __name__ == "__main__":
    asyncio.run(main())