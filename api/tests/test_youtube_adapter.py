"""Tests for the YouTube Live adapter.

The adapter is a thin layer: it wraps a blocking library (pytchatV2), polls in a
worker thread, and normalises each ChatItem into the same `events.Event` the
pipeline already speaks. So the tests target the two things that can actually
break here — the normalisation mapping and the queue lifecycle — and leave
network behaviour to pytchatV2's own suite.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import events as ev
from sources.youtube import YouTubeLiveAdapter

state = {"failed": False}


def check(label, cond, detail=""):
    if cond:
        print(f"  ok    {label}")
    else:
        print(f"  FAIL  {label}  {detail}")
        state["failed"] = True


class _Author:
    def __init__(self, name="someone", channel_id="UC123", image_url="",
                 mod=False, sponsor=False):
        self.name = name
        self.channelId = channel_id
        self.imageUrl = image_url
        self.isChatModerator = mod
        self.isChatSponsor = sponsor


class _Msg:
    def __init__(self, runs):
        self.runs = runs


class _Run:
    def __init__(self, text):
        self.text = text


class _Item:
    def __init__(self, type_, message="", author=None, amount=0, currency="",
                 runs=None):
        self.type = type_
        self.message = message
        self.author = author or _Author()
        self.amountValue = amount
        self.currency = currency
        self.messageEx = _Msg(runs) if runs is not None else None


print("normalisation")


def check(label, cond, detail=""):
    if cond:
        print(f"  ok    {label}")
    else:
        print(f"  FAIL  {label}  {detail}")
        state["failed"] = True


ad = YouTubeLiveAdapter("dQw4w9WgXcQ", "room-1")

e = ad._normalise(_Item("text", "hello there"))
check("text becomes a COMMENT", e.kind == ev.COMMENT, e)
check("the author name is carried", e.user == "someone", e.user)
check("the channel id is the stable user_id", e.user_id == "UC123", e.user_id)
check("the message is the bare payload", e.value == "hello there", e.value)

e = ad._normalise(_Item("text", "hi", author=_Author(mod=True)))
check("a moderator is flagged", e.meta.get("moderator") is True, e.meta)

e = ad._normalise(_Item("superChat", "great stream", amount=500, currency="IDR"))
check("a superChat becomes a GIFT", e.kind == ev.GIFT, e.kind)
check("the amount is in meta", e.meta.get("amount") == 500, e.meta)
check("the currency is kept", e.meta.get("currency") == "IDR", e.meta)

e = ad._normalise(_Item("newSponsor", message="Member for 12 months"))
check("a newSponsor becomes a SUBSCRIPTION", e.kind == ev.SUBSCRIPTION, e.kind)
check("the months are parsed from the message", e.meta.get("months") == 12, e.meta)

e = ad._normalise(_Item("text", ""))
check("a message-less text item is dropped", e is None, e)


print("\nvideo id resolution")
check("a raw id stays itself", ad.video_id == "dQw4w9WgXcQ", ad.video_id)

url = YouTubeLiveAdapter("https://youtu.be/dQw4w9WgXcQ", "r")
check("a share URL resolves", url.video_id == "dQw4w9WgXcQ", url.video_id)

watch = YouTubeLiveAdapter("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "r")
check("a watch URL resolves", watch.video_id == "dQw4w9WgXcQ", watch.video_id)


print("\nstatus payload")
ad._running = False
check("not running is Offline", ad.status_payload()["message"] == "Offline")
ad._running = True
ad._connected = False
check("running but not connected is connecting",
      ad.status_payload().get("connecting") is True, ad.status_payload())
ad._connected = True
payload = ad.status_payload()
check("connected payload says connected", payload.get("connected") is True, payload)


print("\nqueue lifecycle: stop releases a parked consumer")


async def lifecycle():
    ad2 = YouTubeLiveAdapter("x", "room-2")
    ad2._running = True

    # A consumer parked in `get()` must be released by the stop sentinel.
    async def consume():
        count = 0
        async for _ in ad2.observe():
            count += 1
        return count

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.05)  # let it park in get()
    await ad2.disconnect()
    return await task


try:
    asyncio.run(lifecycle())
    check("a stopped observer ends without hanging", True)
except Exception as exc:
    check("a stopped observer ends without hanging", False, exc)


if state["failed"]:
    print("\nFAILURES")
    sys.exit(1)
print("\nall youtube adapter checks passed")
