"""Every client type the product actually uses must be able to attach.

The socket route validates `client_type` before accepting, and for a while the
list it validated against held only `room` and `customizer`. `overlay` — the type
the overlay pages in `web/public/overlay/` hardcode, and therefore the type every
OBS browser source and every inline dashboard preview connects as — was not in it,
so the route closed every real overlay with 1008 and the product was dark.

It shipped green because the coverage was the other way round: every websocket
suite here opened `/ws/room/`, which is what the desktop app uses, and not one
opened `/ws/overlay/`. A suite can only catch the client types it exercises, so
this one exercises all of them, and asserts the refusal of an unknown one.

The caps are asserted here too, because both of them were aimed at the wrong
thing. The per-room cap read `client_type == ROOM`, so it never applied to the
clients that have count. And neither cap bounded the *total*, because `room_id` is
a free-form path segment — `ws/room/a`, `ws/room/b`, `ws/room/c` takes the per-room
ceiling five sockets at a time without ever approaching it.

Run with the backend's interpreter:

    python backend/tests/test_ws_client_types.py
"""

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Before main imports: this suite opens sockets against the real app, and the
# store must not be the deployed one.
os.environ["STREAMKIT_CONFIG_DIR"] = tempfile.mkdtemp()

TOKEN = "ws-types-test-token"
os.environ["STREAMKIT_TOKEN"] = TOKEN
AUTH = {"x-streamkit-token": TOKEN}

import httpx  # noqa: E402
from main import app  # noqa: E402
import hub as hub_module  # noqa: E402
from events import Event, emit  # noqa: E402

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
        # ASGI has the server open the connection before the app is handed
        # anything; without this the app waits on a handshake that never arrives.
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
            # Recorded rather than swallowed. This is how a refused connection is
            # told apart from one that was never answered at all.
            self.close_code = message.get("code", 1000)
            self._incoming.put_nowait({"type": "websocket.disconnect", "code": self.close_code})

    def close(self) -> None:
        self._closed = True
        self._incoming.put_nowait({"type": "websocket.disconnect", "code": 1000})

    async def take(self, what: str, timeout: float = 5.0) -> dict:
        try:
            raw = await asyncio.wait_for(self.arrived.get(), timeout)
        except asyncio.TimeoutError:
            raise AssertionError(f"{self.path} received nothing when {what} was sent")
        return json.loads(raw)

    async def drain_opening(self) -> list[dict]:
        """A fresh socket is answered with its own config, then its status.

        Both are returned, because "did this client type get its config" is the
        assertion that matters and it cannot be made after the frames are dropped.
        """
        return [await self.take("the socket opened"), await self.take("the socket opened")]

    async def settled(self, within: float = 1.0) -> bool:
        """True when the app has finished with this socket — accepted or refused."""
        try:
            await asyncio.wait_for(self.connected.wait(), within)
            return True
        except asyncio.TimeoutError:
            return False


def scope_for(path: str) -> dict:
    return {
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


async def attach(path: str):
    """Open a socket and return it with its task, without assuming it succeeded."""
    conn = Connection(path)
    task = asyncio.create_task(app(scope_for(path), conn.receive, conn.send))
    return conn, task


async def attach_ok(path: str):
    """Open a socket, insisting that it was accepted."""
    conn, task = await attach(path)
    if not await conn.settled(3.0):
        conn.close()
        task.cancel()
        raise AssertionError(f"{path} was refused; expected it to be accepted")
    return conn, task


async def refused(path: str) -> int:
    """Open a socket expecting a refusal, and return the close code it was given.

    Also fails the test if the app task raised. That is the half that matters: a
    refusal used to be `close()` followed by an unhandled `RuntimeError`, and an
    unhandled exception in a route is an ERROR record on the root logger — which is
    where `logbuffer` keeps the ring the dashboard's Logs page exists to read. So
    walking into a cap quietly evicted the real errors that page shows, repeatably
    and without a credential.
    """
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


async def run() -> None:
    room = "61ea70c9-6d36-4a6a-bf94-b648532447bb"
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        made = await client.post("/api/rooms", json={"name": "WS types"}, headers=AUTH)
        check("a room to attach to", made.status_code in (200, 201), f"got {made.status_code}")

        print("every type the product connects as is accepted")
        # `overlay` is the one that was missing, and the two beside it are here so
        # that widening the list cannot quietly break an existing one.
        for client_type in ("room", "customizer", "overlay"):
            conn, task = await attach_ok(f"/ws/{client_type}/{room}")
            try:
                opening = await conn.drain_opening()
                check(
                    f"{client_type} gets its config, then its status",
                    [frame.get("type") for frame in opening] == ["config", "status"],
                    f"got {[frame.get('type') for frame in opening]}",
                )
            finally:
                conn.close()
                task.cancel()

        print("an overlay receives the room's events, not just its opening frames")
        overlay, task = await attach_ok(f"/ws/overlay/{room}")
        try:
            await overlay.drain_opening()
            await emit(room, Event(kind="comment", user="dina", user_id="dina", value="halo overlay"))
            got = await overlay.take("a comment for the room")
            check("the overlay receives it", "halo overlay" in str(got), f"got {got}")
        finally:
            overlay.close()
            task.cancel()

        print("an unknown type is still refused, and quietly")
        code = await refused(f"/ws/not-a-real-type/{room}")
        check("it is closed as a policy violation", code == 1008, f"got close code {code}")

        print("the per-room cap applies to overlays, which is where the clients are")
        # One below the ceiling, so the next one is the refusal.
        held: list = []
        try:
            for _ in range(hub_module.MAX_CLIENTS_PER_ROOM):
                conn, task = await attach_ok(f"/ws/overlay/{room}")
                held.append((conn, task))
            check(
                f"a room holds {hub_module.MAX_CLIENTS_PER_ROOM} overlays",
                sum(1 for rid in hub_module.hub.room_clients.values() if rid == room)
                == hub_module.MAX_CLIENTS_PER_ROOM,
                f"got {sum(1 for rid in hub_module.hub.room_clients.values() if rid == room)}",
            )
            over = await refused(f"/ws/overlay/{room}")
            check("the next overlay is refused", over == 1013, f"got close code {over}")
        finally:
            for conn, task in held:
                conn.close()
                task.cancel()
            await asyncio.sleep(0)

        print("a customizer is not counted against the viewer's ceiling")
        # The operator's own editing surface. Counting it would lock them out of
        # styling a room that already has overlays on it, which is the normal state
        # of a stream that is set up and running.
        held: list = []
        try:
            for _ in range(hub_module.MAX_CLIENTS_PER_ROOM):
                conn, task = await attach_ok(f"/ws/overlay/{room}")
                held.append((conn, task))
            editor, editor_task = await attach_ok(f"/ws/customizer/{room}")
            held.append((editor, editor_task))
            check("a customizer still attaches to a full room", editor.close_code is None)
        finally:
            for conn, task in held:
                conn.close()
                task.cancel()
            await asyncio.sleep(0)

        print("the total is bounded, which the per-room cap alone never was")
        # Lowered rather than opened 200 times: the assertion is that the ceiling
        # exists and refuses, and that is not a property of how large it is.
        original = hub_module.MAX_CLIENTS_TOTAL
        hub_module.MAX_CLIENTS_TOTAL = 3
        held = []
        try:
            # Three different room ids, so the per-room cap cannot be what refuses
            # the fourth. This is the shape of the bypass: the room id is a free-form
            # path segment, so a caller at one room's ceiling just asks for another.
            for index in range(3):
                conn, task = await attach_ok(f"/ws/overlay/made-up-room-{index}")
                held.append((conn, task))
            over = await refused("/ws/overlay/made-up-room-3")
            check("a fourth room's socket is refused at the total ceiling", over == 1013, f"got close code {over}")
        finally:
            hub_module.MAX_CLIENTS_TOTAL = original
            for conn, task in held:
                conn.close()
                task.cancel()
            await asyncio.sleep(0)

    print()
    print(f"all passed ({PASSED} assertions)", flush=True)


if __name__ == "__main__":
    asyncio.run(run())
