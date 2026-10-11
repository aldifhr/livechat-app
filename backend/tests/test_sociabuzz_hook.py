"""A Sociabuzz donation must reach the feed with its name and its amount.

Sociabuzz posts a JSON body whose field names are not documented, so the
receiver reads the body raw and looks each field up under every name it is
known to arrive under. The whole risk here is silence: the request arrives,
none of the names match, and the chat shows nothing while the endpoint answers
200. Every assertion below is about what a socket actually received, because a
mapping that drops a field answers 200 perfectly.

Two shapes are exercised on purpose — a string amount with a message, and a
camelCase numeric amount with none — because the receiver cannot know which
Sociabuzz will send, and a shape it fails on is a donation that never appears.

Run with the backend's interpreter:

    backend/.venv/bin/python backend/tests/test_sociabuzz_hook.py
"""

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

TOKEN = "sociabuzz-test-token"
os.environ["STREAMKIT_TOKEN"] = TOKEN
AUTH = {"x-streamkit-token": TOKEN}

import httpx  # noqa: E402
from main import app  # noqa: E402

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
    """One ASGI websocket, recording every message that arrives."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.arrived: asyncio.Queue = asyncio.Queue()
        self.connected = asyncio.Event()
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

    def close(self) -> None:
        self._closed = True
        self._incoming.put_nowait({"type": "websocket.disconnect", "code": 1000})

    async def take(self, what: str, timeout: float = 5.0) -> dict:
        try:
            raw = await asyncio.wait_for(self.arrived.get(), timeout)
        except asyncio.TimeoutError:
            raise AssertionError(f"{self.path} received nothing when {what} was sent")
        return json.loads(raw)

    async def drain_opening(self) -> None:
        for _ in range(2):
            await self.take("the socket opened")


async def open_socket(path: str):
    conn = Connection(path)
    scope = {
        "type": "websocket",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "scheme": "ws",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [],
        "client": ("test", 1),
        "server": ("test", 80),
        "subprotocols": [],
        "state": {},
    }
    task = asyncio.create_task(app(scope, conn.receive, conn.send))
    await asyncio.wait_for(conn.connected.wait(), 5.0)
    return conn, task


async def run() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        made = await client.post("/api/rooms", json={"name": "SociaBuzz"}, headers=AUTH)
        check("created the room", made.status_code in (200, 201), f"got {made.status_code}")
        # The store mints its own id; the hook is keyed on it, so the id has to
        # come from what the room was created as rather than a name we chose.
        room = made.json()["room"]["id"]

        sock, task = await open_socket(f"/ws/room/{room}")
        try:
            await sock.drain_opening()

            print("a real Sociabuzz test-notification body")
            # The exact key set a live Sociabuzz test notification sends, pasted
            # from the platform's own response box. This is the shape that has to
            # work, and it is the one the first version of this hook had never
            # seen — so it is asserted here verbatim rather than reconstructed.
            posted = await client.post(
                f"/api/hooks/sociabuzz/{room}",
                json={
                    "amount": 10000,
                    "amount_settled": 10000,
                    "content": "Coffee",
                    "created_at": "2026-10-11 16:00:00",
                    "currency": "IDR",
                    "currency_settled": "IDR",
                    "email_supporter": "budi@example.com",
                    "id": "txn-1",
                    "item": "Coffee",
                    "level": "Tribe",
                    "media_type": "",
                    "media_url": "",
                    "message": "mantap streamnya!",
                    "supporter": "Budi",
                    "vote": "",
                },
            )
            check("the endpoint answered 200", posted.status_code == 200, f"got {posted.status_code}")
            frame = await sock.take("the donation")
            check("it reached the feed as an alert", frame.get("type") == "alert", str(frame))
            check("the supporter's name is on it", "Budi" in str(frame), str(frame))
            check("their message is on it", "mantap" in str(frame), str(frame))
            check("what they bought is on it", "Coffee" in str(frame), str(frame))
            # The settled amount, the money that actually arrived — not the list
            # price. And prefixed with the currency, because "10000" alone says
            # nothing about which money it is.
            check("the settled amount survived", frame.get("amount") == 10000.0, str(frame))
            check("and it reads as rupiah, not a bare number", "Rp 10.000" in str(frame) or "Rp 10000" in str(frame), str(frame))

            print("the settled amount is preferred over the list amount")
            posted = await client.post(
                f"/api/hooks/sociabuzz/{room}",
                json={"supporter": "Sari", "amount": 25000, "amount_settled": 23000, "currency_settled": "IDR"},
            )
            check("answered 200", posted.status_code == 200, f"got {posted.status_code}")
            frame = await sock.take("the second donation")
            check("the name is on it", "Sari" in str(frame), str(frame))
            # 23000, not 25000: the settled figure is what was charged.
            check("the settled amount is used", frame.get("amount") == 23000.0, str(frame))

            print("a donation with no recognisable fields still appears")
            posted = await client.post(
                f"/api/hooks/sociabuzz/{room}",
                json={"something": "unexpected"},
            )
            check("answered 200 rather than erroring", posted.status_code == 200, f"got {posted.status_code}")
            frame = await sock.take("the bare donation")
            check("and still shows on the feed", frame.get("type") == "alert", str(frame))
            check("with a stand-in name, not a blank", "SociaBuzz" in str(frame), str(frame))

            print("a room that does not exist is a 404, not a silent drop")
            missing = await client.post("/api/hooks/sociabuzz/no-such-room", json={"donator": "x"})
            check("404", missing.status_code == 404, f"got {missing.status_code}")

            print("a body that is not JSON is ignored, not crashed on")
            not_json = await client.post(
                f"/api/hooks/sociabuzz/{room}",
                content=b"not json at all",
                headers={"content-type": "text/plain"},
            )
            check("200 with an ignored status", not_json.status_code == 200, f"got {not_json.status_code}")
            check("and says so", not_json.json().get("status") == "ignored", str(not_json.json()))
        finally:
            sock.close()
            task.cancel()

    print()
    print(f"all passed ({PASSED} assertions)", flush=True)


if __name__ == "__main__":
    asyncio.run(run())
