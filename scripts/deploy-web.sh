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
# invisible from here. Assert the one thing that would catch it.
status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:5184/admin)
if [ "$status" != "200" ]; then
  echo "FAIL: /admin answered $status" >&2
  exit 1
fi
chunk=$(curl -s --max-time 10 http://127.0.0.1:5184/admin | grep -o '/_next/static/[^"]*\.js' | head -1)
if [ -z "$chunk" ]; then
  echo "FAIL: /admin referenced no JS chunks — the page would not hydrate" >&2
  exit 1
fi
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:5184$chunk")
if [ "$code" != "200" ]; then
  echo "FAIL: $chunk answered $code — the page would not hydrate" >&2
  exit 1
fi

echo "OK: deployed, /admin serves and its chunks load ($chunk)"