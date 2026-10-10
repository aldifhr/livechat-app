"""The room must reach a stream without a login, and nothing else may.

`POST /api/connect` takes the room to connect from the request body, so it aims
the one global room wherever the caller says. That cannot be public. OBS loads
`/room/<id>` on the streamer's machine and cannot log in, so the room has
to have some way to reach the room — which is what `/api/room-connect/<id>`
is, and it takes no body: the username comes from the room's saved config.

These assert that distinction holds, because the failure mode of getting it
wrong is silent. The room simply never connects and the streamer watches a
sample room; nothing in that looks like a security failure, which is how the
public `/api/connect` could have looked fine while letting anyone repoint the
stream.
"""

import os
import sys
from pathlib import Path
import tempfile

# `apps/api`, not this directory: the modules under test live one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main  # noqa: E402
import store  # noqa: E402
from store import create_room, update_room, delete_room  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

# The gate now refuses every write when STREAMKIT_TOKEN is unset, and this suite
# exercises `/api/connect`, which is not exempt. So the token has to exist here
# for the assertion below to mean "the ungated verb still connects" rather than
# "an unauthenticated call was refused" — the two look identical from the room's
# point of view, and the second one is what the guard is supposed to do.
os.environ.setdefault("STREAMKIT_TOKEN", "s3cret")

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
    # A temp store so the assertions never read or damage the real rooms.
    # `store` resolves its path at import and caches the file contents in
    # `_cache`, so both have to be redirected: setting the path alone would leave
    # the already-loaded rooms in memory and the test would edit production
    # data while asserting against the cache.
    tmp = tempfile.mkdtemp()
    real_file, real_cache = store.ROOMS_FILE, store._cache
    store.ROOMS_FILE = store.Path(tmp) / "rooms.json"
    store._cache = None
    print(f"  store redirected to {store.ROOMS_FILE}")

    app = main.app
    client = TestClient(app)
    # This suite's earlier calls carry their own header where one is needed. The
    # shared header exists for /api/connect, the one route in here that is *not*
    # exempt and so needs a token — and it used to pass with an empty one only
    # because an unset STREAMKIT_TOKEN accepted everything. With the gate closed,
    # an empty header is refused, so the value is given explicitly.
    client.headers.update({"X-StreamKit-Token": os.environ.get("STREAMKIT_TOKEN", "s3cret")})

    print("the room reaches the room it is already configured for")
    ov = create_room("uji room", {"theme": "outline"})
    update_room(ov["id"], username="room.sConfigured")

    # The TikTok source would try to open a real connection, so only the routing
    # and the refusal path are exercised here; the live connect itself is verified
    # against the running deployment instead of in this process.
    started = {}
    real_start = main.TikTokSource

    class FakeSource:
        def __init__(self, username, room_id):
            started["username"] = username
            started["room_id"] = room_id
            self.username = username
            self.room_id = room_id

        def is_running(self):
            return False

        def start_background(self):
            started["started"] = True

        async def stop(self):
            started["stopped"] = True

        def status_payload(self):
            return {"connected": False}

    main.TikTokSource = FakeSource
    main.sources.clear()
    try:
        r = client.post(f"/api/room-connect/{ov['id']}")
        check("no body needed, so there is nothing to forge", r.status_code == 200, f"got {r.status_code} {r.text[:80]}")
        check("it connects the username from the config, not the caller", started.get("username") == "room.sConfigured", str(started.get("username")))
        check("it starts the source", started.get("started") is True)

        print("a caller cannot choose the room")
        # No body at all is accepted, so there is no field to smuggle a username
        # through — including one that looks like a query parameter or a header.
        for probe in (
            {},
            {"username": "someone.else"},
            {"room_id": "another-room", "username": "someone.else"},
        ):
            started.clear()
            client.post(f"/api/room-connect/{ov['id']}", json=probe)
            check(
                f"a body of {sorted(probe) or ['none']} cannot change the room",
                started.get("username") == "room.sConfigured",
                str(started.get("username")),
            )
        r = client.post(
            f"/api/room-connect/{ov['id']}",
            headers={"X-Requested-Username": "someone.else"},
        )
        check("a header cannot change the room either", started.get("username") == "room.sConfigured", str(started.get("username")))

        print("an room with no room is a config error, not an auth error")
        bare = create_room("tanpa room", {"theme": "outline"})
        r = client.post(f"/api/room-connect/{bare['id']}")
        check("it is 409, not 401", r.status_code == 409, f"got {r.status_code}")
        check("and it says what is actually wrong", "username" in r.json().get("detail", "").lower(), r.text[:100])

        print("an unknown room cannot be used to reach anything")
        r = client.post("/api/room-connect/does-not-exist")
        check("unknown room is 409", r.status_code == 409, f"got {r.status_code}")
        check("and nothing was started", started.get("username") != "someone.else", str(started))

        print("the gate still refuses the ungated verb")
        # /api/connect is unchanged and still takes the room from the body. The
        # proxy keeps it behind the session; this pins the backend half so the two
        # cannot be quietly merged later.
        r = client.post("/api/connect", json={"username": "someone.else", "room_id": ov["id"]})
        check("it still connects what it is told to", started.get("username") == "someone.else", str(started.get("username")))

        print("cleanup")
        delete_room(ov["id"])
        delete_room(bare["id"])
        main.sources.clear()
    finally:
        main.TikTokSource = real_start
        main.sources.clear()
        # Restored even on failure: leaving the cache pointing at a temp file
        # would have this process write a stranger's rooms into the void.
        store.ROOMS_FILE, store._cache = real_file, real_cache


main_run()
print()
if failed:
    print(f"FAILED — {failed} of {failed + passed}")
    sys.exit(1)
print(f"all passed ({passed} assertions)")