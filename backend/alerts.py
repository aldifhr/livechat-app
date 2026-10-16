"""Telling somebody when a stream breaks.

The backend knows things an operator needs to hear about and had no way to say
them. A stream drops, a source gives up permanently, a room has been offline for
an hour — all of it goes to the log, and the log is only read by someone who
already suspected a problem. The failure this exists for is the one nobody is
watching for: a stream that went quiet at 02:00 and was still quiet at noon.

**Opt-in and inert by default.** With no webhook configured, `notify` is a no-op
that logs at debug and returns. That is deliberate: a backend that starts posting
to a URL nobody set would be a surprise, and a test run should not be able to
message anyone. Setting `STREAMKIT_ALERT_WEBHOOK` is what turns it on.

**Never in the request path.** Delivery is a background task with its own timeout,
and every failure is swallowed. A webhook that is down, slow or misconfigured must
not be able to delay a room's events, hold up a status frame, or take down the
source that was reporting the problem — the alert is about the failure, it must
not become one.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from logging_setup import logger
import alert_config

#: Where alerts are posted. Empty means alerts are off. Kept for the boot log and
#: for callers that only want to know whether alerts are on.
WEBHOOK_ENV = "STREAMKIT_ALERT_WEBHOOK"

#: How long one delivery may take. Short, because nothing waits on it and a
#: webhook that has not answered in five seconds is not going to.
TIMEOUT_S = 5.0

#: Alert kinds that are worth sending. Named rather than free text so a caller
#: cannot invent a kind the receiver has no rule for, and so the set is greppable.
STREAM_DOWN = "stream_down"
STREAM_BACK = "stream_back"
GAVE_UP = "gave_up"
LIVE_ENDED = "live_ended"


def webhook_url() -> str:
    return alert_config.read()


def enabled() -> bool:
    return alert_config.enabled()


def _body(kind: str, room_id: str, username: str, message: str) -> dict[str, Any]:
    """The payload, in the shape a Discord webhook accepts.

    Discord's `content` field rather than a rich embed: an alert is a sentence,
    and an embed would be a card with a title and a colour that has to be chosen
    per kind — a design decision the receiver can make better than the sender, and
    one this module would then have to keep in step with.

    A plain JSON object with `content` is also what most other webhook receivers
    accept, so a deployment pointing this at something else still gets a readable
    message rather than a Discord-specific structure.
    """
    handle = f"@{username}" if username else "(no handle)"
    return {"content": f"**{kind}** · {handle} · `{room_id[:8]}`\n{message}"}


async def notify(kind: str, room_id: str, username: str, message: str) -> bool:
    """Post one alert. Returns whether it was delivered.

    Returns False for "not configured" as well as for "failed", because the caller
    has nothing useful to do with the difference and the log line below already
    says which it was.
    """
    url = webhook_url()
    if not url:
        # Debug, not info: an unconfigured backend should not write a line per
        # dropped alert into the journal it is already trying to keep readable.
        logger.debug("alert suppressed (no %s): %s %s", WEBHOOK_ENV, kind, room_id)
        return False

    try:
        import httpx
    except ImportError:
        logger.warning("alert not sent: httpx is not installed")
        return False

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            response = await client.post(url, json=_body(kind, room_id, username, message))
        if response.status_code >= 400:
            # Logged, not raised. The receiver refusing the message is worth
            # knowing about and is not a reason for the caller to do anything.
            logger.warning("alert rejected by the webhook (%d): %s", response.status_code, kind)
            return False
        logger.info("alert sent: %s %s", kind, room_id)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("alert could not be sent (%s): %s", kind, exc)
        return False


def notify_soon(kind: str, room_id: str, username: str, message: str) -> None:
    """Fire an alert without waiting for it.

    The callers are inside the connect loop and the status path — the places a
    stream's health is decided. Awaiting a webhook there would put a third party's
    response time inside the loop that reads a live stream, so this hands the work
    to the loop and returns.

    Guarded because there is no running loop in a plain sync context, and an alert
    that raises `RuntimeError` from inside a `finally` block would turn a clean
    teardown into a traceback.
    """
    if not enabled():
        return
    try:
        asyncio.get_running_loop().create_task(notify(kind, room_id, username, message))
    except RuntimeError:
        # No loop. Nothing to schedule on, and the alert is not worth blocking for.
        logger.debug("alert dropped (no running loop): %s %s", kind, room_id)


def describe(room_id: str) -> str:
    """A one-line summary of a room's session, for the end of an alert.

    Used on the messages that mean a stream is over, where the useful thing to
    include is what it produced — a stream that ended after three hours and one
    that never started should not read the same.
    """
    import eventlog

    snap = eventlog.snapshot(room_id)
    totals = snap.get("totals") or {}
    parts: list[str] = []
    live = snap.get("live_seconds")
    if live:
        minutes = int(live // 60)
        parts.append(f"{minutes // 60}h{minutes % 60:02d}m" if minutes >= 60 else f"{minutes}m")
    peak = snap.get("peak_viewers") or 0
    if peak:
        parts.append(f"peak {peak}")
    if snap.get("total_diamonds"):
        parts.append(f"{snap['total_diamonds']} diamonds")
    if totals:
        parts.append(" ".join(f"{k}={v}" for k, v in sorted(totals.items())))
    return " · ".join(parts) if parts else "no events"


def describe_json() -> str:
    """The configuration, for the log line at boot. Never the URL itself."""
    return "on" if enabled() else "off"
