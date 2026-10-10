"""The overlay must reach a stream without a login, and nothing else may.

`POST /api/connect` takes the room to connect from the request body, so it aims
the one global room wherever the caller says. That cannot be public. OBS loads
`/overlay/<id>` on the streamer's machine and cannot log in, so the overlay has
to have some way to reach the room — which is what `/api/overlay-connect/<id>`
is, and it takes no body: the username comes from the overlay's saved config.

These assert that distinction holds, because the failure mode of getting it
wrong is silent. The overlay simply never connects and the streamer watches a
sample scene; nothing in that looks like a security failure, which is how the
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
from store import create_overlay, update_overlay, delete_overlay  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

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
    # A temp store so the assertions never read or damage the real overlays.
    # `store` resolves its path at import and caches the file contents in
    # `_cache`, so both have to be redirected: setting the path alone would leave
    # the already-loaded overlays in memory and the test would edit production
    # data while asserting against the cache.
    tmp = tempfile.mkdtemp()
    real_file, real_cache = store.OVERLAYS_FILE, store._cache
    store.OVERLAYS_FILE = store.Path(tmp) / "overlays.json"
    store._cache = None
    print(f"  store redirected to {store.OVERLAYS_FILE}")

    app = main.app
    client = TestClient(app)
    client.headers.update({"X-StreamKit-Token": os.environ.get("STREAMKIT_TOKEN", "")})

    print("the overlay reaches the room it is already configured for")
    ov = create_overlay("uji overlay", {"theme": "outline"})
    update_overlay(ov["id"], username="room.sConfigured")

    # The TikTok source would try to open a real connection, so only the routing
    # and the refusal path are exercised here; the live connect itself is verified
    # against the running deployment instead of in this process.
    started = {}
    real_start = main.TikTokSource

    class FakeSource:
        def __init__(self, username, overlay_id):
            started["username"] = username
            started["overlay_id"] = overlay_id
            self.username = username
            self.overlay_id = overlay_id

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
        r = client.post(f"/api/overlay-connect/{ov['id']}")
        check("no body needed, so there is nothing to forge", r.status_code == 200, f"got {r.status_code} {r.text[:80]}")
        check("it connects the username from the config, not the caller", started.get("username") == "room.sConfigured", str(started.get("username")))
        check("it starts the source", started.get("started") is True)

        print("a caller cannot choose the room")
        # No body at all is accepted, so there is no field to smuggle a username
        # through — including one that looks like a query parameter or a header.
        for probe in (
            {},
            {"username": "someone.else"},
            {"overlay_id": "another-overlay", "username": "someone.else"},
        ):
            started.clear()
            rr = client.post(f"/api/overlay-connect/{ov['id']}", json=probe)
            check(
                f"a body of {sorted(probe) or ['none']} cannot change the room",
                started.get("username") == "room.sConfigured",
                str(started.get("username")),
            )
        r = client.post(
            f"/api/overlay-connect/{ov['id']}",
            headers={"X-Requested-Username": "someone.else"},
        )
        check("a header cannot change the room either", started.get("username") == "room.sConfigured", str(started.get("username")))

        print("an overlay with no room is a config error, not an auth error")
        bare = create_overlay("tanpa room", {"theme": "outline"})
        r = client.post(f"/api/overlay-connect/{bare['id']}")
        check("it is 409, not 401", r.status_code == 409, f"got {r.status_code}")
        check("and it says what is actually wrong", "username" in r.json().get("detail", "").lower(), r.text[:100])

        print("an unknown overlay cannot be used to reach anything")
        r = client.post("/api/overlay-connect/does-not-exist")
        check("unknown overlay is 409", r.status_code == 409, f"got {r.status_code}")
        check("and nothing was started", started.get("username") != "someone.else", str(started))

        print("the gate still refuses the ungated verb")
        # /api/connect is unchanged and still takes the room from the body. The
        # proxy keeps it behind the session; this pins the backend half so the two
        # cannot be quietly merged later.
        r = client.post("/api/connect", json={"username": "someone.else", "overlay_id": ov["id"]})
        check("it still connects what it is told to", started.get("username") == "someone.else", str(started.get("username")))

        print("cleanup")
        delete_overlay(ov["id"])
        delete_overlay(bare["id"])
        main.sources.clear()
    finally:
        main.TikTokSource = real_start
        main.sources.clear()
        # Restored even on failure: leaving the cache pointing at a temp file
        # would have this process write a stranger's overlays into the void.
        store.OVERLAYS_FILE, store._cache = real_file, real_cache


main_run()
print()
if failed:
    print(f"FAILED — {failed} of {failed + passed}")
    sys.exit(1)
print(f"all passed ({passed} assertions)")