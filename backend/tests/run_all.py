"""Run every backend test in this directory, and fail if one is not run.

Four of these lived in `apps/api/` rather than `tests/`, so a `tests/test_*.py`
glob reported a clean suite while never executing them — which is how a green run
came to mean nothing at all. Anything matching `test_*.py` here runs, and the
count is checked against the files on disk so the next stray test cannot hide.
"""

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
TESTS = sorted(p for p in HERE.glob("test_*.py") if p.name != "run_all.py")

if not TESTS:
    print("no tests found", file=sys.stderr)
    raise SystemExit(1)

failed: list[str] = []
for path in TESTS:
    result = subprocess.run(
        [sys.executable, "-u", str(path)],
        capture_output=True,
        text=True,
        cwd=str(HERE.parent),
    )
    last = [ln for ln in result.stdout.strip().splitlines() if ln.strip()]
    summary = last[-1] if last else "(no output)"
    if result.returncode == 0:
        print(f"  ok    {path.name:<34} {summary}")
    else:
        failed.append(path.name)
        print(f"  FAIL  {path.name:<34} {summary}")
        for line in result.stdout.splitlines():
            if line.strip().startswith("FAIL") or line.strip().startswith("-"):
                print(f"        {line.strip()}")

print()
print(f"{len(TESTS) - len(failed)}/{len(TESTS)} suites passed")
if failed:
    print("failed: " + ", ".join(failed))
    raise SystemExit(1)
