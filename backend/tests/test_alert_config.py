"""The rules for accepting a webhook URL, and the file it is kept in.

An alert destination is a credential the operator types into a form, so the failure
modes worth pinning here are the ones a form produces: a webhook that points
nowhere, one aimed at the backend's own network, and a save that leaves a
half-written file.

Run with: .venv/bin/python tests/test_alert_config.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import alert_config  # noqa: E402

FAILS: list[str] = []
COUNT = 0


def check(name: str, ok: bool, extra: object = "") -> bool:
    global COUNT
    COUNT += 1
    if not ok:
        FAILS.append(name)
        print(f"  FAIL {name}" + (f" — {extra}" if extra != "" else ""))
    return ok


# Redirect the config to a temp path so nothing here can touch the real one.
REAL_PATH = alert_config.CONFIG_PATH
WORK = Path(__file__).resolve().parent / ".test-alerts.env"
alert_config.CONFIG_PATH = WORK


def reset() -> None:
    try:
        WORK.unlink()
    except FileNotFoundError:
        pass
    # And the environment, so a stray variable cannot leak between cases.
    os.environ.pop(alert_config._ENV, None)


print("\nan empty config is off, not an error")
reset()
check("nothing is configured", alert_config.read() == "")
check("and alerts are off", not alert_config.enabled())
check("and describe says so", alert_config.describe() == "off")

print("\nthe environment alone is enough")
reset()
os.environ[alert_config._ENV] = "https://example.com/hook"
check("it is read", alert_config.read() == "https://example.com/hook")
check("and alerts are on", alert_config.enabled())

print("\nthe file wins over the environment")
reset()
WORK.write_text(f"{alert_config._ENV}=https://file.example.com/hook\n", encoding="utf-8")
os.environ[alert_config._ENV] = "https://env.example.com/hook"
check("the file is used", alert_config.read() == "https://file.example.com/hook")
reset()

print("\nan unreadable file means off, not a crash")
reset()
WORK.mkdir()  # A directory cannot be read as a file.
check("reading it gives empty", alert_config.read() == "")
check("and alerts are off", not alert_config.enabled())
WORK.rmdir()
reset()

print("\nrejecting what must not be stored")
# A webhook the server will POST to on every failure is also a request the server
# makes to wherever it points, so http is not accepted: the URL travels in the
# failure path, which is exactly when it is least convenient to have it intercepted.
check("http is refused", alert_config.validate("http://example.com/hook") is not None)
check("an empty URL is refused", alert_config.validate("") is not None)
check("a URL with no host is refused", alert_config.validate("https://") is not None)
check("a private address is refused", alert_config.validate("https://127.0.0.1/hook") is not None)
check("localhost is refused", alert_config.validate("https://localhost/hook") is not None)
check("and a link-local address is refused", alert_config.validate("https://169.254.169.254/latest/meta-data") is not None)
check("a host that does not resolve is refused", alert_config.validate("https://no-such-host.invalid/hook") is not None)
check("a public https URL is accepted", alert_config.validate("https://discord.com/api/webhooks/123/abc") is None)

print("\nsaving is validated and atomic")
reset()
problem = alert_config.set("http://example.com/hook")
check("a refused URL is not saved", problem is not None, problem)
check("and nothing was written", not WORK.exists())
problem = alert_config.set("https://example.com/hook")
check("a good URL saves without complaint", problem is None, problem)
check("and the file exists", WORK.exists())
check("and it holds the URL", alert_config.read() == "https://example.com/hook")
check("and it is not world-readable", (WORK.stat().st_mode & 0o077) == 0, oct(WORK.stat().st_mode & 0o777))
check("and no temp file is left behind", not WORK.with_suffix(".tmp").exists())
reset()

print("\n saving over an existing file keeps its permissions")
WORK.write_text(f"{alert_config._ENV}=https://old.example.com/hook\n", encoding="utf-8")
WORK.chmod(0o640)
alert_config.set("https://new.example.com/hook")
check("the new URL is saved", alert_config.read() == "https://new.example.com/hook")
check("and the mode is preserved", (WORK.stat().st_mode & 0o777) == 0o640, oct(WORK.stat().st_mode & 0o777))
reset()

print("\nempty clears")
alert_config.set("https://example.com/hook")
alert_config.set("")
check("the file is removed", not WORK.exists())
check("and alerts are off", not alert_config.enabled())
reset()

print()
alert_config.CONFIG_PATH = REAL_PATH
if FAILS:
    print(f"{len(FAILS)} failed of {COUNT}")
    for f in FAILS:
        print("  - " + f)
    raise SystemExit(1)
print(f"all passed ({COUNT} assertions)")
