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
        from pythonjsonlogger import jsonlogger

        _json_formatter = jsonlogger.JsonFormatter(
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
