"""The route OBS actually opens, which is the one that was broken.

`/api/overlay-connect/<id>` is a GET with no body. It reads the channel from the
overlay's own stored config, so it can only ever connect the room that overlay
already names, and it is the call the overlay page makes on load.

A blanket edit once added a `req.source` argument to every `_connect_room` call
in the file, which put a `NameError` on this one — it raised 500, the overlay
page never got a socket, and the canvas read "STREAMER IS OFFLINE" while the
backend was delivering events to nobody. Nothing tested this path, which is how a
one-line edit survives a green suite.

The assertions are about the call itself: which channel it picks, that it refuses
loudly when there is no channel to honour, and that it takes no argument from a
caller, because there is no request body to take one from.
"""

import asyncio
import inspect
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import store  # noqa: E402

store.OVERLAYS_FILE = Path(tempfile.mkdtemp()) / "overlays.json"
store._cache = None

import main  # noqa: E402
from fastapi import HTTPException  # noqa: E402

FAILS: list[str] = []
COUNT = 0


def check(name: str, ok: bool, extra: object = "") -> bool:
    global COUNT
    COUNT += 1
    if not ok:
        FAILS.append(name)
        print(f"  FAIL {name}" + (f" — {extra}" if extra != "" else ""))
    return ok


calls: list[tuple[str, str]] = []


async def fake_connect(overlay_id: str, username: str) -> dict:
    calls.append((overlay_id, username))
    return {"status": "connecting", "overlay_id": overlay_id, "username": username}


main._connect_room = fake_connect  # type: ignore[assignment]


print("\nthe route OBS opens")
check("it exists", hasattr(main, "overlay_connect"))
# The regression, stated as a guard rather than as a story: this route has no
# request object, so nothing inside it may refer to one.
check("it takes only the overlay id", list(inspect.signature(main.overlay_connect).parameters) == ["overlay_id"])


def with_overlay(record: dict) -> str:
    calls.clear()
    store._cache = None
    oid = record.get("id", "ov-1")
    store._cache = {oid: record}
    return oid


print("\nan overlay with a channel")
oid = with_overlay({"id": "ov-1", "username": "miltonaylerr", "config": {}})
out = asyncio.run(main.overlay_connect(oid))
check("it connects", out.get("status") == "connecting", out)
check("the overlay is the one asked for", bool(calls) and calls[0][0] == "ov-1", calls)
check("the channel comes from config", bool(calls) and calls[0][1] == "miltonaylerr", calls)

print("\na leading @ does not change the channel")
oid = with_overlay({"id": "ov-2", "username": "@miltonaylerr", "config": {}})
asyncio.run(main.overlay_connect(oid))
check("the @ is stripped", bool(calls) and calls[0][1] == "miltonaylerr", calls)

print("\nan overlay with no channel")
oid = with_overlay({"id": "ov-3", "username": "", "config": {}})
got = None
try:
    asyncio.run(main.overlay_connect(oid))
except HTTPException as exc:
    got = exc
check("it is refused", got is not None)
code = getattr(got, "status_code", None)
check("with a 409", code == 409, code)
check("and says what to fix", "username" in str(getattr(got, "detail", "")).lower(), str(getattr(got, "detail", "")))
# An unconfigured channel is a setup mistake, not a credentials problem. Reporting
# it as 401 or 403 sends whoever is setting this up looking for a login that
# cannot help.
check("and not as an auth error", code not in (401, 403), code)
check("nothing was connected", calls == [], calls)

print("\nan overlay id that does not exist")
calls.clear()
store._cache = None
got = None
try:
    asyncio.run(main.overlay_connect("nope"))
except HTTPException as exc:
    got = exc
check("it is refused too", got is not None)
check("with a 409", getattr(got, "status_code", None) == 409, getattr(got, "status_code", None))
check("nothing was connected", calls == [], calls)

print()
if FAILS:
    print(f"{len(FAILS)} failed of {COUNT}")
    for f in FAILS:
        print("  - " + f)
    raise SystemExit(1)
print(f"all passed ({COUNT} assertions)")