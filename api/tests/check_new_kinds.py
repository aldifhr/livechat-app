"""Self-check for the new TikTok event kinds: intro, notice, subscription, poll.

Run: cd /root/livechat-app/api && .venv/bin/python tests/check_new_kinds.py
"""
import events

intr = events.to_wire(events.Event(kind=events.INTRO, user="Ann", user_id="ann1",
                                   value="Morning stream"))
ntc = events.to_wire(events.Event(kind=events.NOTICE, value="Welcome to TikTok LIVE!"))
sub = events.to_wire(events.Event(kind=events.SUBSCRIPTION, user="Bo", user_id="bo1",
                                  meta={"months": 4, "isSend": True, "isCustom": False}))
poll = events.to_wire(events.Event(kind=events.POLL, value="Pick one",
                                   meta={"pollId": "99", "options": ["A", "B"], "state": "1"}))

assert intr["type"] == "intro" and intr["title"] == "Morning stream", intr
assert intr["userId"] == "ann1", intr
assert ntc["type"] == "notice" and ntc["text"].startswith("Welcome"), ntc
assert "user" not in ntc, "notice with no sender must not carry a user key"
assert sub["months"] == 4 and sub["isSend"] is True and sub["isCustom"] is False, sub
assert poll["options"] == ["A", "B"] and poll["pollId"] == "99", poll

for kind in (events.INTRO, events.NOTICE, events.SUBSCRIPTION, events.POLL):
    assert kind in events.SERIALISERS, kind

print("SELF-CHECK OK")
