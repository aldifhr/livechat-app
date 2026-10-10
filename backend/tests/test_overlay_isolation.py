"""Two streams on one backend must not hear each other.

The hub records which overlay each socket is watching, but the recipient filter
only consulted that map when the caller had also named a client type. Every
producer in `events.py` passes an overlay id and none of them pass a client type,
so `_targets` fell through to "every connected socket": two overlays on two
different TikTok accounts received each other's comments, gifts, donations, each
other's config and each other's connection status.

The assertions are about what each socket actually received. A broadcast that
reaches the wrong two sockets succeeds perfectly, so "did broadcast raise" is
worth nothing here. What makes a leak visible is asking the other socket whether
anything arrived, and then reading its next message and finding the other
scene's payload in it.

This drives the ASGI app directly rather than going through `TestClient`: the
websocket transport there holds a portal, and issuing an HTTP request from inside
an open websocket context deadlocks. Driving the app in one event loop keeps the
sockets and the broadcasts in the same world, and lets each connection's received
messages be inspected exactly as they arrived.

Run with the backend's interpreter, the only one with the app's dependencies:

    apps/api/.venv/bin/python apps/api/tests/test_overlay_isolation.py
"""

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

TOKEN = "isolation-test-token"
os.environ["STREAMKIT_TOKEN"] = TOKEN
AUTH = {"x-streamkit-token": TOKEN}

import httpx  # noqa: E402
from main import app  # noqa: E402
from events import Event, emit, emit_config, emit_error, emit_status  # noqa: E402

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
    """One ASGI websocket connection, recording every message that arrives."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.arrived: asyncio.Queue = asyncio.Queue()
        self.connected = asyncio.Event()
        self._incoming: asyncio.Queue = asyncio.Queue()
        self._closed = False
        # ASGI has the server open the connection before the app is given
        # anything: without this the app sits waiting for a handshake that never
        # arrives, and the socket never accepts.
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
        """A fresh socket is answered with its own config and status."""
        for _ in range(2):
            await self.take("the socket opened")

    async def expect_nothing(self, within: float = 0.35) -> bool:
        """True when no message arrives in the window — the direct isolation check."""
        try:
            await asyncio.wait_for(self.arrived.get(), within)
        except asyncio.TimeoutError:
            return True
        return False


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
    a, b = "overlay-account-a", "overlay-account-b"

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        for name, label in ((a, "Scene A"), (b, "Scene B")):
            made = await client.post("/api/overlays", json={"name": label}, headers=AUTH)
            check(f"created {label}", made.status_code in (200, 201), f"got {made.status_code}")

        sock_a, task_a = await open_socket(f"/ws/overlay/{a}")
        sock_b, task_b = await open_socket(f"/ws/overlay/{b}")
        try:
            await sock_a.drain_opening()
            await sock_b.drain_opening()

            print("a comment for one scene reaches only that scene")
            await emit(a, Event(kind="comment", user="alice", user_id="alice", value="dari akun A"))
            await emit(b, Event(kind="comment", user="bob", user_id="bob", value="dari akun B"))
            got_a = await sock_a.take("A's comment")
            got_b = await sock_b.take("B's comment")
            check("A receives its own comment", "dari akun A" in str(got_a), f"got {got_a}")
            check("B receives its own comment", "dari akun B" in str(got_b), f"got {got_b}")
            check("A's copy names nobody from B", "bob" not in str(got_a), f"got {got_a}")
            check("B's copy names nobody from A", "alice" not in str(got_b), f"got {got_b}")
            check("B received nothing beyond its own", await sock_b.expect_nothing(), "something leaked to B")

            print("a gift for one scene reaches only that scene")
            await emit(a, Event(kind="gift", user="alice", user_id="alice", value="Lion",
                                meta={"diamonds": 500, "value": 500, "count": 1, "giftName": "Lion"}))
            got_a = await sock_a.take("A's gift")
            check("A sees the gift", "500" in str(got_a), f"got {got_a}")
            check("B received no gift", await sock_b.expect_nothing(), "the gift crossed to B")

            print("config for one scene does not reach the other")
            await emit_config(a, {"type": "city", "style": {"max-people": 45}})
            cfg_a = await sock_a.take("A's config")
            check("A gets its own config", "city" in str(cfg_a), f"got {cfg_a}")
            check("B received no config", await sock_b.expect_nothing(), "A's config crossed to B")
            await emit_config(b, {"type": "chat", "style": {"size": "small"}})
            cfg_b = await sock_b.take("B's config")
            check("B gets its own config", "chat" in str(cfg_b), f"got {cfg_b}")
            check("and only its own", "city" not in str(cfg_b), f"got {cfg_b}")

            print("status for one scene does not reach the other")
            await emit_status(a, connected=True, message="Live A")
            status_a = await sock_a.take("A's status")
            check("A sees the status", "Live A" in str(status_a), f"got {status_a}")
            check("B received no status", await sock_b.expect_nothing(), "A's status crossed to B")

            print("an error for one scene reaches only that scene")
            await emit_error(a, "A bermasalah")
            err_a = await sock_a.take("A's error")
            check("A sees the error", "bermasalah" in str(err_a), f"got {err_a}")
            check("B received no error", await sock_b.expect_nothing(), "A's error crossed to B")

            print("a third scene shares nothing with either")
            c = "overlay-account-c"
            made = await client.post("/api/overlays", json={"name": "Scene C"}, headers=AUTH)
            check("created Scene C", made.status_code in (200, 201), f"got {made.status_code}")
            sock_c, task_c = await open_socket(f"/ws/overlay/{c}")
            try:
                await sock_c.drain_opening()
                await emit(c, Event(kind="comment", user="carol", user_id="carol", value="halo C"))
                got_c = await sock_c.take("C's comment")
                check("C receives its own comment", "halo C" in str(got_c), f"got {got_c}")
                check("C received nothing from A", await sock_c.expect_nothing(), "A's traffic crossed to C")
                check("A received nothing from C", await sock_a.expect_nothing(), "C's traffic crossed to A")
            finally:
                sock_c.close()
                task_c.cancel()
        finally:
            sock_a.close()
            sock_b.close()
            task_a.cancel()
            task_b.cancel()

    print()
    print(f"all passed ({PASSED} assertions)", flush=True)


if __name__ == "__main__":
    asyncio.run(run())