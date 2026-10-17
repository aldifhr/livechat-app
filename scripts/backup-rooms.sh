#!/bin/sh
# Back up the room store and published giveaway snapshots.
#
# The store lives at /var/lib/streamkit/rooms.json and holds every room's handle
# and overlay config — the overlay links on streamers' OBS sources point at room
# ids that exist only there. Published giveaway links also point at snapshots in
# this directory; without them, a wiped disk would leave those public links dead.
#
# Kept simple on purpose: a dated copy, a symlink to the newest, and pruning by
# age. No incremental format to get wrong at 3am.
set -eu

STORE_DIR=/var/lib/streamkit
BACKUP_DIR=/var/lib/streamkit/backups
KEEP_DAYS=14

mkdir -p "$BACKUP_DIR"

if [ ! -f "$STORE_DIR/rooms.json" ] && [ ! -f "$STORE_DIR/giveaways.json" ]; then
    echo "no room or giveaway data to back up" >&2
    exit 0
fi

stamp=$(date +%Y%m%d-%H%M%S)
if [ -f "$STORE_DIR/rooms.json" ]; then
    cp -a "$STORE_DIR/rooms.json" "$BACKUP_DIR/rooms-$stamp.json"
    ln -sfn "rooms-$stamp.json" "$BACKUP_DIR/rooms-latest.json"
fi
if [ -f "$STORE_DIR/giveaways.json" ]; then
    cp -a "$STORE_DIR/giveaways.json" "$BACKUP_DIR/giveaways-$stamp.json"
    ln -sfn "giveaways-$stamp.json" "$BACKUP_DIR/giveaways-latest.json"
fi

# Prune by age. A store that has not changed still gets a fresh copy, which is
# fine — the point is to survive "yesterday it was right".
find "$BACKUP_DIR" -name 'rooms-*.json' -type f -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'giveaways-*.json' -type f -mtime "+$KEEP_DAYS" -delete

echo "backed up room and giveaway data -> $BACKUP_DIR/*-$stamp.json"
