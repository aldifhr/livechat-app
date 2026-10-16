"""Where the alert webhook lives, and the rules for accepting one.

The webhook is a credential the operator types, so it is stored rather than passed
as a flag — a secret in a shell command shows in `ps` and in whatever recorded the
startup, and this deployment keeps its other secrets in files with `0600`.

Reads environment first, then the file. The file wins when both are set, because
that is the one the dashboard wrote and the one a test just exercised — an env
var set after a save would otherwise silently keep the old destination.

**Writes validate.** A webhook is a URL the server will POST to on failure, so it
is also an SSRF surface: a typo or a malicious save could aim the backend at
itself or at the internal network. Saved URLs must be https and must not point at
a private, loopback or link-local address. The check is against the *resolved*
name, because `localhost` can be spelled many ways and a bare IP can be written
as decimal.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from pathlib import Path
from urllib.parse import urlparse

from logging_setup import logger

#: Where a dashboard-written webhook is kept. Next to the env file the service
#: already reads, and deliberately not under the app: a deploy that reinstalls
#: the app should not take its alert destination with it.
CONFIG_PATH = Path("/etc/streamkit/alerts.env")

_ENV = "STREAMKIT_ALERT_WEBHOOK"


def read() -> str:
    """The configured webhook, from the file or the environment.

    The file takes precedence: it is what a dashboard save wrote, and a variable
    set afterwards would otherwise silently keep pointing alerts at the old place.

    The file is `KEY=VALUE`, not a bare URL, so it is parsed rather than returned
    whole — a secret next to its own name is still a secret, but the value is the
    part that has to be a URL.
    """
    stored = ""
    try:
        raw = CONFIG_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        pass
    except OSError as exc:
        # Unreadable is not a reason to fail a boot — but it does mean alerts are
        # going nowhere, which is worth a warning rather than silence.
        logger.warning("alert config could not be read (%s); alerts are off", exc)
        return ""
    else:
        for line in raw.splitlines():
            if line.startswith(f"{_ENV}="):
                stored = line.split("=", 1)[1].strip()
                break
    return stored or os.environ.get(_ENV, "").strip()


def enabled() -> bool:
    return read() != ""


def describe() -> str:
    """The configuration for a log line or a dashboard panel. Never the URL."""
    return "on" if enabled() else "off"


def _is_safe(host: str) -> bool:
    """Whether a host may be POSTed to.

    Resolved rather than matched as a string: `127.0.0.1`, `localhost`,
    `0x7f000001` and `2130706433` are all the same address, and only the resolved
    form makes that visible. A name that does not resolve is not safe — there is
    no reason an alert should be aimed at a hostname nobody can look up.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        try:
            address = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if address.is_private or address.is_loopback or address.is_link_local:
            return False
    return True


def validate(url: str) -> str | None:
    """Why this URL must not be rejected, or None if it may be saved.

    Returns the reason rather than raising, because the caller is a form: the
    message is what the operator reads, and an exception would have to be turned
    into one anyway.
    """
    if not url:
        return "the webhook URL is empty"
    parsed = urlparse(url)
    if parsed.scheme != "https":
        return "the webhook must be https"
    host = parsed.hostname
    if not host:
        return "the webhook has no host"
    if not _is_safe(host):
        return "the webhook points at a private or local address"
    return None


def set(url: str) -> str | None:
    """Save a webhook. Returns why it was refused, or None on success.

    Writes through a temp file and renames, so a crash mid-write cannot leave a
    half URL that a later read would take for a destination. Restores the file's
    mode if it already exists, so saving does not turn a `0600` secret into a
    world-readable one.
    """
    url = url.strip()
    if not url:
        try:
            CONFIG_PATH.unlink()
        except FileNotFoundError:
            pass
        logger.info("alert webhook cleared")
        return None
    problem = validate(url)
    if problem:
        return problem
    try:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        # Preserve the existing file's mode before replacing it, because
        # `replace()` takes the temp file's mode, not the target's. A secret that
        # was 0600 must not become 0644 on a rewrite.
        mode = CONFIG_PATH.stat().st_mode & 0o777 if CONFIG_PATH.exists() else 0o600
        temporary = CONFIG_PATH.with_suffix(".tmp")
        temporary.write_text(f"{_ENV}={url}\n", encoding="utf-8")
        temporary.chmod(mode)
        temporary.replace(CONFIG_PATH)
    except OSError as exc:
        return f"the webhook could not be saved ({exc})"
    logger.info("alert webhook saved to %s", CONFIG_PATH)
    return None
