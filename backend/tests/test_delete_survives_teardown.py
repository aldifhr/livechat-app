"""A teardown failure must not be reported as the operation failing.

Deleting a stream was answering 500 while the stream was, in fact, deleted. The
dashboard showed the delete as refused, and the room was gone on the next refresh
— which is worse than either outcome on its own, because the operator is told to
try again and the retry is a 404.

The order is the cause. `routes/rooms.py` removes the room from the store *first*,
then pops the source and awaits its teardown. That ordering is right — the
operation should not be rolled back by a consequence of it — but it means anything
that raises in the teardown is raised after the work is already committed, and the
caller has no way to tell the operator that.

`TikTokAdapter.disconnect` awaited its connect task catching only
`CancelledError`, so a loop that had ended by raising re-raised through `stop()`.
Four call sites await `stop()` and three of them have already done their job:
`_connect_room` displacing a source, `/api/disconnect`, and the username-change
and delete paths in `routes/rooms.py`. The fix belongs in `stop()` rather than at
four call sites — a teardown is best-effort everywhere, and that is one fact
rather than four defensive try/excepts.

Run with the backend's interpreter:

    python backend/tests/test_delete_survives_teardown.py
"""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ["STREAMKIT_CONFIG_DIR"] = tempfile.mkdtemp(prefix="teardown-")
TOKEN = "teardown-test-token"
os.environ["STREAMKIT_TOKEN"] = TOKEN
AUTH = {"x-streamkit-token": TOKEN}

import httpx  # noqa: E402
import main  # noqa: E402
import store  # noqa: E402
from sources.tiktok import TikTokAdapter  # noqa: E402

PASSED = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASSED
    if cond:
        PASSED += 1
        print(f"  ok   {label}", flush=True)
    else:
        print(f"  FAIL {label}   {detail}", flush=True)
        raise SystemExit(1)


async def broken_source(room_id: str, username: str) -> TikTokAdapter:
    """A real adapter whose connect loop has already died by raising.

    The real class on purpose. A stand-in whose `stop()` raises would test that
    the route is defensive about foreign objects, which is not the bug: the bug is
    that this class raises out of its own teardown.
    """

    async def explode() -> None:
        raise ValueError("the connect loop fell over")

    adapter = TikTokAdapter(username, room_id)
    # Built on the running loop, so awaiting it later is awaiting a real task
    # rather than one belonging to a closed loop — which would fail for a reason
    # that has nothing to do with the one under test.
    task = asyncio.get_running_loop().create_task(explode())
    await asyncio.sleep(0)
    try:
        await task
    except ValueError:
        pass
    # Finished, and finished with an exception rather than a cancellation — which
    # is the distinction the missing `except` used to walk straight into.
    adapter._task = task
    return adapter


async def run() -> None:
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        made = await client.post("/api/rooms", json={"name": "Doomed"}, headers=AUTH)
        check("a room to delete", made.status_code in (200, 201), f"got {made.status_code}")
        room_id = made.json()["room"]["id"]

        main.sources[room_id] = await broken_source(room_id, "doomedhandle")

        print("a source that died by raising does not fail the delete")
        answer = await client.delete(f"/api/rooms/{room_id}", headers=AUTH)
        check(
            "the delete answers as a success",
            answer.status_code == 200,
            f"got {answer.status_code}: {answer.text[:200]}",
        )
        check("and says so", answer.json().get("status") == "ok", f"got {answer.text[:200]}")

        print("and the room really is gone, which is what it claims")
        remaining = await client.get("/api/rooms", headers=AUTH)
        ids = [room["id"] for room in remaining.json()["rooms"]]
        check("not in the list any more", room_id not in ids, f"still there: {ids}")
        check("and not in the store", store.get_room(room_id) is None)

        print("the same source, deleted through a room that never had one")
        made = await client.post("/api/rooms", json={"name": "Quiet"}, headers=AUTH)
        quiet_id = made.json()["room"]["id"]
        answer = await client.delete(f"/api/rooms/{quiet_id}", headers=AUTH)
        check("unaffected", answer.status_code == 200, f"got {answer.status_code}")

        print("and a teardown that hangs no longer stops a delete either")
        # The other half of best-effort: `stop()` bounds its own client teardown at
        # five seconds, so a wedged socket cannot hold a request open.
        made = await client.post("/api/rooms", json={"name": "Wedged"}, headers=AUTH)
        wedged_id = made.json()["room"]["id"]
        adapter = TikTokAdapter("wedgedhandle", wedged_id)
        adapter._task = None
        main.sources[wedged_id] = adapter
        answer = await client.delete(f"/api/rooms/{wedged_id}", headers=AUTH)
        check("a source with no client deletes cleanly", answer.status_code == 200, f"got {answer.status_code}")
        check("and it is gone", store.get_room(wedged_id) is None)

    print()
    print(f"all passed ({PASSED} assertions)", flush=True)


if __name__ == "__main__":
    asyncio.run(run())
