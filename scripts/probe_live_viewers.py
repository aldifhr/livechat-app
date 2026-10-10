"""Does the room's size actually reach this overlay's socket?

The city sits at KAMPUNG 0 in a live room. Three breaks were already found and
fixed on the frontend — no `viewers` mapping in `FROM_WIRE`, the frame being
dropped by `if (!build) return;`, and the city not subscribing to the kind. The
bundle in production has all of that, so this probes the remaining link: whether
the frame is ever sent, and under what field name.

Reporting every frame's keys, not just the ones we hoped for. If `total_user`
is arriving under a different key than the one `FROM_WIRE.viewers` reads, that
looks exactly like silence from the frontend, and the difference matters.

    apps/api/.venv/bin/python apps/api/tests/probe_live_viewers.py <overlay-uuid> [seconds]
"""

import asyncio
import json
import sys
from collections import Counter

import websockets

WS = "wss://kit-backend.aldifhr.my.id/ws/overlay/{overlay_id}"


async def main() -> None:
    overlay_id = sys.argv[1] if len(sys.argv) > 1 else "b8069c75-ede2-49b5-b565-f861c4bdd72e"
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0

    # An absolute deadline, not a per-recv timeout. A busy room sends a frame
    # every few seconds, so a per-recv timeout is reset every time and the probe
    # only ever ends when the outer `timeout` kills it — which is to say it never
    # reaches its own summary.
    deadline = asyncio.get_event_loop().time() + seconds

    kinds: Counter[str] = Counter()
    viewers_payloads: list[dict] = []
    total = 0

    print(f"listening on {overlay_id} for {seconds:.0f}s")
    try:
        async with websockets.connect(WS.format(overlay_id=overlay_id)) as sock:
            while True:
                left = deadline - asyncio.get_event_loop().time()
                if left <= 0:
                    break
                try:
                    raw = await asyncio.wait_for(sock.recv(), timeout=left)
                except asyncio.TimeoutError:
                    break
                total += 1
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    kinds["<unparseable>"] += 1
                    continue
                kind = msg.get("type", "<no type>")
                kinds[kind] += 1
                if kind == "viewers" and len(viewers_payloads) < 6:
                    viewers_payloads.append(msg)
                if total <= 4 and kind != "viewers":
                    print(f"  {kind}: {json.dumps(msg, ensure_ascii=False)[:120]}")
    except Exception as exc:  # noqa: BLE001 — a probe reports, it does not judge
        print(f"  socket ended: {type(exc).__name__}: {exc}")

    print(f"\n{total} frames in {seconds:.0f}s")
    for kind, n in kinds.most_common():
        print(f"  {kind:16s} {n}")

    print()
    if not viewers_payloads:
        print("no `viewers` frame arrived at all.")
        print("The frontend is now correct for this frame, so the break is before it:")
        print("either the source stopped sending it, or the hub is not routing it to")
        print("this overlay. Check apps/api/sources/tiktok.py and the overlay_id on the")
        print("broadcast, not the city.")
    else:
        print("`viewers` frames that arrived, verbatim:")
        for msg in viewers_payloads:
            print(f"  {json.dumps(msg, ensure_ascii=False)}")
        keys = sorted({k for m in viewers_payloads for k in m})
        print(f"\nkeys present: {keys}")
        for field in ("count", "total_user", "viewers", "value"):
            if field in keys:
                sample = viewers_payloads[0].get(field)
                print(f"  frontend reads {field!r}; the wire sent {sample!r}")


if __name__ == "__main__":
    asyncio.run(main())