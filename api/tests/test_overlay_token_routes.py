"""The overlay-token routes, and the socket that checks them.

`test_overlay_tokens.py` covers the policy module on its own — mint, verify,
revoke, Origin, scrub. This one covers the two places that policy is wired to
something: the HTTP routes that mint and withdraw a token, and the socket route
that refuses a handshake.

The transition is the thing being protected. Every overlay link in production
connects as `/ws/overlay/{room_id}` with **no token**, and it has to keep
working: a streamer cannot re-enter URLs in OBS mid-broadcast. So the default
asserted here is that a tokenless handshake is still accepted, and the stronger
model is only asserted under the environment variable that turns it on. A change
that made a token mandatory by default would take every running stream dark and
this suite is where that has to fail.

Run with the backend's interpreter:

    python api/tests/test_overlay_token_routes.py
"""

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ["STREAMKIT_CONFIG_DIR"] = tempfile.mkdtemp()

TOKEN = "overlay-route-test-token"
os.environ["STREAMKIT_TOKEN"] = TOKEN
AUTH = {"x-streamkit-token": TOKEN}

import httpx  # noqa: E402
from main import app  # noqa: E402
import wsguard  # noqa: E402

PASSED = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASSED
    if cond:
        PASSED += 1
        print(f"  ok   {label}", flush=True)
    else:
        print(f"  FAIL {label}   {detail}", flush=True)
        raise SystemExit(1)


class Connection:
    """One ASGI websocket connection, recording what arrives and what closed it."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.arrived: asyncio.Queue = asyncio.Queue()
        self.connected = asyncio.Event()
        self.close_code: int | None = None
        self._incoming: asyncio.Queue = asyncio.Queue()
        self._closed = False
        self._incoming.put_nowait({"type": "websocket.connect"})

    async def receive(self) -> dict:
        if self._closed:
            return {"type": "websocket.disconnect", "code": 1000}
        return await self._incoming.get()

    async def send(self, message: dict) -> None:
        kind = message["type"]
        if kind == "websocket.accept":
            self.connected.set()
        elif kind == "websocket.send":
            await self.arrived.put(message["text"])
        elif kind == "websocket.close":
            self.close_code = message.get("code", 1000)
            self._incoming.put_nowait({"type": "websocket.disconnect", "code": self.close_code})

    def close(self) -> None:
        self._closed = True
        self._incoming.put_nowait({"type": "websocket.disconnect", "code": 1000})


def scope_for(path: str) -> dict:
    # The query string is carried separately from the path in ASGI, and it is
    # where an overlay token travels. Hardcoding it empty — as the sibling
    # websocket suites do, because none of them puts anything in a URL — would
    # make every token assertion here pass for the wrong reason: the app would
    # never see the token at all.
    route, _, query = path.partition("?")
    return {
        "type": "websocket",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "scheme": "ws",
        "path": route,
        "raw_path": route.encode(),
        "query_string": query.encode(),
        "root_path": "",
        "headers": [],
        "client": ("test", 1),
        "server": ("test", 80),
        "subprotocols": [],
        "state": {},
    }


async def attach(path: str):
    conn = Connection(path)
    task = asyncio.create_task(app(scope_for(path), conn.receive, conn.send))
    return conn, task


async def refused(path: str) -> int:
    conn, task = await attach(path)
    try:
        await asyncio.wait_for(asyncio.shield(task), 3.0)
    except asyncio.TimeoutError:
        conn.close()
        task.cancel()
        raise AssertionError(f"{path} was neither accepted nor closed")
    except Exception as exc:  # noqa: BLE001 — the failure is the point
        conn.close()
        raise AssertionError(f"{path} closed but the app then raised {type(exc).__name__}: {exc}")
    return conn.close_code if conn.close_code is not None else 0


async def accepted(path: str):
    conn, task = await attach(path)
    try:
        await asyncio.wait_for(conn.connected.wait(), 3.0)
    except asyncio.TimeoutError:
        conn.close()
        task.cancel()
        raise AssertionError(f"{path} was refused; expected it to be accepted")
    return conn, task


async def run() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        made = await client.post("/api/rooms", json={"name": "Overlay tokens"}, headers=AUTH)
        check("a room to mint for", made.status_code in (200, 201), f"got {made.status_code}")
        room = made.json()["room"]["id"]

        print("\nminting is an operator action, so it carries the write token")
        anon = await client.post(f"/api/rooms/{room}/overlay-token")
        check("without the token it is 401", anon.status_code == 401, f"got {anon.status_code}")
        minted = await client.post(f"/api/rooms/{room}/overlay-token", headers=AUTH)
        check("with the token it mints", minted.status_code == 200, f"got {minted.status_code}")
        body = minted.json()
        check("and answers with the credential", bool(body.get("token")), str(body))
        check("naming the room it opens", body.get("roomId") == room, str(body))
        check("and when it expires", body.get("expiresAt", 0) > 0, str(body))

        missing = await client.post("/api/rooms/00000000-0000-0000-0000-000000000000/overlay-token",
                                    headers=AUTH)
        check("a room that does not exist is 404", missing.status_code == 404,
              f"got {missing.status_code}")

        print("\nthe socket accepts a tokenless handshake, because every overlay has none")
        # This is the default the whole migration rests on. If it ever changes,
        # every OBS source in production goes dark at once.
        conn, task = await accepted(f"/ws/overlay/{room}")
        try:
            check("a handshake with no token is accepted", conn.close_code is None)
        finally:
            conn.close()
            task.cancel()
            await asyncio.sleep(0)

        print("\nand it accepts one that presents a valid token")
        conn, task = await accepted(f"/ws/overlay/{room}?token={body['token']}")
        try:
            check("a valid token opens the socket", conn.close_code is None)
        finally:
            conn.close()
            task.cancel()
            await asyncio.sleep(0)

        print("\na token for another room does not open this one")
        other_made = await client.post("/api/rooms", json={"name": "Other room"}, headers=AUTH)
        other_room = other_made.json()["room"]["id"]
        other_mint = await client.post(f"/api/rooms/{other_room}/overlay-token", headers=AUTH)
        code = await refused(f"/ws/overlay/{room}?token={other_mint.json()['token']}")
        check("it is closed as a policy violation", code == 1008, f"got close code {code}")

        print("\na made-up token is refused the same way")
        code = await refused(f"/ws/overlay/{room}?token=not-a-real-token")
        check("it is closed as a policy violation", code == 1008, f"got close code {code}")

        print("\nrequiring a token is one environment variable, and it is off by default")
        os.environ["STREAMKIT_WS_REQUIRE_TOKEN"] = "true"
        try:
            code = await refused(f"/ws/overlay/{room}")
            check("with it on, a tokenless handshake is refused", code == 1008,
                  f"got close code {code}")
            conn, task = await accepted(f"/ws/overlay/{room}?token={body['token']}")
            try:
                check("and a valid one still opens it", conn.close_code is None)
            finally:
                conn.close()
                task.cancel()
                await asyncio.sleep(0)
        finally:
            os.environ.pop("STREAMKIT_WS_REQUIRE_TOKEN", None)

        print("\nrevoking withdraws the credential immediately")
        revoked = await client.delete(
            f"/api/rooms/{room}/overlay-token/{body['token']}", headers=AUTH
        )
        check("the route answers ok", revoked.status_code == 200, f"got {revoked.status_code}")
        code = await refused(f"/ws/overlay/{room}?token={body['token']}")
        check("and the URL stops opening the socket", code == 1008, f"got close code {code}")

        print("\nrevoking is scoped to the room in the path")
        # A token minted for one room cannot be revoked through another's, which
        # would make the route a way to learn whether an arbitrary token is live.
        mine = (await client.post(f"/api/rooms/{room}/overlay-token", headers=AUTH)).json()
        cross = await client.delete(
            f"/api/rooms/{other_room}/overlay-token/{mine['token']}", headers=AUTH
        )
        check("a foreign token is 404", cross.status_code == 404, f"got {cross.status_code}")
        check("and it still works", wsguard.verify(mine["token"], room))

        print("\nan unknown or spent token is 404, not a leak")
        gone = await client.delete(
            f"/api/rooms/{room}/overlay-token/never-minted", headers=AUTH
        )
        check("a token that never existed is 404", gone.status_code == 404,
              f"got {gone.status_code}")
        spent = (await client.post(f"/api/rooms/{room}/overlay-token", headers=AUTH)).json()
        await client.delete(f"/api/rooms/{room}/overlay-token/{spent['token']}", headers=AUTH)
        again = await client.delete(
            f"/api/rooms/{room}/overlay-token/{spent['token']}", headers=AUTH
        )
        check("revoking twice is 404 the second time", again.status_code == 404,
              f"got {again.status_code}")
        nowhere = await client.delete(
            "/api/rooms/00000000-0000-0000-0000-000000000000/overlay-token/whatever",
            headers=AUTH,
        )
        check("a room that does not exist is 404", nowhere.status_code == 404,
              f"got {nowhere.status_code}")

        print("\ndeleting a room takes its tokens with it")
        # A credential that outlives the thing it opens is a key to a room that
        # no longer exists — and `verify` would keep answering for it, because
        # the token carries the room id and nothing checks the room is still there.
        doomed_made = await client.post("/api/rooms", json={"name": "Doomed"}, headers=AUTH)
        doomed = doomed_made.json()["room"]["id"]
        doomed_token = (await client.post(f"/api/rooms/{doomed}/overlay-token", headers=AUTH)).json()
        check("the token works before the delete", wsguard.verify(doomed_token["token"], doomed))
        await client.delete(f"/api/rooms/{doomed}", headers=AUTH)
        check("and stops after it", not wsguard.verify(doomed_token["token"], doomed))

        print("\nthe refusal reasons are counted, not just logged")
        # One refusal is a line in the journal; a pattern of them is a number on
        # /metrics, and only the second is visible without reading every line
        # since boot.
        from metrics import metrics as _metrics
        before = _metrics.ws_refused.get("invalid_overlay_token", 0)
        await refused(f"/ws/overlay/{room}?token=still-not-real")
        check("an invalid token is counted under its own reason",
              _metrics.ws_refused.get("invalid_overlay_token", 0) == before + 1,
              str(_metrics.ws_refused))

    print()
    print(f"all passed ({PASSED} assertions)", flush=True)


if __name__ == "__main__":
    asyncio.run(run())
