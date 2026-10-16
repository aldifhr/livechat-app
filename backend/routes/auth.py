"""Token-based authorisation for the write path.

A deployed API is public on the network. Without a token anyone could delete a
stream's rooms, rewrite its config, or post a fake 999-diamond gift. Read and
stream access stays open on purpose: the room page is loaded by OBS, which
cannot send a header, and it needs the event stream to render at all.
"""
import os
import secrets

from fastapi import Request

from logging_setup import logger

#: Read from the API's environment. Read per call rather than cached at import
#: so a test — and a future config reload — can change it without reimporting
#: the module.
def api_token() -> str:
    return os.environ.get("STREAMKIT_TOKEN", "").strip()


#: Set to a truthy value to run with the write gate open and no token required.
#: Development only. It exists so a fresh clone still runs with no setup, which
#: is the one case where "no token configured" should mean "no auth wanted"
#: instead of "no auth possible".
AUTH_DISABLED_ENV = "STREAMKIT_AUTH_DISABLED"

_TRUTHY = frozenset({"1", "true", "yes", "on"})


def auth_is_disabled() -> bool:
    return os.environ.get(AUTH_DISABLED_ENV, "").strip().lower() in _TRUTHY


def token_is_valid(request: Request) -> bool:
    expected = api_token()
    if not expected:
        # No token configured is *unsatisfiable*, not *open*. Returning True
        # here meant a deploy that forgot STREAMKIT_TOKEN served every write —
        # delete a room, rewrite its config, post a fake gift — to anyone who
        # found the URL, while every other layer still looked protected.
        return auth_is_disabled()
    header = request.headers.get("x-streamkit-token", "")
    # Compared as bytes, not as str. `compare_digest` raises TypeError on a str
    # holding any non-ASCII code point, and headers arrive decoded as latin-1 —
    # so a single byte above 0x80 in the header was a 500 from inside the auth
    # check, with a stack trace in the log, on an unauthenticated request.
    return bool(header) and secrets.compare_digest(
        header.encode("utf-8", "surrogateescape"), expected.encode("utf-8")
    )


#: The write routes the desktop app needs. It sends no token: the handle is the
#: whole ask, and a token in the app binary would be extractable and would grant
#: full write access to every other route besides these two. Matched per path
#: segment rather than as a prefix: a plain `startswith` also exempted anything
#: that merely began with those characters, which would arrive one refactor
#: later with no auth and no diff on this line.
#:
#: Both are safe because neither lets the caller choose the destination beyond
#: the handle: `room-connect/{id}` reads its username from the stored room, and
#: `room-connect-by-username` creates or reuses the room for the handle given.
EXEMPT_WRITE_PATHS = frozenset({
    "/api/room-connect/",
    "/api/room-connect-by-username",
})


def is_exempt_write_path(path: str) -> bool:
    for prefix in EXEMPT_WRITE_PATHS:
        if not path.startswith(prefix):
            continue
        if prefix.endswith("/"):
            # Exactly one non-empty segment: the room id, and nothing below it.
            rest = path[len(prefix):]
            if rest and "/" not in rest:
                return True
        elif path == prefix:
            return True
    return False


#: Reads that expose room data — names, handles, stored config — and so need the
#: token like a write does. `/api/rooms` and anything under it is the whole set:
#: the list, one room's record, and its status.
#:
#: The overlay pages never call these. An overlay opens a WebSocket and, for a
#: bare handle, POSTs to the exempt connect route; it never reads the room list.
#: The dashboard reaches them through its Next proxy, which holds the token, and
#: the desktop app talks to the backend for `/api/room-connect` alone. So gating
#: them costs no working caller anything, and it closes a list of every streamer
#: and their overlay settings to anyone who finds the host.
#:
#: `/health` and `/metrics` are deliberately NOT here: an orchestrator probes them
#: without a credential. `/health` no longer carries the per-room map to an
#: unauthenticated caller (see the handler) — it leaked the handles.
SENSITIVE_READ_PREFIX = "/api/rooms"


def is_sensitive_read_path(path: str) -> bool:
    return path == SENSITIVE_READ_PREFIX or path.startswith(SENSITIVE_READ_PREFIX + "/")


def warn_if_auth_unsatisfiable() -> None:
    """Say so at boot, once, in the log a deploy actually reads.

    Fail-closed plus silence looks identical to a broken client from the outside:
    every write 401s and nothing says why. The check cannot fail, so this is the
    only place the cause can come from.
    """
    if api_token():
        return
    if auth_is_disabled():
        logger.warning(
            "AUTH: %s is set and STREAMKIT_TOKEN is not — every write endpoint "
            "is open to anyone who can reach this port",
            AUTH_DISABLED_ENV,
        )
        return
    logger.warning(
        "AUTH: STREAMKIT_TOKEN is not set — every write will be refused with 401 "
        "until it is, or until %s=true for local development",
        AUTH_DISABLED_ENV,
    )
