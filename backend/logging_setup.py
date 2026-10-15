"""Logging bootstrap for the whole backend.

Configured exactly once at process start here, so `main.py` and any route
module it splits into can all reach the same `logger` without importing each
other. Pulling this out is what lets auth live in its own file instead of
blocking on `main.py`'s module-level setup.
"""
import logging
import os
import sys

#: Module-level logger every backend module uses. Named `streamkit.api` so
#: historical dashboards/grep that key on that name keep working.
logger = logging.getLogger("streamkit.api")

_LEVEL = os.environ.get("STREAMKIT_LOG_LEVEL", "INFO").upper()
if _LEVEL != "NONE":
    try:
        # `pythonjsonlogger.json` is where the formatter lives from 3.1 on. The old
        # `pythonjsonlogger.jsonlogger` path still resolves but warns on every start
        # from 4.0, and this file runs once per process — a warning per boot for a
        # module that has already moved is noise in the journal, not information.
        # `requirements.txt` pins the version this path exists in, so there is no
        # second spelling to fall back to; an install that cannot find it lands in
        # the `except` below and logs plain text.
        from pythonjsonlogger.json import JsonFormatter

        _json_formatter = JsonFormatter(
            "%(asctime)s %(name)s %(levelname)s %(message)s"
        )
    except ImportError:
        _json_formatter = logging.Formatter(
            "%(asctime)s %(name)s %(levelname)s %(message)s",
            datefmt="%H:%M:%S",
        )

    _handler = logging.StreamHandler(sys.stderr)
    _handler.setFormatter(_json_formatter)

    _root_logger = logging.getLogger()
    _root_logger.setLevel(getattr(logging, _LEVEL, logging.INFO))
    _root_logger.addHandler(_handler)

del _LEVEL
del _root_logger
