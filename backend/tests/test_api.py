"""Contract test for the split API.

Exercises the routes end to end through TestClient, including a live WebSocket
attach, against a throwaway store file so it never touches a real rooms.json.

Run: python apps/api/test_api.py
"""

import json
import os
import sys
import tempfile
from pathlib import Path

# `apps/api`, not this directory: the modules under test live one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Point the store at a scratch file before main imports it.
_tmp = Path(tempfile.mkdtemp())
os.environ["STREAMKIT_CONFIG_DIR"] = str(_tmp)

# This suite's own calls are written without a token, and that used to work
# because "no token configured" meant "auth off". It no longer does — the backend
# fails closed now, because an unset token on a deployed host is a silent hole
# rather than a sensible default. The opt-out is named and explicit from here on,
# so the suite states which mode it is in instead of inheriting one from the
# environment. The token block at the bottom of the file turns auth back on and
# exercises the gate for real.
os.environ["STREAMKIT_AUTH_DISABLED"] = "true"

import store  # noqa: E402

store.CONFIG_DIR = _tmp
store.ROOMS_FILE = _tmp / "rooms.json"

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
import eventlog  # noqa: E402
from events import ALERT, Event, to_wire  # noqa: E402

def as_entries():
    return []


def _socket_attaches(client) -> bool:
    """A WebSocket attach must survive the token guard.

    OBS loads the room page and it cannot send a header, so if the socket
    were guarded the room would render nothing at all — the failure mode
    would be a silently blank browser source.
    """
    made = client.post("/api/rooms", json={"name": "Sock"}, headers={"x-streamkit-token": "s3cret"})
    if made.status_code != 200:
        return False
    oid = made.json()["room"]["id"]
    try:
        with client.websocket_connect(f"/ws/room/{oid}") as ws:
            return ws.receive_json().get("type") == "config"
    except Exception:
        return False


failures: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        failures.append(label)


# Every write goes through the token check. The suite used to call these
# anonymously, which stopped being honest the moment the backend started
# refusing them: the first assertion died on a 401 rather than on the shape it
# was written to check, and everything after it was skipped for the wrong reason.
# A write that forgets the header fails closed, so a suite whose own calls lost
# it would start asserting against 401s and pass nothing real. Built on each use
# rather than once at import, because the auth block below sets the env var after
# this module is already loaded — a value captured up top would still hold
# whatever the environment happened to say before that.
def auth():
    return {"x-streamkit-token": os.environ.get("STREAMKIT_TOKEN", "s3cret")}


AUTH = auth()


def _warning_text() -> str:
    """What the boot check logs, captured off the logger rather than stdout.

    The warning is the only thing that distinguishes a deploy with no token from
    a deploy with a broken client, so asserting it fires is the point. Reading it
    from the logger instead of the log file keeps the check independent of
    logging configuration the suite does not own.
    """
    import logging

    class _Capture(logging.Handler):
        def __init__(self):
            super().__init__()
            self.records: list[str] = []

        def emit(self, record):
            self.records.append(record.getMessage())

    handler = _Capture()
    main.logger.addHandler(handler)
    try:
        main.warn_if_auth_unsatisfiable()
    finally:
        main.logger.removeHandler(handler)
    return " ".join(handler.records)


with TestClient(main.app) as client:
    print("crud")
    created = client.post("/api/rooms", json={"name": "Test room"}, headers=AUTH).json()["room"]
    oid = created["id"]
    check("create returns id+name", bool(oid) and created["name"] == "Test room")
    # The summary used to carry a `theme` field. It is gone: the frontend has no
    # themes, so the key was a default the backend invented for a concept the rest
    # of the app does not have. A new room carries no config until it is
    # edited, and this says so rather than leaving it unasserted.
    check("create defaults to no config", created["config"] == {}, json.dumps(created["config"]))
    check("create has no theme key", "theme" not in created, json.dumps(sorted(created)))

    check("get by id", client.get(f"/api/rooms/{oid}").json()["name"] == "Test room")
    check("list contains it", oid in [o["id"] for o in client.get("/api/rooms").json()["rooms"]])

    check("missing room is 404", client.get("/api/rooms/nope").status_code == 404)

    print("create from a template")
    # The dashboard resolves a template to a full config and posts it, so that
    # creating an room is one request rather than create-then-save.
    room_config = {
        "version": 2,
        "padding": 12,
        "customCSS": "",
        "global": {"fontSize": 16},
        "widgets": [{"id": "chat-1", "type": "chat", "enabled": True, "x": 0, "y": 1, "scale": 1, "style": {}}],
    }
    tpl = client.post("/api/rooms", json={"name": "From template", "config": room_config}, headers=AUTH).json()["room"]
    check("template config stored verbatim", tpl["config"] == room_config, json.dumps(tpl["config"]))
    listed = {o["id"]: o for o in client.get("/api/rooms").json()["rooms"]}
    check("template widgets visible in list",
          listed[tpl["id"]]["config"]["widgets"][0]["type"] == "chat")
    client.delete(f"/api/rooms/{tpl['id']}", headers=AUTH)

    print("username")
    patched = client.patch(f"/api/rooms/{oid}", json={"username": "@someone"}, headers=AUTH).json()["room"]
    check("username strips @", patched["username"] == "someone", patched["username"])
    check("patch keeps config", client.get(f"/api/rooms/{oid}").json()["config"] == {},
          json.dumps(client.get(f"/api/rooms/{oid}").json()["config"]))

    print("config")
    cfg = {"version": 2, "type": "chat", "padding": 12, "customCSS": "",
           "global": {"fontSize": 16}, "style": {}}
    check("config save", client.post(f"/api/rooms/{oid}/config", json={"config": cfg}, headers=AUTH).status_code == 200)
    check("config persisted", client.get(f"/api/rooms/{oid}").json()["config"] == cfg)
    check("config on missing is 404", client.post("/api/rooms/nope/config", json={"config": cfg}, headers=AUTH).status_code == 404)

    print("websocket attach")
    with client.websocket_connect(f"/ws/room/{oid}") as ws:
        first = ws.receive_json()
        check("first frame is config", first["type"] == "config" and first["config"] == cfg, str(first))
        second = ws.receive_json()
        check("status snapshot on attach", second["type"] == "status" and second["connected"] is False, str(second))

        print("trigger -> pushed to the socket")
        client.post(f"/api/rooms/{oid}/trigger", json={"kind": ALERT, "title": "Hi", "text": "there"}, headers=AUTH)
        pushed = ws.receive_json()
        check("alert reached socket", pushed["type"] == ALERT and pushed["title"] == "Hi", str(pushed))

        print("trigger with a stable user key")
        client.post(f"/api/rooms/{oid}/trigger", json={"kind": "follow", "user": "kei", "user_id": "kei_tiktok"}, headers=AUTH)
        keyed = ws.receive_json()
        check("userId carried through", keyed["userId"] == "kei_tiktok", str(keyed))

        print("customizer clients also see config updates")
        # An opaque type string. The backend never validates this against the
        # widget registry, which is the point being asserted here: config comes
        # back byte-for-byte so the front end is the only thing that decides what
        # a type means.
        client.post(f"/api/rooms/{oid}/config", json={"config": {"type": "chat", "padding": 20}}, headers=AUTH)
        pushed_cfg = ws.receive_json()
        check("config broadcast", pushed_cfg["type"] == "config" and pushed_cfg["config"] == {"type": "chat", "padding": 20},
              str(pushed_cfg))

    print("triggers")
    check("trigger on missing is 404", client.post("/api/rooms/nope/trigger", json={}, headers=AUTH).status_code == 404)
    r = client.post(f"/api/hooks/{oid}", json={"user": "donor", "text": "Rp50k", "amount": 50000}, headers=AUTH)
    check("webhook accepted", r.status_code == 200, r.text)

    print("connect validation")
    check("blank username is 400", client.post("/api/connect", json={"username": "  "}, headers=AUTH).status_code == 400)
    check("disconnect is idempotent", client.post("/api/disconnect", json={"room_id": oid}, headers=AUTH).status_code == 200)

    print("delete")
    check("delete ok", client.delete(f"/api/rooms/{oid}", headers=AUTH).json()["status"] == "ok")
    check("delete twice is 404", client.delete(f"/api/rooms/{oid}", headers=AUTH).status_code == 404)

print("wire format")
check("comment wire unchanged", to_wire(Event(kind="comment", user="a", value="hi")) == {"type": "comment", "user": "a", "userId": "a", "avatar": "", "text": "hi"})
check("like wire unchanged", to_wire(Event(kind="like", user="a", meta={"count": 2, "totalLikes": 9})) == {"type": "like", "user": "a", "userId": "a", "avatar": "", "count": 2, "totalLikes": 9})
check("gift wire unchanged", to_wire(Event(kind="gift", user="a", meta={"giftName": "Rose", "count": 1, "value": 5})) == {"type": "gift", "user": "a", "userId": "a", "avatar": "", "giftName": "Rose", "count": 1, "value": 5})
check("join wire unchanged", to_wire(Event(kind="join", user="a", meta={"viewers": 3})) == {"type": "join", "user": "a", "userId": "a", "avatar": "", "viewers": 3})
check("viewers wire unchanged", to_wire(Event(kind="viewers", meta={"count": 12})) == {"type": "viewers", "count": 12})
check("unknown kind surfaces as alert", to_wire(Event(kind="bogus"))["type"] == ALERT)

# The astronaut widget keys persistent per-viewer state, so a missing user_id
# has to degrade to the nickname rather than to an empty key that would merge
# every anonymous viewer into one astronaut.
check(
    "user_id falls back to nickname",
    to_wire(Event(kind="comment", user="kei", value="hi"))["userId"] == "kei",
)
check(
    "explicit user_id wins",
    to_wire(Event(kind="comment", user="kei", user_id="kei_tiktok", value="hi"))["userId"] == "kei_tiktok",
)
check("follow carries user_id", to_wire(Event(kind="follow", user="a", user_id="z"))["userId"] == "z")
check("share carries user_id", to_wire(Event(kind="share", user="a", user_id="z"))["userId"] == "z")

# Avatar. Empty is the field's normal state: TikTok populates it on comment
# events and leaves it empty on join, follow, like and gift, so every kind
# carries the key and the renderer decides between a picture and an initial.
# Asserting the key is always present matters more than asserting it has a
# value — a client that reads frame["avatar"] must not have to distinguish
# "no avatar" from "old backend that never sent one".
print("avatar on the wire")
AVATAR = "https://p16-sign-va.tiktokcdn.com/abc~t0123.jpg"
check(
    "a comment with an avatar carries the url",
    to_wire(Event(kind="comment", user="kei", avatar=AVATAR, value="hi"))["avatar"] == AVATAR,
)
for kind in ("comment", "like", "gift", "join", "follow", "share"):
    check(
        f"{kind} sends the avatar key even when empty",
        "avatar" in to_wire(Event(kind=kind, user="a")),
    )
check(
    "an empty avatar is an empty string, never None",
    to_wire(Event(kind="comment", user="a"))["avatar"] == "",
)
check(
    "viewers carries no avatar at all — it describes nobody",
    "avatar" not in to_wire(Event(kind="viewers", meta={"count": 12})),
)

print("token guard")
# Everything above ran with no token set, which must stay open so a fresh clone
# works with no setup. Now turn one on and check what it actually covers.
os.environ["STREAMKIT_TOKEN"] = "s3cret"
try:
    with TestClient(main.app) as guarded:
        # Reading has to stay open: the room page is loaded by OBS, which
        # cannot send a header, and it needs the list and the stream to render.
        check("read is open with a token set", guarded.get("/api/rooms").status_code == 200)
        check(
            "socket attach is open with a token set",
            _socket_attaches(guarded),
            "ws handshake rejected",
        )

        check("create without a token is 401", guarded.post("/api/rooms", json={"name": "x"}).status_code == 401)
        check("delete without a token is 401", guarded.delete("/api/rooms/whatever").status_code == 401)
        check("connect without a token is 401", guarded.post("/api/connect", json={"username": "x"}).status_code == 401)
        check("trigger without a token is 401", guarded.post("/api/rooms/x/trigger", json={}).status_code == 401)
        check("hook without a token is 401", guarded.post("/api/hooks/x", json={}).status_code == 401)

        bad = {"x-streamkit-token": "wrong"}
        check("create with a wrong token is 401", guarded.post("/api/rooms", json={"name": "x"}, headers=bad).status_code == 401)

        good = {"x-streamkit-token": "s3cret"}
        made = guarded.post("/api/rooms", json={"name": "Guarded"}, headers=good)
        check("create with the right token works", made.status_code == 200, made.text)

        # A write that forgets the header fails closed, so a suite whose own
        # calls lost it would start asserting against 401s and pass nothing real.
        # Pinning the shared header keeps that from looking like progress.
        check("the shared write header is the one the guard accepts",
              client.post("/api/rooms", json={"name": "Headered"}, headers=auth()).status_code == 200)
        check("a write with no header at all is refused",
              client.post("/api/rooms", json={"name": "Anonymous"}).status_code == 401)
        if made.status_code == 200:
            gid = made.json()["room"]["id"]
            # Checked before the delete, since a 404 here would mean the guard is
            # masking the route's own not-found behaviour rather than passing.
            check(
                "trigger with the right token works",
                guarded.post(f"/api/rooms/{gid}/trigger", json={}, headers=good).status_code == 200,
            )
            check(
                "hook with the right token works",
                guarded.post(f"/api/hooks/{gid}", json={}, headers=good).status_code == 200,
            )
            check("delete with the right token works", guarded.delete(f"/api/rooms/{gid}", headers=good).status_code == 200)

        # A token in the query string used to be accepted, for a browser source
        # in OBS that cannot send headers. There is no such caller left — the
        # frontend sends no token at all, and the OBS room page died with the
        # sidecar — so accepting it only put the token where it ends up in access
        # logs and screenshots, which is the opposite of what a token is for.
        # Pinned as refused so it cannot quietly come back.
        # Pinned on a write, which is the only thing the gate ever covered: the
        # old test used a GET, where the query token was never read because
        # middleware guards mutations only. So "a GET with a token works" was
        # never evidence the fallback existed — it just passed. Now that the
        # fallback is gone, a write with a query token has to be refused.
        check(
            "a write with a query-param token is refused",
            guarded.post("/api/rooms?token=s3cret", json={"name": "ViaQuery"}).status_code == 401,
        )
        check(
            "while the same write with the header is accepted",
            guarded.post("/api/rooms", json={"name": "ViaHeader"}, headers=good).status_code == 200,
        )
finally:
    os.environ.pop("STREAMKIT_TOKEN", None)

print("fail-closed with no token")
# The block above proved a configured token gates writes. This proves the other
# half: an *unconfigured* token refuses them too. It used to accept them —
# `if not expected: return True` — which made a deploy that lost its env file a
# fully open API that still looked protected everywhere else.
os.environ.pop("STREAMKIT_AUTH_DISABLED", None)
os.environ.pop("STREAMKIT_TOKEN", None)
try:
    with TestClient(main.app) as sealed:
        check(
            "a write with no token configured is refused, not allowed",
            sealed.post("/api/rooms", json={"name": "Unconfigured"}).status_code == 401,
        )
        check(
            "and a query param does not open it either",
            sealed.post("/api/rooms?token=anything", json={"name": "Guessed"}).status_code == 401,
        )
        check("read still open", sealed.get("/api/rooms").status_code == 200)

    os.environ["STREAMKIT_AUTH_DISABLED"] = "true"
    with TestClient(main.app) as opened:
        check(
            "the dev opt-out opens writes again",
            opened.post("/api/rooms", json={"name": "Dev"}).status_code == 200,
        )
    check(
        "and the boot warning says the API is open, not that it is refusing",
        "every write endpoint" in _warning_text(),
    )
finally:
    os.environ.pop("STREAMKIT_AUTH_DISABLED", None)
    os.environ.pop("STREAMKIT_TOKEN", None)

print("the OBS exemption is exactly one route")
# The gate exempts /api/room-connect/{id} because OBS cannot send a header. It
# used to be a prefix match, so anything that started with those characters was
# exempt for free — and a longer route name would have inherited that with no
# diff on the line that grants it.
for path, should_be_exempt in (
    ("/api/room-connect/abc", True),
    ("/api/room-connect/", False),
    ("/api/room-connect", False),
    ("/api/room-connect-all", False),
    ("/api/room-connect/abc/force", False),
    ("/api/room-connect-admin", False),
    ("/api/rooms", False),
):
    check(
        f"{path} {'is' if should_be_exempt else 'is not'} exempt",
        main.is_exempt_write_path(path) is should_be_exempt,
    )

os.environ["STREAMKIT_TOKEN"] = "s3cret"
try:
    with TestClient(main.app) as tight:
        check(
            "a longer route name is gated, not exempt",
            tight.post("/api/room-connect-admin", json={}).status_code == 401,
        )
finally:
    os.environ.pop("STREAMKIT_TOKEN", None)

print("a hostile token header is a 401, not a 500")
# `secrets.compare_digest` raises TypeError on a str holding any non-ASCII code
# point, and headers arrive decoded as latin-1 — so one byte above 0x80 in the
# token header was a traceback from inside the auth check, on an unauthenticated
# request. It must come back as the same 401 as any other wrong token.
os.environ["STREAMKIT_TOKEN"] = "s3cret"
try:
    with TestClient(main.app) as nasty:
        # Sent as raw bytes on purpose. httpx refuses to put a non-ASCII str in a
        # header, which is why this goes through the transport directly: what has
        # to be exercised is a header that *arrives* holding a byte above 0x80,
        # because that is what Starlette decodes and hands to the auth check.
        r = nasty.request(
            "POST",
            "/api/rooms",
            content=json.dumps({"name": "HighBytes"}).encode("utf-8"),
            headers={
                "content-type": "application/json",
                # Bytes, so the header genuinely arrives holding a non-ASCII code
                # point after latin-1 decoding rather than being refused client-side.
                "x-streamkit-token": "ÿþ".encode("latin-1"),
            },
        )
        check("a non-ASCII token is refused, not fatal", r.status_code == 401, f"got {r.status_code}")
finally:
    os.environ.pop("STREAMKIT_TOKEN", None)

print("the 401 a browser sees is a 401, not an opaque CORS failure")
# CORS has to be the outer layer. With the auth guard outermost, its 401 crosses
# the wire without any CORS headers and a browser reports an opaque network
# failure — so the reason for the refusal never reaches the page that has to act
# on it. The origin here is the frontend host, which is the one origin the
# allowlist carries: an overlay page posts a handle to this API from there.
os.environ["STREAMKIT_TOKEN"] = "s3cret"
try:
    with TestClient(main.app) as browser:
        r = browser.post(
            "/api/rooms",
            json={"name": "CrossOrigin"},
            headers={"Origin": "https://streamtools.aldifhr.my.id", "X-StreamKit-Token": "wrong"},
        )
        check("the refusal is a 401", r.status_code == 401, f"got {r.status_code}")
        check(
            "and it carries the header that lets the page read it",
            r.headers.get("access-control-allow-origin") is not None,
            f"headers={dict(r.headers)}",
        )

        # An origin that is not on the allowlist gets no grant. `*` used to be
        # returned here, which let any page on the internet read this API's
        # responses from a victim's browser.
        r = browser.get("/api/rooms", headers={"Origin": "https://evil.example"})
        check(
            "an origin off the allowlist gets no CORS grant",
            r.headers.get("access-control-allow-origin") is None,
            f"headers={dict(r.headers)}",
        )
finally:
    os.environ.pop("STREAMKIT_TOKEN", None)

print("a junk websocket frame does not take the handler down")
# `null`, `123`, `"x"` and `[1,2]` are all valid JSON and none of them has `.get`,
# so the handler used to raise AttributeError and die with a traceback on an
# unauthenticated socket. The socket must survive them and still answer a ping.
with TestClient(main.app) as socket_client:
    with socket_client.websocket_connect("/ws/room/test-room") as ws:
        handshake_ok = True
        reply = {}
        try:
            # The handshake sends config and status first; drain them so the pong
            # is the next thing on the wire.
            ws.receive_json()
            ws.receive_json()
            for junk in ("null", "123", '"x"', "[1,2]"):
                ws.send_text(junk)
            ws.send_text(json.dumps({"type": "ping"}))
            # Several junk frames may each have produced nothing; the pong is the
            # first non-junk frame to come back.
            for _ in range(4):
                reply = ws.receive_json()
                if reply.get("type") == "pong":
                    break
        except Exception as exc:  # noqa: BLE001 — a dead socket is the failure
            handshake_ok = False
            reply = {"error": str(exc)}
        check("the socket survived every non-object frame", handshake_ok, json.dumps(reply))
        check("and still answers a ping", reply.get("type") == "pong", json.dumps(reply))

print("two rooms on one server each get their own leaderboard")
# The event log kept one set of counters for the whole process, so a second room
# connecting cleared the first one's, the leaderboard became a mixture of both
# rooms' viewers, and the same handle posting in either room read as a repeat of
# itself. Driven over real sockets because the leaderboard is answered per
# connection from the room the socket is in.
with TestClient(main.app) as boards:
    with boards.websocket_connect("/ws/room/alpha-board") as a_ws, \
         boards.websocket_connect("/ws/room/beta-board") as b_ws:
        for socket in (a_ws, b_ws):
            socket.receive_json()  # config
            socket.receive_json()  # status
        eventlog.set_connected("alpha-board", True, "@alpha")
        eventlog.record("alpha-board", "comment", user="Ana", text="a1", user_id="ana")
        eventlog.record("alpha-board", "comment", user="Ana", text="a2", user_id="ana")
        eventlog.set_connected("beta-board", True, "@beta")
        eventlog.record("beta-board", "comment", user="Citra", text="b1", user_id="citra")

        def board(socket):
            socket.send_text(json.dumps({"type": "topChatters"}))
            while True:
                frame = socket.receive_json()
                if frame.get("type") == "topChatters":
                    return frame["chatters"]

        a_board = board(a_ws)
        b_board = board(b_ws)
        check(
            "alpha's board holds only alpha's viewers",
            [(c["nickname"], c["messages"]) for c in a_board] == [("Ana", 2)],
            json.dumps(a_board),
        )
        check(
            "beta's board holds only beta's viewers",
            [(c["nickname"], c["messages"]) for c in b_board] == [("Citra", 1)],
            json.dumps(b_board),
        )

        # A room that never produced anything answers empty rather than handing
        # back somebody else's ranking, which is what a shared board did.
        with boards.websocket_connect("/ws/room/quiet-board") as q_ws:
            q_ws.receive_json()
            q_ws.receive_json()
            check("a quiet room gets an empty board", board(q_ws) == [], json.dumps(board(q_ws)))
eventlog.forget("alpha-board")
eventlog.forget("beta-board")


print("the overlay page, served from the backend")
# The point of serving it here rather than from the app's loopback port: OBS can
# live on any machine and still reach it. The page takes its settings from the
# query string, so the handler is nearly inert — it answers the file and leaves
# the query for the page. What matters is that it answers at all, with and
# without the trailing slash, because an OBS source is configured once by hand.
page = client.get("/overlay/")
check("the overlay page is served", page.status_code == 200, str(page.status_code))
check("it is html", "text/html" in page.headers.get("content-type", ""))
check("it is the real page, not a stub", "Live chat overlay" in page.text)
check("the config placeholder is left for the page to read", "__OVERLAY_CONFIG__" in page.text)
check("no-store, so a source reload picks up an edit", page.headers.get("cache-control") == "no-store")
# With a query string, which is how OBS sends the handle and styling.
check("it answers with a query string too", client.get("/overlay/?room=ana&size=22").status_code == 200)
check("and without the trailing slash", client.get("/overlay").status_code == 200)
# A mistyped path is a 404, not the page — otherwise a typo produces a working
# chat and nobody can tell why.
check("a mistyped path is a 404", client.get("/overlay-wrong").status_code == 404)

print("a connect can remember the room's overlay styling")
# The point of storing it on the room: the overlay link can then be a bare
# `?room=<id>` and still render as configured, because the room carries the look.
made = client.post(
    "/api/room-connect-by-username",
    json={
        "username": "styledstreamer",
        "overlay": {
            "overlaySize": 30,
            "overlayNameColour": "#abcdef",
            "overlayBg": 0.2,
            "overlayFont": "Arial",
            "notAnOverlayKey": "ignored",
        },
    },
)
check("the connect still succeeds", made.status_code == 200, str(made.status_code))
styled_id = made.json()["room_id"]
saved = client.get(f"/api/rooms/{styled_id}").json()["config"]
check("the size was stored", saved.get("overlaySize") == 30, json.dumps(saved))
check("the name colour was stored", saved.get("overlayNameColour") == "#abcdef", json.dumps(saved))
check("the background was stored", saved.get("overlayBg") == 0.2, json.dumps(saved))
check("the font was stored", saved.get("overlayFont") == "Arial", json.dumps(saved))
check("an unknown key was dropped, not stored", "notAnOverlayKey" not in saved, json.dumps(saved))
# And the overlay page bakes that styling in, so the bare id link renders it.
page = client.get(f"/overlay/?room={styled_id}").text
check("the page carries the stored size", '"size": 30' in page or '"size":30' in page, page[page.find("__OVERLAY"):][:120] if "__OVERLAY" in page else "no placeholder")

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("all passed")