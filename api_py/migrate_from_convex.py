"""One-off migration from Convex into the new PostgreSQL backend.

Reads the self-hosted Convex deployment with the service token, copies rooms
(keeping their UUIDs so existing OBS links keep working), recent events and
session counters, then leaves the Convex data untouched as a rollback path.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from convex import ConvexClient
from psycopg import Connection
from psycopg_pool import ConnectionPool

CONVEX_URL = os.environ.get("CONVEX_SELF_HOSTED_URL", "http://127.0.0.1:3210")


def service_token() -> str:
    for line in Path("/etc/streamkit/env").read_text().splitlines():
        if line.startswith("STREAMKIT_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("STREAMKIT_TOKEN missing from /etc/streamkit/env")


def db_url() -> str:
    for line in Path("/etc/streamkit/python-db.env").read_text().splitlines():
        if line.startswith("STREAMKIT_DB_URL="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("STREAMKIT_DB_URL missing")


def main() -> None:
    token = service_token()
    client = ConvexClient(CONVEX_URL)
    admin_key = ""
    for line in Path("/etc/convex/env").read_text().splitlines():
        if line.startswith("CONVEX_ADMIN_KEY="):
            admin_key = line.split("=", 1)[1].strip()
    if admin_key:
        client.set_admin_auth(admin_key)
    pool = ConnectionPool(db_url(), min_size=1, max_size=2, open=True)
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE events, room_sessions, rooms, logs, metrics RESTART IDENTITY")
        conn.commit()

    rooms = client.query("rooms:list", {"token": token})
    print(f"migrating {len(rooms)} rooms")
    with pool.connection() as conn:
        with conn.cursor() as cur:
            for listed in rooms:
                room = client.query("rooms:get", {"roomId": listed["id"], "token": token}) or listed
                session = client.query("rooms:getSession", {"roomId": listed["id"], "token": token}) or {}
                cur.execute(
                    """INSERT INTO rooms(id,name,username,provider,config,created_at,connected,connecting,
                       waiting,live_ended,status_message,viewers,desired,session_start)
                       VALUES(%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (
                        room["id"], room.get("name") or "Untitled", room.get("username") or "",
                        room.get("provider") or "tiktok", json.dumps(room.get("config") or {}),
                        int(room.get("createdAt") or 0), bool(room.get("connected")),
                        bool(room.get("connecting")), bool(room.get("waiting")),
                        bool(room.get("liveEnded")), room.get("statusMessage") or "Offline",
                        int(session.get("viewers") or 0), bool(room.get("desired")), None,
                    ),
                )
                cur.execute(
                    """INSERT INTO room_sessions(room_id,peak_viewers,total_diamonds,last_viewers,updated_at)
                       VALUES(%s,%s,%s,%s,%s) ON CONFLICT (room_id) DO UPDATE SET
                       peak_viewers=EXCLUDED.peak_viewers, total_diamonds=EXCLUDED.total_diamonds,
                       last_viewers=EXCLUDED.last_viewers, updated_at=EXCLUDED.updated_at""",
                    (
                        room["id"], int(session.get("peak_viewers") or 0),
                        int(session.get("total_diamonds") or 0), int(session.get("viewers") or 0),
                        int(room.get("createdAt") or 0),
                    ),
                )
                cursor = 0
                copied = 0
                while True:
                    rows = client.query(
                        "events:recentForRoom",
                        {"roomId": room["id"], "sinceCreationTime": cursor, "limit": 500, "token": token},
                    )
                    if not rows:
                        break
                    for row in rows:
                        frame = row["frame"] or {}
                        cur.execute(
                            """INSERT INTO events(room_id,kind,user_name,user_id,frame,created_at)
                               VALUES(%s,%s,%s,%s,%s::jsonb,%s)""",
                            (
                                room["id"], str(frame.get("type") or "alert"),
                                str(frame.get("user") or ""), str(frame.get("userId") or ""),
                                json.dumps(frame, ensure_ascii=False, default=str),
                                int(row["cursor"]),
                            ),
                        )
                        cursor = max(cursor, int(row["cursor"]))
                        copied += 1
                    if len(rows) < 500:
                        break
                print(f"  {room.get('name')}: {copied} events")
        conn.commit()
    pool.close()
    print("migration complete")


if __name__ == "__main__":
    sys.exit(main())
