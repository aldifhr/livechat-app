"""Dump real frames off the live socket, and check avatar actually arrives.

Reads the raw JSON rather than the mapped event, because the question is
whether the backend puts `avatar` on the wire at all — a test double cannot
answer that, only TikTok can.

Run against a room that is genuinely live and speaking:

    api/.venv/bin/python desktop/scripts/dump_ws_frames.py mybasic.indonesia 45
"""

import asyncio
import json
import sys
from collections import Counter

import websockets

WS = "wss://kit-backend.aldifhr.my.id/ws/room/{room_id}"


async def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    username = sys.argv[1].lstrip("@")
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0

    # Ask the backend which room that handle landed in, the same way the app does.
    import httpx

    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(
            "https://kit-backend.aldifhr.my.id/api/room-connect-by-username",
            json={"username": username},
        )
        if resp.status_code != 200:
            print(f"connect failed: {resp.status_code} {resp.text[:200]}")
            return 1
        room_id = resp.json()["room_id"]
    print(f"room {room_id} for @{username}, listening {seconds:.0f}s")

    kinds: Counter[str] = Counter()
    avatars: Counter[bool] = Counter()
    samples: dict[str, dict] = {}
    async with websockets.connect(WS.format(room_id=room_id)) as sock:
        try:
            async with asyncio.timeout(seconds):
                async for raw in sock:
                    try:
                        frame = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    kind = frame.get("type", "?")
                    if kind in {"status", "config", "error"}:
                        continue
                    kinds[kind] += 1
                    has = bool(frame.get("avatar"))
                    avatars[has] += 1
                    samples.setdefault(kind, frame)
        except TimeoutError:
            pass

    print(f"\n{kinds.total()} per-viewer frames")
    for kind, n in kinds.most_common():
        print(f"  {kind:<9} {n}")
    print(f"\navatar present: {avatars[True]}   empty: {avatars[False]}")
    for kind, frame in samples.items():
        who = frame.get("user", "?")
        av = frame.get("avatar", "")
        print(f"  {kind:<9} user={who!r} avatar={(av[:70] + '…') if av else '(empty)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))