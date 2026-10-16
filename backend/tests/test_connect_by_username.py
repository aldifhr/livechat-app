"""Connect by handle alone: no room to make first, no token to hold.

The desktop app's whole flow is one field — type a handle, watch the chat. That
needed a route that creates the room it needs, because `POST /api/rooms` sits
behind the write token and the app deliberately does not carry one: a token
embedded in a shipped binary is extractable and grants full write access.

The cost of the exemption is that this is an open proxy for "connect to any
handle". These assert the three things that bound it — the handle has to be
shaped like a handle, one room per handle, and existing rooms are reused rather
than duplicated — plus that the route really is reachable without a token, since
the whole point is that the app has none.
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

_tmp = Path(tempfile.mkdtemp())
os.environ["STREAMKIT_CONFIG_DIR"] = str(_tmp)

import store  # noqa: E402

store.CONFIG_DIR = _tmp
store.ROOMS_FILE = _tmp / "rooms.json"

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# A token is configured, so anything that passes here passed the gate — not by
# being exempt, by accident.
os.environ["STREAMKIT_TOKEN"] = "s3cret"
os.environ.pop("STREAMKIT_AUTH_DISABLED", None)

passed = failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {label}")
    else:
        failed += 1
        print(f"  FAIL {label}   {detail}")


def main_run():
    started: dict[str, str] = {}

    class FakeSource:
        """Stands in for TikTokAdapter so nothing reaches TikTok from a test."""

        def __init__(self, username, room_id):
            self.username = username
            self.room_id = room_id
            self._running = True

        def is_running(self):
            return self._running

        def start_background(self):
            # The real one hands itself to TikTokLive's loop here. All a test
            # needs is for the call to exist and be synchronous.
            self.started = True

        async def stop(self):
            self._running = False

        def status_payload(self):
            return {"connected": False, "connecting": True}

    def fake_source(username, room_id):
        started[room_id] = username
        return FakeSource(username, room_id)

    main.TikTokAdapter = fake_source
    main.sources.clear()

    client = TestClient(main.app)

    print("the route needs no token at all")
    # No header, and a token is configured, so a 200 here can only mean the
    # exemption covers this path. If it ever stops doing so the app gets a 401
    # and no field to fix it with.
    r = client.post("/api/room-connect-by-username", json={"username": "bittersweetbynajla"})
    check("a handle connects with no token", r.status_code == 200, f"got {r.status_code} {r.text[:120]}")
    body = r.json() if r.status_code == 200 else {}
    check("and the reply names the room it used", bool(body.get("room_id")), str(body)[:160])
    check("and echoes the handle back", body.get("username") == "bittersweetbynajla", str(body)[:160])

    print("a handle that already has a room reuses it")
    before = len(store.all_rooms())
    r2 = client.post("/api/room-connect-by-username", json={"username": "bittersweetbynajla"})
    check("same room id for the same handle", r2.json().get("room_id") == body.get("room_id"),
          f"{r2.json().get('room_id')} vs {body.get('room_id')}")
    check("no second room was created", len(store.all_rooms()) == before, f"{before} -> {len(store.all_rooms())}")

    print("@ and case are not a different streamer")
    r3 = client.post("/api/room-connect-by-username", json={"username": "@BittersweetBynajla"})
    check("a leading @ finds the same room", r3.json().get("room_id") == body.get("room_id"),
          f"{r3.json().get('room_id')} vs {body.get('room_id')}")
    r4 = client.post("/api/room-connect-by-username", json={"username": "  bittersweetbynajla  "})
    check("surrounding space does not either", r4.json().get("room_id") == body.get("room_id"),
          f"{r4.json().get('room_id')} vs {body.get('room_id')}")

    print("a new handle gets a room of its own")
    r5 = client.post("/api/room-connect-by-username", json={"username": "someone_else"})
    check("it connects", r5.status_code == 200, f"got {r5.status_code}")
    check("with a different room id", r5.json().get("room_id") != body.get("room_id"))
    room = store.get_room(r5.json()["room_id"])
    check("the room records the handle", room.get("username") == "someone_else", str(room)[:160])
    check("and is named after it", room.get("name") == "someone_else", str(room)[:160])

    print("input that is not a handle is refused before TikTok is asked")
    connected_before = len(started)
    for bad, why in (
        ("", "empty"),
        ("a", "one character"),
        ("a" * 25, "25 characters"),
        ("has space", "a space"),
        ("has/slash", "a slash"),
        ("https://example.com", "a URL"),
        ("..", "dots only"),
        ("...", "three dots"),
        ("na;rm -rf", "a shell fragment"),
("emoji\U0001f600", "an emoji"),
    ):
        r = client.post("/api/room-connect-by-username", json={"username": bad})
        check(f"{why} is 400", r.status_code == 400, f"got {r.status_code}")

    # Longer than the field allows, so the body model rejects it before the route
    # runs. 422 rather than 400 for that reason — both are refusals, and what
    # matters is that it does not reach the connection attempt.
    r = client.post("/api/room-connect-by-username", json={"username": "a" * 2000})
    check("absurdly long is refused", r.status_code in (400, 422), f"got {r.status_code}")
    check("nothing was connected while they were refused",
          len(started) == connected_before,
          f"{connected_before} -> {len(started)}")

    print("two requests at once still make one room")
    # The store holds a plain lock across the lookup and the insert precisely so
    # this holds. Asserted here through the same call the route makes, run
    # concurrently, because a check that only ever runs sequentially cannot tell
    # a correct critical section from one that does not exist.
    import threading

    seen: list[str] = []
    errors: list[BaseException] = []

    def race():
        try:
            seen.append(store.find_or_create_room_for_username("raced")[0]["id"])
        except BaseException as exc:  # noqa: BLE001 — reported below
            errors.append(exc)

    threads = [threading.Thread(target=race) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    check("no thread raised", not errors, str(errors[:1]))
    check("all eight got the same room", len(set(seen)) == 1, f"{len(set(seen))} distinct ids")
    check("and only one room exists for it",
          sum(1 for rec in store.all_rooms().values() if rec.get("username") == "raced") == 1)

    print("the ceiling rejects a flood and rolls the room back")
    # Filled by asking for the handles, rather than by hand-building records in
    # the store. The old version manufactured "a room with a username and no
    # source", which is a state this route cannot leave behind — it connects what
    # it creates on the next statement — so the filler rooms it built were not the
    # shape the cap counts, and the test passed against a cap that was never
    # actually enforcing anything.
    main.sources.clear()
    from routes.live import AUTO_ROOM_LIMIT

    for i in range(AUTO_ROOM_LIMIT + 2):
        store.find_or_create_room_for_username(f"filler{i}")
    check("the store is past the ceiling", store.count_auto_rooms() > AUTO_ROOM_LIMIT,
          str(store.count_auto_rooms()))

    rooms_before = len(store.all_rooms())
    r = client.post("/api/room-connect-by-username", json={"username": "one_too_many"})
    check("past the limit it is 429, not a silent success", r.status_code == 429, f"got {r.status_code}")
    check("the room it made is rolled back", store.find_room_by_username("one_too_many") is None)
    check("and no room was left behind", len(store.all_rooms()) == rooms_before,
          f"{rooms_before} -> {len(store.all_rooms())}")

    print("a room a human wired up is not blocked by the ceiling")
    made = store.create_room("made in the dashboard", {})
    store.update_room(made["id"], username="already_wired")
    main.sources[made["id"]] = FakeSource("already_wired", made["id"])
    r = client.post("/api/room-connect-by-username", json={"username": "already_wired"})
    check("it connects even with the store full", r.status_code == 200, f"got {r.status_code} {r.text[:120]}")

    print("the old route still works, unchanged")
    r = client.post(f"/api/room-connect/{made['id']}")
    check("room-connect/{id} is intact", r.status_code == 200, f"got {r.status_code}")

    print("two connects at once do not orphan a source")
    # `_connect_room` has to await the old source's stop() before installing its
    # replacement, and an await in the middle of that is a hole two requests fall
    # through: both read "no source", both build one, and the second assignment
    # silently orphans the first — whose task and socket then stay live, emitting a
    # duplicate of every event into the same room. The route reaching this is
    # unauthenticated, so the race is remotely triggerable.
    #
    # Driven as coroutines rather than threads: the bug is about where the await
    # lands in the event loop, and threads cannot express that.
    import asyncio

    real_source = main.TikTokAdapter
    built: list[FakeSource] = []

    class CountingSource(FakeSource):
        async def stop(self):
            # A real await inside stop() — the gap the lock has to cover.
            await asyncio.sleep(0)
            await super().stop()

    def counting_factory():
        def make(username, room_id):
            source = CountingSource(username, room_id)
            built.append(source)
            return source
        return make

    main.TikTokAdapter = counting_factory()
    try:
        async def both():
            # Same room, different handles, so neither takes the idempotent path.
            await asyncio.gather(
                main._connect_room("raceroom", "one"),
                main._connect_room("raceroom", "two"),
            )

        asyncio.run(both())
        installed = main.sources.get("raceroom")
        check("exactly one source is installed", installed is not None)
        check("both connects got as far as building one", len(built) == 2, f"built {len(built)}")
        # The point of the lock: exactly one of them is still running. The second
        # replaced the first, and the first was stopped rather than dropped — an
        # orphaned source keeps emitting a duplicate of every event.
        still_running = [s for s in built if s.is_running()]
        check(
            "the displaced source was stopped, not orphaned",
            len(still_running) == 1,
            f"{len(still_running)} of {len(built)} still running",
        )
        check(
            "and the one that is running is the one installed",
            still_running and installed is still_running[0],
        )
    finally:
        main.TikTokAdapter = real_source
        main.sources.clear()

    main.TikTokAdapter = getattr(sys.modules["sources"], "TikTokAdapter")
    main.sources.clear()


if __name__ == "__main__":
    main_run()
    print()
    print(f"{passed}/{passed + failed} assertions passed")
    if failed:
        print(f"{failed} FAILED")
        sys.exit(1)
    print("all passed")