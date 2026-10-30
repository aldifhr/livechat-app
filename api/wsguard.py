"""WebSocket admission policy: room-scoped overlay tokens, Origin, log scrub.

The event socket is open by design. OBS cannot present a header, an overlay
that asked for a password would show a password box on stream, and the room id
in the URL has always been the capability: it is a `uuid4`, so it is not
guessable, and knowing it is what "is allowed to watch this room" has meant
since the first version.

That model has one hole and it is not the socket: `/api/rooms/public` answers
with every room's id, handle and name to anyone, because the OBS docks room
switcher needs a list and a browser source has no credential to present. So
the set of capabilities is public, and "know the id" is a check anyone can
pass. This module closes that without breaking a single existing overlay.

**The token.** `POST /api/rooms/{id}/overlay-token` mints a credential that is
narrow by construction: it names exactly one room, it expires, and it can be
revoked. It travels in the query string because that is the only place a
browser can put a value on a WebSocket handshake — `Sec-WebSocket-Protocol` is
the one header a page may set and every client already uses it for nothing, so
it would be a second protocol negotiation for no gain. A query value is
therefore scrubbed from every log line this process writes (see
`install_log_scrub`), and the nginx vhost logs `/ws/` without its query string
so the same value cannot land in the edge's access log either.

**The transition.** A token is *verified when presented and optional when
absent*. Every overlay link that exists today keeps working untouched, which is
the only migration a running stream can survive: a streamer cannot re-enter
URLs in OBS mid-broadcast. An operator who wants the stronger model mints
tokens, points their overlay URLs at them, and then sets
`STREAMKIT_WS_REQUIRE_TOKEN=true` — at which point the room id alone stops
being enough and only a minted token opens the socket. The flag exists so the
cutover is one environment variable rather than a code change, and so the
window where both models are live is a choice rather than an accident.

**Origin is not authentication.** A browser always sends `Origin` on a
WebSocket handshake, so checking it looks like a credential and is not one: it
is a string the browser chooses to send, and any non-browser client simply
omits it. It is implemented here as defence in depth, off by default, because
a deployment that serves its overlay HTML from a domain outside
`STREAMKIT_ALLOWED_ORIGINS` — which is a normal thing to do with a static
file — would otherwise be refused by a check that was never asked for.
"""

from __future__ import annotations

import logging
import os
import re
import secrets
import time
from typing import Any

from metrics import metrics as _metrics

#: How long a minted overlay token is good for.
#:
#: Long enough to outlive a stream — an OBS source is opened once and left
#: running for hours — and short enough that a link pasted into a chat log is
#: not a permanent key to the room. Revocation is the answer for "now", this is
#: the answer for "eventually".
TOKEN_TTL_S = float(os.environ.get("STREAMKIT_OVERLAY_TOKEN_TTL", "") or 6 * 3600)

#: Ceiling on live tokens.
#:
#: Each entry is a room id, an expiry and 43 bytes of token. The cap exists for
#: the same reason every other cap here does: an unbounded dict keyed on
#: something a caller can cause to be created is a memory leak with extra
#: steps. Expired entries are dropped first, then the oldest by expiry.
MAX_TOKENS = 4096

#: When true, a handshake with no token is refused. Off by default — see the
#: module docstring for the migration this completes.
REQUIRE_TOKEN_ENV = "STREAMKIT_WS_REQUIRE_TOKEN"

#: When true, a handshake carrying an `Origin` outside `STREAMKIT_ALLOWED_ORIGINS`
#: is refused. Off by default; see the module docstring.
ORIGIN_CHECK_ENV = "STREAMKIT_WS_ORIGIN_CHECK"

_TRUTHY = frozenset({"1", "true", "yes", "on"})

#: token -> (room_id, expires_at wall clock)
_tokens: dict[str, tuple[str, float]] = {}


def _truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in _TRUTHY


def require_token() -> bool:
    """Whether a handshake must present a valid token. Off by default."""
    return _truthy(REQUIRE_TOKEN_ENV)


def origin_check_enabled() -> bool:
    """Whether a browser `Origin` is enforced. Off by default."""
    return _truthy(ORIGIN_CHECK_ENV)


def _purge(now: float) -> None:
    """Drop expired tokens, then the oldest if the cap is still exceeded."""
    for token, (_, expires_at) in list(_tokens.items()):
        if expires_at <= now:
            del _tokens[token]
    if len(_tokens) < MAX_TOKENS:
        return
    # Oldest expiry first: the token closest to death is the cheapest to lose.
    for token, _ in sorted(_tokens.items(), key=lambda kv: kv[1][1])[: len(_tokens) - MAX_TOKENS + 1]:
        del _tokens[token]


def mint(room_id: str, ttl: float | None = None) -> dict[str, Any]:
    """A credential that opens exactly one room's socket, for one room only.

    The token is 32 random bytes from `secrets` — the same generator the
    giveaway snapshot ids use, for the same reason: it is the whole credential,
    so it comes from a CSPRNG and not from anything derived from the room.
    """
    now = time.time()
    _purge(now)
    token = secrets.token_urlsafe(32)
    expires_at = now + (ttl if ttl is not None else TOKEN_TTL_S)
    _tokens[token] = (room_id, expires_at)
    return {
        "token": token,
        "roomId": room_id,
        "expiresAt": expires_at,
        "expiresIn": int(expires_at - now),
    }


def verify(token: str, room_id: str) -> bool:
    """Whether this token opens this room right now.

    Compared with `compare_digest` rather than `==`: the token is a secret and
    a timing-safe comparison is the difference between "wrong" and "wrong
    after a while" to anyone measuring. The room match is an ordinary string
    comparison because a room id is not a secret — it is in the public list.
    """
    if not token or not room_id:
        return False
    entry = _tokens.get(token)
    if entry is None:
        return False
    bound_room, expires_at = entry
    if expires_at <= time.time():
        # Spent. Dropped rather than left to the purge so a replay after
        # expiry is refused by the same path as one that never existed.
        del _tokens[token]
        return False
    return secrets.compare_digest(bound_room, room_id)


def revoke(token: str) -> bool:
    """Withdraw one token. Returns whether it was live."""
    return _tokens.pop(token, None) is not None


def revoke_room(room_id: str) -> int:
    """Withdraw every token minted for a room. Returns how many.

    Called when a room is deleted: a token for a room that no longer exists
    would keep answering `verify` forever, which is a credential outliving the
    thing it opens.
    """
    doomed = [token for token, (room, _) in _tokens.items() if room == room_id]
    for token in doomed:
        del _tokens[token]
    return len(doomed)


def live_tokens() -> int:
    """How many tokens are currently usable, for `/metrics` and tests."""
    now = time.time()
    return sum(1 for _, expires_at in _tokens.values() if expires_at > now)


def origin_allowed(origin: str, allowed: list[str]) -> bool:
    """Whether a browser `Origin` is one this deployment serves pages from.

    Compared scheme-and-host, ignoring a trailing slash and case, because that
    is what varies between "https://host" and "https://host/" for the same
    site and nothing else does. An `Origin` of "null" — a file:// page, a
    sandboxed iframe — is refused: it is not a site, and the only clients that
    send it are ones with no origin to check.
    """
    if not origin:
        return True
    normalised = origin.strip().rstrip("/").lower()
    if normalised == "null":
        return False
    return normalised in {entry.strip().rstrip("/").lower() for entry in allowed}


def authorize(websocket: Any, room_id: str, allowed_origins: list[str]) -> str | None:
    """Decide whether this handshake may attach to this room.

    Returns `None` to allow, or a short reason to close with. The reason is a
    literal written here, never anything the caller supplied, so it is safe to
    put on a close frame and to count as a metric label.

    The order matters: a presented-but-invalid token is refused before the
    Origin check runs, so a caller with a stolen token cannot learn anything
    from an Origin refusal, and a caller with neither is refused for the
    reason that is actually true of them.
    """
    token = (websocket.query_params.get("token") or "").strip()
    if token:
        if not verify(token, room_id):
            _metrics.ws_token_refused += 1
            return "invalid overlay token"
    elif require_token():
        _metrics.ws_token_refused += 1
        return "overlay token required"

    if origin_check_enabled():
        origin = (websocket.headers.get("origin") or "").strip()
        if origin and not origin_allowed(origin, allowed_origins):
            _metrics.ws_origin_refused += 1
            return "origin not allowed"
    return None


# --------------------------------------------------------------------------
# log scrubbing
# --------------------------------------------------------------------------

#: A token as it appears in text: `token=…` or `overlay_token=…`, up to the next
#: separator. Matched case-insensitively because a query key is case-preserving
#: on the wire and nothing downstream cares about its case.
#:
#: The `\b` is what makes this cover both shapes a token arrives in. As a query
#: value it is preceded by `?` or `&`, which are non-word characters and so sit
#: on a word boundary; written straight into a message (`"connecting with
#: token=…"`) it is preceded by whitespace or the start of the string, which is
#: the same boundary. An earlier version required the `[?&]` prefix explicitly
#: and so missed the second shape entirely — a credential that is safe in a URL
#: and cleartext in a log line is not safe.
#:
#: It deliberately does not match a longer key that merely ends in `token`
#: (`access_token=`, `refresh_token=`): `_` is a word character, so there is no
#: boundary there. Those are not keys this app issues, and a scrubber that
#: guesses at key names is a scrubber that eventually mangles an ordinary line.
_TOKEN_IN_TEXT = re.compile(r"\b((?:token|overlay_token)=)[^&\s\"'<>]+", re.IGNORECASE)

#: What replaces the value. Same length class as the real thing is not the
#: goal; a reader must be able to see *that* a token was there and not what it
#: was.
_REDACTED = "<redacted>"


def scrub(text: str) -> str:
    """Remove any token value from a string that is about to be logged."""
    if not text or "token=" not in text.lower():
        return text
    return _TOKEN_IN_TEXT.sub(lambda m: m.group(1) + _REDACTED, text)

class ScrubbingFilter(logging.Filter):
    """Rewrites token values out of a record before any handler formats it.

    Attached to *handlers*, not loggers: a filter on a logger only sees records
    logged directly on it, and the access log this exists for comes from
    `uvicorn.access`, a logger this module has no reason to own. A handler
    filter sees every record that reaches that handler, whatever logger it came
    from — which is the whole surface.

    `record.getMessage()` is not used: the args are substituted at format time,
    after filters run, so scrubbing has to rewrite `msg` and `args` themselves.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.msg, str):
                record.msg = scrub(record.msg)
            args = record.args
            if isinstance(args, tuple):
                record.args = tuple(scrub(a) if isinstance(a, str) else a for a in args)
            elif isinstance(args, dict):
                record.args = {k: (scrub(v) if isinstance(v, str) else v) for k, v in args.items()}
            elif isinstance(args, str):
                record.args = scrub(args)
        except Exception:  # noqa: BLE001 — a log filter must never raise
            # A filter that raises takes down the caller, and the caller is
            # whatever was trying to log — including a failure handler.
            pass
        return True


def install_log_scrub() -> None:
    """Attach the scrubbing filter to every handler that could emit a URL.

    Idempotent. Called at import (best effort — uvicorn may not have configured
    its handlers yet) and again from lifespan, by which point it certainly has.
    The root logger's handlers are covered too, so a token that reached a
    message by some other route is scrubbed on the way out as well.
    """
    loggers = [logging.getLogger()]
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error", "streamkit"):
        loggers.append(logging.getLogger(name))
    for logger in loggers:
        for handler in logger.handlers:
            if not any(isinstance(f, ScrubbingFilter) for f in handler.filters):
                handler.addFilter(ScrubbingFilter())


# Installed at import as well as from lifespan: the app's own root handler is
# configured by `logging_setup` before this module is imported by anything, and
# uvicorn's are configured before it imports the app — so both are usually
# already present by the time this line runs.
install_log_scrub()
