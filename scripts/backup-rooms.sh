#!/bin/sh
# Back up all StreamKit state from Convex (rooms, events, sessions, giveaways).
#
# State no longer lives in JSON files: it is in the self-hosted Convex SQLite
# database at /var/lib/convex. Exporting via the Convex CLI gives a restorable
# ZIP per table set. Kept dated + latest symlink + age pruning, like before.
set -eu

BACKUP_DIR=/var/lib/convex/backups
KEEP_DAYS=14

mkdir -p "$BACKUP_DIR"
stamp=$(date +%Y%m%d-%H%M%S)
cd /root/livechat-app/web
set -a
. /etc/convex/env
set +a
export CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 CONVEX_SELF_HOSTED_ADMIN_KEY="$CONVEX_ADMIN_KEY" CONVEX_URL=http://127.0.0.1:3210
npx convex export --path "$BACKUP_DIR/convex-$stamp.zip" >/dev/null
ln -sfn "convex-$stamp.zip" "$BACKUP_DIR/convex-latest.zip"
find "$BACKUP_DIR" -name 'convex-*.zip' -mtime +"$KEEP_DAYS" -delete
echo "backed up to $BACKUP_DIR/convex-$stamp.zip"
