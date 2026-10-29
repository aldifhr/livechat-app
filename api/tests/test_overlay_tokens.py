"""Overlay tokens, Origin, and the log scrub that has to travel with them.

The event socket is open by design and stays open: OBS cannot present a header,
and an overlay that asked for a password would show a password box on stream.
The room id in the URL has always been the capability — it is a `uuid4`, so it
is not guessable, and knowing it is what "is allowed to watch this room" has
meant since the first version.

That model has one hole and it is not the socket: `/api/rooms/public` answers
with every room's id, handle and name to anyone, because the OBS docks room
switcher needs a list and a browser source has no credential to present. So the
set of capabilities is public, and "know the id" is a check anyone can pass.

`wsguard` closes that without breaking a single existing overlay, and the
transition is the part most likely to be got wrong by a future change:

  * a token is **verified when presented and optional when absent**, so every
    overlay link that exists today keeps working untouched — a streamer cannot
    re-enter URLs in OBS mid-broadcast;
  * `STREAMKIT_WS_REQUIRE_TOKEN=true` completes the cutover later, as one
    environment variable rather than a code change;
  * Origin is **off by default**, because a deployment that serves its overlay
    HTML from a domain outside `STREAMKIT_ALLOWED_ORIGINS` — a normal thing to
    do with a static file — would otherwise be refused by a check nobody asked
    for.

And because a token travels in a query string, it has to be scrubbed from every
log line this process writes. That half is asserted here too: a credential that
is safe on the wire and cleartext in the journal is not safe.

Run with the backend's interpreter:

    python api/tests/test_overlay_tokens.py
"""

import logging
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_tmp = Path(tempfile.mkdtemp())
os.environ["STREAMKIT_CONFIG_DIR"] = str(_tmp)

import wsguard  # noqa: E402
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


class FakeSocket:
    """Just enough of a WebSocket for `authorize` to make its decision."""

    def __init__(self, token: str = "", origin: str = "") -> None:
        self.query_params = {"token": token} if token else {}
        self.headers = {"origin": origin} if origin else {}


def with_env(name: str, value: str):
    """Set one wsguard switch for the duration of a block, then put it back."""
    class _Restore:
        def __init__(self) -> None:
            self.had = name in os.environ
            self.old = os.environ.get(name)

        def __enter__(self):
            os.environ[name] = value

        def __exit__(self, *exc):
            if self.had:
                os.environ[name] = self.old
            else:
                os.environ.pop(name, None)

    return _Restore()


print("\na token opens exactly one room")
minted = wsguard.mint("room-a")
check("it carries the token", bool(minted.get("token")), str(minted))
check("it names the room it opens", minted.get("roomId") == "room-a", str(minted))
check("it says when it expires", minted.get("expiresAt", 0) > time.time(), str(minted))
check("and how long it has", minted.get("expiresIn", 0) > 0, str(minted))
check("the token is long enough to be a credential", len(minted["token"]) >= 32,
      str(len(minted["token"])))
check("two mints are two tokens", wsguard.mint("room-a")["token"] != minted["token"])

check("it verifies for its own room", wsguard.verify(minted["token"], "room-a"))
check("and not for another", not wsguard.verify(minted["token"], "room-b"))
check("an empty token verifies for nothing", not wsguard.verify("", "room-a"))
check("an empty room verifies for nothing", not wsguard.verify(minted["token"], ""))
check("a token that was never minted verifies for nothing",
      not wsguard.verify("not-a-real-token", "room-a"))

print("\nan expired token is spent, and stays spent")
short = wsguard.mint("room-a", ttl=-1.0)
check("it does not verify", not wsguard.verify(short["token"], "room-a"))
check("and it was dropped rather than left to the purge",
      short["token"] not in wsguard._tokens, "an expired token is still resident")
check("so a replay is refused the same way as one that never existed",
      not wsguard.verify(short["token"], "room-a"))

print("\nrevoking is immediate and honest about what it did")
live = wsguard.mint("room-a")
check("revoke reports that it was live", wsguard.revoke(live["token"]))
check("and the token stops verifying", not wsguard.verify(live["token"], "room-a"))
check("revoking it again reports that it was not", not wsguard.revoke(live["token"]))

print("\nrevoking a room takes every token minted for it")
wsguard._tokens.clear()
for _ in range(3):
    wsguard.mint("room-x")
other = wsguard.mint("room-y")
check("four tokens are live", wsguard.live_tokens() == 4, str(wsguard.live_tokens()))
check("revoke_room reports how many", wsguard.revoke_room("room-x") == 3)
check("and they are all gone", wsguard.live_tokens() == 1, str(wsguard.live_tokens()))
check("the other room's token survives", wsguard.verify(other["token"], "room-y"))
check("revoking a room with no tokens reports zero", wsguard.revoke_room("room-nobody") == 0)

print("\nthe token table is capped, and the oldest goes first")
# An unbounded dict keyed on something a caller can cause to be created is a
# memory leak with extra steps. Expired entries are dropped first, then the
# oldest by expiry — the token closest to death is the cheapest to lose.
original_cap = wsguard.MAX_TOKENS
wsguard.MAX_TOKENS = 4
try:
    wsguard._tokens.clear()
    first = wsguard.mint("room-a", ttl=10_000)
    for i in range(6):
        wsguard.mint(f"room-{i}", ttl=10_000 + i)
    check("the table is at its cap", len(wsguard._tokens) == 4, str(len(wsguard._tokens)))
    check("the oldest token was evicted", first["token"] not in wsguard._tokens)
    check("the newest survived", wsguard.live_tokens() == 4, str(wsguard.live_tokens()))
finally:
    wsguard.MAX_TOKENS = original_cap
    wsguard._tokens.clear()

print("\nOrigin is a defence in depth, and it is off by default")
check("an exact origin is allowed", wsguard.origin_allowed("https://host.tld", ["https://host.tld"]))
check("a trailing slash is the same site",
      wsguard.origin_allowed("https://host.tld/", ["https://host.tld"]))
check("case does not matter", wsguard.origin_allowed("https://HOST.tld", ["https://host.tld"]))
check("a foreign origin is refused", not wsguard.origin_allowed("https://evil.tld", ["https://host.tld"]))
check("a sandboxed page's null origin is refused",
      not wsguard.origin_allowed("null", ["https://host.tld"]))
check("a non-browser client that sends no origin is not refused",
      wsguard.origin_allowed("", ["https://host.tld"]))
check("the switch is off unless asked for", not wsguard.origin_check_enabled())

print("\nauthorize: no token, no requirement")
wsguard._tokens.clear()
before = _metrics.ws_token_refused
with with_env(wsguard.REQUIRE_TOKEN_ENV, ""):
    check("a handshake with no token is allowed",
          wsguard.authorize(FakeSocket(), "room-a", []) is None)
    check("and nothing was counted", _metrics.ws_token_refused == before,
          str(_metrics.ws_token_refused))

print("\nauthorize: a token is required, and its absence is a refusal")
with with_env(wsguard.REQUIRE_TOKEN_ENV, "true"):
    check("the switch reads as on", wsguard.require_token())
    reason = wsguard.authorize(FakeSocket(), "room-a", [])
    check("a tokenless handshake is refused", reason == "overlay token required", str(reason))
    check("and it was counted", _metrics.ws_token_refused == before + 1,
          str(_metrics.ws_token_refused))
    good = wsguard.mint("room-a")
    check("a valid token is allowed", wsguard.authorize(FakeSocket(good["token"]), "room-a", []) is None)
    check("a token for another room is refused",
          wsguard.authorize(FakeSocket(good["token"]), "room-b", []) == "invalid overlay token")
    check("a made-up token is refused",
          wsguard.authorize(FakeSocket("nope"), "room-a", []) == "invalid overlay token")

print("\nauthorize: an invalid token is refused before Origin is even looked at")
# The order matters: a caller with a stolen token must not be able to learn
# anything from an Origin refusal, and a caller with neither is refused for the
# reason that is actually true of them.
with with_env(wsguard.REQUIRE_TOKEN_ENV, "true"), with_env(wsguard.ORIGIN_CHECK_ENV, "1"):
    reason = wsguard.authorize(FakeSocket("nope", origin="https://evil.tld"), "room-a",
                               ["https://host.tld"])
    check("the token is what it is refused for", reason == "invalid overlay token", str(reason))

print("\nauthorize: Origin, when it is switched on")
wsguard._tokens.clear()
before_origin = _metrics.ws_origin_refused
with with_env(wsguard.ORIGIN_CHECK_ENV, "1"):
    check("the switch reads as on", wsguard.origin_check_enabled())
    check("a foreign origin is refused",
          wsguard.authorize(FakeSocket(origin="https://evil.tld"), "room-a",
                            ["https://host.tld"]) == "origin not allowed")
    check("and it was counted", _metrics.ws_origin_refused == before_origin + 1,
          str(_metrics.ws_origin_refused))
    check("an allowed origin passes",
          wsguard.authorize(FakeSocket(origin="https://host.tld"), "room-a",
                            ["https://host.tld"]) is None)
    check("a non-browser client with no origin passes",
          wsguard.authorize(FakeSocket(), "room-a", ["https://host.tld"]) is None)
with with_env(wsguard.ORIGIN_CHECK_ENV, ""):
    check("with the switch off, a foreign origin is not refused",
          wsguard.authorize(FakeSocket(origin="https://evil.tld"), "room-a",
                            ["https://host.tld"]) is None)

print("\nthe scrub takes the value and leaves the shape")
check("a query token is redacted",
      wsguard.scrub("GET /ws/overlay/r?token=abc123 HTTP/1.1") ==
      "GET /ws/overlay/r?token=<redacted> HTTP/1.1",
      wsguard.scrub("GET /ws/overlay/r?token=abc123 HTTP/1.1"))
check("an ampersand token is redacted too",
      "abc123" not in wsguard.scrub("/x?a=1&token=abc123&b=2"),
      wsguard.scrub("/x?a=1&token=abc123&b=2"))
check("the alternative key is redacted as well",
      "abc123" not in wsguard.scrub("/x?overlay_token=abc123"))
check("the key's case does not matter",
      "abc123" not in wsguard.scrub("/x?TOKEN=abc123"))
check("a line with no token is untouched",
      wsguard.scrub("GET /ws/overlay/r HTTP/1.1") == "GET /ws/overlay/r HTTP/1.1")
check("an empty string is untouched", wsguard.scrub("") == "")
check("a non-string is returned as it came", wsguard.scrub(None) is None)  # type: ignore[arg-type]

print("\nthe filter rewrites the record, not the formatted line")
# `record.getMessage()` is not used: the args are substituted at format time,
# after filters run, so scrubbing has to rewrite `msg` and `args` themselves.
#
# The shapes below are the ones uvicorn actually produces. Its access format is
# `'%s - "%s %s HTTP/%s" %d'` with the *path* as its own arg — so the token
# arrives as `/ws/overlay/r?token=…` inside an argument, with the `token=` prefix
# intact, and that is what has to be scrubbed. A bare token value with no prefix
# is not recognisable as one and is deliberately left alone: the alternative is a
# scrubber that guesses, and a scrubber that guesses is a scrubber that mangles
# ordinary log lines.
record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                           'GET /ws/overlay/r?token=%s', ("supersecret",), None)
wsguard.ScrubbingFilter().filter(record)
check("the message is scrubbed", "supersecret" not in str(record.msg), str(record.msg))

record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                           '%s "%s %s HTTP/%s" %d',
                           ("1.2.3.4", "GET", "/ws/overlay/r?token=supersecret", "1.1", 101),
                           None)
wsguard.ScrubbingFilter().filter(record)
check("and the path argument is too",
      "supersecret" not in str(record.args), str(record.args))
check("while the rest of the line survives",
      "1.2.3.4" in str(record.args) and "101" in str(record.args), str(record.args))

record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                           "%s", ({"url": "/ws?token=supersecret"},), None)
wsguard.ScrubbingFilter().filter(record)
check("a dict arg is scrubbed", "supersecret" not in str(record.args), str(record.args))

record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                           "%s", "token=supersecret", None)
wsguard.ScrubbingFilter().filter(record)
check("a bare string arg is scrubbed", "supersecret" not in str(record.args), str(record.args))

record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                           "no args here", None, None)
check("a record with nothing to scrub still passes", wsguard.ScrubbingFilter().filter(record))


class Exploding:
    """A record whose scrubbing raises, to prove the filter cannot take a logger down."""

    msg = property(lambda self: (_ for _ in ()).throw(RuntimeError("boom")))


check("a filter that meets something odd does not raise",
      wsguard.ScrubbingFilter().filter(Exploding()))  # type: ignore[arg-type]

print("\ninstalling the scrub is idempotent")
# Attached to *handlers*, not loggers: a filter on a logger only sees records
# logged directly on it, and the access log this exists for comes from
# `uvicorn.access` — a logger this module has no reason to own. A handler filter
# sees every record that reaches that handler, whatever logger it came from.
sink = logging.getLogger("uvicorn.access")
handler = logging.StreamHandler()
sink.addHandler(handler)
try:
    wsguard.install_log_scrub()
    first = sum(1 for f in handler.filters if isinstance(f, wsguard.ScrubbingFilter))
    wsguard.install_log_scrub()
    second = sum(1 for f in handler.filters if isinstance(f, wsguard.ScrubbingFilter))
    check("the filter is attached to the handler", first == 1, str(first))
    check("and a second install does not attach a second one", first == second,
          f"{first} -> {second}")
finally:
    sink.removeHandler(handler)

print()
print(f"all passed ({PASSED} assertions)", flush=True)
