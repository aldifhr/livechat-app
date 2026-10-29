"""The admission caps must hold while a handshake is still in flight.

Both caps used to be checked *before* `await websocket.accept()` and the client
was registered *after* it. Between those two statements the loop is free to run
anything else, so any number of handshakes could pass the same check: five
sockets arriving in one tick all read "zero of five", all accepted, all
registered. The per-room cap and the global cap — the only things between an
unauthenticated port and a process out of file descriptors — were suggestions.

This is the suite that makes that a regression rather than a memory. It is
deterministic by construction: `accept()` sleeps, which is the same suspension
the real handshake has, and every task reaches the check before any of them
finishes accepting. No timing window, no flake, no `sleep` long enough to be
slow and short enough to be lucky.

Run with the backend's interpreter:

    python api/tests/test_ws_admission.py
"""

import asyncio
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ.setdefault("STREAMKIT_CONFIG_DIR", "/tmp/streamkit-admission-test")

import hub as hub_module  # noqa: E402
from metrics import metrics as _metrics  # noqa: E402

PASSED = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASSED
    if cond:
        PASSED += 1
        print(f"  ok   {label}", flush=True)
    else:
        print(f"  FAIL {label}   {detail}", flush=True)
        raise SystemExit(1)


class SlowHandshake:
    """A websocket whose `accept()` suspends, as a real one does.

    The sleep is the whole point. Without it the check and the registration run
    in one uninterrupted stretch of the event loop and no interleaving is
    possible — which is exactly the condition under which the old code looked
    correct.
    """

    def __init__(self) -> None:
        self.accepted = False
        self.closed: tuple[int, str] | None = None

    async def accept(self) -> None:
        await asyncio.sleep(0.05)
        self.accepted = True

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)


async def flood(h: hub_module.Hub, count: int, client_type: str, room_id: Any):
    """Open `count` handshakes at once and report what each of them got."""
    sockets = [SlowHandshake() for _ in range(count)]
    results = await asyncio.gather(
        *(h.connect(ws, client_type, room_id) for ws in sockets),  # type: ignore[arg-type]
        return_exceptions=True,
    )
    return sockets, results


async def run() -> None:
    print("\nthe per-room cap counts handshakes that have not landed yet")
    original_room_cap = hub_module.MAX_CLIENTS_PER_ROOM
    hub_module.MAX_CLIENTS_PER_ROOM = 2
    try:
        h = hub_module.Hub()
        sockets, results = await flood(h, 6, hub_module.ROOM, "race-room")

        admitted = [r for r in results if isinstance(r, str) and r]
        refused = [r for r in results if isinstance(r, str) and not r]
        raised = [r for r in results if isinstance(r, BaseException)]

        check("nothing raised", not raised, str(raised[:1]))
        check(
            f"exactly {hub_module.MAX_CLIENTS_PER_ROOM} got in",
            len(admitted) == hub_module.MAX_CLIENTS_PER_ROOM,
            f"{len(admitted)} admitted, {len(refused)} refused",
        )
        check(
            "and the rest were refused",
            len(refused) == 4,
            f"{len(refused)} refused",
        )
        check(
            "the hub holds exactly the admitted clients",
            len(h.active) == hub_module.MAX_CLIENTS_PER_ROOM,
            f"{len(h.active)} active",
        )
        check(
            "every refusal was closed with 1013 and a reason",
            all(ws.closed is not None and ws.closed[0] == 1013 for ws in sockets if not ws.accepted),
            str([ws.closed for ws in sockets]),
        )
        check(
            "no socket was accepted and then refused",
            all(ws.accepted for ws in sockets if ws.closed is None),
            str([(ws.accepted, ws.closed) for ws in sockets]),
        )
        check(
            "the in-flight reservations were all released",
            h._pending_total == 0 and not h._pending_rooms,
            f"total={h._pending_total} rooms={h._pending_rooms}",
        )
    finally:
        hub_module.MAX_CLIENTS_PER_ROOM = original_room_cap

    print("\nthe total cap counts them too, across made-up room ids")
    # The shape of the bypass: the room id is a free-form path segment, so a
    # caller sitting at one room's ceiling simply asks for the next one. The
    # per-room cap cannot see that; the total one has to.
    original_total = hub_module.MAX_CLIENTS_TOTAL
    hub_module.MAX_CLIENTS_TOTAL = 3
    try:
        h = hub_module.Hub()
        _metrics.ws_refused.clear()
        sockets, results = await flood(h, 6, hub_module.OVERLAY, None)
        admitted = [r for r in results if isinstance(r, str) and r]
        check(
            f"only {hub_module.MAX_CLIENTS_TOTAL} sockets exist",
            len(h.active) == hub_module.MAX_CLIENTS_TOTAL,
            f"{len(h.active)} active",
        )
        check(
            f"exactly {hub_module.MAX_CLIENTS_TOTAL} were admitted and the rest refused",
            len(admitted) == hub_module.MAX_CLIENTS_TOTAL,
            f"{len(admitted)} admitted",
        )
        check(
            "the refusals were counted under the total reason",
            _metrics.ws_refused.get("total", 0) == 3,
            str(_metrics.ws_refused),
        )
    finally:
        hub_module.MAX_CLIENTS_TOTAL = original_total

    print("\na handshake that fails gives its slot back")
    class Vanishing(SlowHandshake):
        async def accept(self) -> None:
            await asyncio.sleep(0)
            raise RuntimeError("peer went away mid-handshake")

    h = hub_module.Hub()
    raised: list[BaseException] = []
    try:
        await h.connect(Vanishing(), hub_module.ROOM, "gone")  # type: ignore[arg-type]
    except RuntimeError as exc:  # noqa: BLE001 — the failure is the point
        raised.append(exc)
    check("the failed handshake propagates", len(raised) == 1, str(raised))
    check("its reservation was released", h._pending_total == 0, str(h._pending_total))
    check("and nothing was registered", not h.active, str(list(h.active)))

    print("\na reservation released twice cannot drive the count negative")
    h = hub_module.Hub()
    h._unreserve(hub_module.ROOM, "r")
    h._unreserve(hub_module.ROOM, "r")
    check("the total stays at zero", h._pending_total == 0, str(h._pending_total))
    check("and the room map is empty", not h._pending_rooms, str(h._pending_rooms))

    print("\na customizer is not counted against a room's viewer ceiling")
    # The operator's own editing surface. Counting it would lock them out of
    # styling a room that already has overlays on it — the normal state of a
    # stream that is set up and running.
    hub_module.MAX_CLIENTS_PER_ROOM = 2
    try:
        h = hub_module.Hub()
        sockets, results = await flood(h, 2, hub_module.OVERLAY, "full-room")
        check("two overlays filled the room", len(h.active) == 2, str(len(h.active)))
        editor_sockets, editor_results = await flood(h, 1, hub_module.CUSTOMIZER, "full-room")
        check(
            "the customizer still attaches",
            bool(editor_results[0]),
            str(editor_results),
        )
        # It lands in `room_clients` like any other client that names a room, so
        # it receives that room's events — that is the routing contract and it is
        # unchanged. What it is exempt from is *being* capped: the check above
        # only runs for a viewer type, so an operator is never locked out of
        # styling a room that already has overlays on it.
        check(
            "and it is routed the room's events like any other client",
            sum(1 for rid in h.room_clients.values() if rid == "full-room") == 3,
            str(h.room_clients),
        )
        check(
            "the room's in-flight reservations were released",
            not h._pending_rooms,
            str(h._pending_rooms),
        )
    finally:
        hub_module.MAX_CLIENTS_PER_ROOM = original_room_cap

    print()
    print(f"all passed ({PASSED} assertions)", flush=True)


if __name__ == "__main__":
    asyncio.run(run())
