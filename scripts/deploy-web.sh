#!/usr/bin/env bash
# Build and deploy the dashboard.
#
# The standalone output is deliberately not self-contained: `next build` writes
# .next/static and public/ next to the server bundle but does not copy them into
# .next/standalone. Without those two copies the server starts happily and serves
# HTML whose every <script> 404s — the page renders, and then nothing on it
# works. That failure looks like a broken UI rather than a broken deploy, so the
# copy is done here rather than left to whoever deploys next.
#
# The environment is not written into the build. STREAMKIT_TOKEN is read by the
# server when it serves a request, so rotating it is an edit of
# /etc/streamtools-web.env and a restart — no rebuild.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/web"
STAGE="$APP/.next/standalone/web"
WEBROOT=/var/www/streamtools

echo "==> building"
cd "$APP"
npm run build

echo "==> copying static and public into the standalone output"
rm -rf "$STAGE/.next/static"
cp -r "$APP/.next/static" "$STAGE/.next/static"
rm -rf "$STAGE/public"
cp -r "$APP/public" "$STAGE/public"

echo "==> staging the overlay pages for nginx"
# Served from disk rather than through Next: OBS loads them as a canvas-sized
# browser source where a framework runtime is dead weight, and they must keep
# working while the dashboard is restarting.
# One URL each, under overlay/, so a customiser or a scene collection points at
# exactly one page. nginx maps the address to the file — see
# snippets/streamtools-overlays.conf.
sudo mkdir -p "$WEBROOT/overlay"
sudo rm -f "$WEBROOT/overlay/"*.html
sudo cp "$APP/public/overlay/"*.html "$WEBROOT/overlay/"
sudo chown -R root:www-data "$WEBROOT"

echo "==> restarting the service"
sudo systemctl restart streamtools-web
sleep 2

# A build that succeeded can still ship a page that cannot hydrate, and that is
# invisible from here. Assert the two things that would catch it, both of which
# changed meaning when the dashboard stopped being a static build behind
# nginx's `auth_basic`:
#
#   - /login must SERVE. It is the one page reachable with no session, so it is
#     the only page whose chunks can be fetched without a cookie.
#   - /admin must NOT serve. A 200 here would mean the gate is off, and the
#     /api/backend/* proxy beside it attaches STREAMKIT_TOKEN to every call it
#     forwards — an ungated dashboard is a confused deputy, not a cosmetic bug.
login=$(curl -s --max-time 10 http://127.0.0.1:5184/login)
chunk=$(printf '%s' "$login" | grep -o '/_next/static/[^"]*\.js' | head -1)
if [ -z "$chunk" ]; then
  echo "FAIL: /login referenced no JS chunks — the page would not hydrate" >&2
  exit 1
fi
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:5184$chunk")
if [ "$code" != "200" ]; then
  echo "FAIL: $chunk answered $code — the page would not hydrate" >&2
  exit 1
fi

status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:5184/admin)
case "$status" in
  30*) : ;; # sent to /login, which is the point
  *)
    echo "FAIL: /admin answered $status without a session — the gate is off" >&2
    exit 1
    ;;
esac

echo "OK: deployed, /login serves and its chunks load ($chunk), /admin is gated ($status)"