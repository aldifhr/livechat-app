"""Alert delivery: what is sent, when, and what happens when it cannot be sent.

The property that matters most here is that alerts never become a second failure.
A webhook that is down, slow, or misconfigured must not raise into the connect
loop or the status path — the alert exists to report a problem, so it cannot be
allowed to cause one.

Run with: .venv/bin/python tests/test_alerts.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import alerts  # noqa: E402
import alert_config  # noqa: E402

FAILS: list[str] = []
COUNT = 0


def check(name: str, ok: bool, extra: object = "") -> bool:
    global COUNT
    COUNT += 1
    if not ok:
        FAILS.append(name)
        print(f"  FAIL {name}" + (f" — {extra}" if extra != "" else ""))
    return ok


def set_webhook(url: str) -> None:
    """Point the webhook somewhere this test controls."""
    # The config module caches nothing, so writing through its own setter keeps the
    # real file untouched and gives this test a URL it can inspect.
    alert_config.set(url)


async def run(coro):
    return await coro


print("\nno webhook means nothing is sent, and nothing raises")
set_webhook("")
result = asyncio.run(run(alerts.notify("test", "room", "user", "message")))
check("notify returns False", result is False)
check("and alerts report disabled", not alerts.enabled())

print("\nwith a webhook, the payload is posted")
set_webhook("https://example.com/hook")


class FakeResponse:
    status_code = 200


captured: dict[str, object] = {}


class FakeClient:
    def __init__(self, *a, **kw):
        captured["timeout"] = kw.get("timeout")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json):
        captured["url"] = url
        captured["json"] = json
        return FakeResponse()


with patch("httpx.AsyncClient", FakeClient):
    result = asyncio.run(run(alerts.notify("gave_up", "room123", "itswyss", "the source gave up")))
check("notify returns True on success", result is True)
check("to the right URL", captured.get("url") == "https://example.com/hook", captured.get("url"))
body = captured["json"]
check("the body is a dict", isinstance(body, dict))
assert isinstance(body, dict)
check("it has content", "content" in body, list(body.keys()))
content = body.get("content", "")
check("the kind is in the message", "gave_up" in content, content[:80])
check("the room is named", "room123" in content, content[:80])
check("and the handle", "@itswyss" in content, content[:80])

print("\na refused webhook does not raise")
set_webhook("https://example.com/hook")


class RefusingResponse:
    status_code = 403


class RefusingClient(FakeClient):
    async def post(self, url, json):
        return RefusingResponse()


with patch("httpx.AsyncClient", RefusingClient):
    result = asyncio.run(run(alerts.notify("test", "room", "user", "message")))
check("notify returns False", result is False)

print("\nan unreachable webhook does not raise")
# Port 9999 on a host that resolves: the connection itself fails, which is what
# this case is about. A private address would be rejected by the validator first
# and never reach the network at all.
set_webhook("https://example.com:9999/hook")


class FailingClient:
    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json):
        raise ConnectionRefusedError("nothing is listening")


with patch("httpx.AsyncClient", FailingClient):
    result = asyncio.run(run(alerts.notify("test", "room", "user", "message")))
check("notify returns False, not an exception", result is False)

print("\nnotify_soon schedules without a running loop")
set_webhook("https://example.com/hook")
# In a sync context (no event loop), notify_soon must drop the alert silently
# rather than raise RuntimeError.
alerts.notify_soon("test", "room", "user", "message")
check("it returned without raising", True)

print("\nnotify_soon works inside an event loop")
set_webhook("https://example.com/hook")
delivered: list[str] = []


class TrackingClient(FakeClient):
    async def post(self, url, json):
        delivered.append(json["content"])
        return FakeResponse()


async def scenario():
    alerts.notify_soon("gave_up", "room", "user", "the source gave up")
    # Let the task run.
    await asyncio.sleep(0.05)


with patch("httpx.AsyncClient", TrackingClient):
    asyncio.run(run(scenario()))
check("the alert was delivered", len(delivered) == 1, delivered)

print("\ndescribe reads the session counters")
import eventlog  # noqa: E402

eventlog.set_connected("test-room", True, "connected")
eventlog.record("test-room", "viewers", meta={"count": 42})
eventlog.record("test-room", "comment", user="tester", user_id="u1")
eventlog.record("test-room", "gift", user="tester", user_id="u1", meta={"value": 50})
summary = alerts.describe("test-room")
check("it mentions the peak", "42" in summary, summary)
check("it mentions diamonds", "50" in summary, summary)
check("it mentions the session", "0m" in summary or "1m" in summary, summary)
eventlog.forget("test-room")

set_webhook("")

print()
if FAILS:
    print(f"{len(FAILS)} failed of {COUNT}")
    for f in FAILS:
        print("  - " + f)
    raise SystemExit(1)
print(f"all passed ({COUNT} assertions)")
