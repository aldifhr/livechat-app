"""
StreamKit Python backend: PostgreSQL state, TikTok watcher and overlay WebSocket fan-out.

It intentionally speaks the old RPC path names (`rooms:list`, `events:recentForRoom`, ...)
through POST /rpc so the Next.js gateway does not need a parallel implementation
of every route. The Node bridge and Convex deployment are being retired; this
process is the single source of truth.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import time
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from TikTokLive import TikTokLiveClient
from TikTokLive.events import (
    CommentEvent,
    ConnectEvent,
    DisconnectEvent,
    FollowEvent,
    GiftEvent,
    JoinEvent,
    LikeEvent,
    LiveEndEvent,
)

log = logging.getLogger("streamkit")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

DATABASE_URL = os.environ.get("STREAMKIT_DB_URL", "postgresql://streamkit@localhost/streamkit")
API_TOKEN = os.environ.get("STREAMKIT_TOKEN", "").strip()
PORT = int(os.environ.get("STREAMKIT_PY_PORT", "8004"))

pool: ConnectionPool | None = None


# --------------------------------------------------------------------------- DB
def db() -> ConnectionPool:
    assert pool is not None
    return pool


def one(query: str, params: tuple = ()) -> dict | None:
    with db().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            row = cur.fetchone()
            return dict(row) if row else None


def all_rows(query: str, params: tuple = ()) -> list[dict]:
    with db().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            return [dict(r) for r in cur.fetchall()]


def run(query: str, params: tuple = ()) -> None:
    with db().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)


SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Untitled',
  username TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'tiktok',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL,
  connected BOOLEAN NOT NULL DEFAULT FALSE,
  connecting BOOLEAN NOT NULL DEFAULT FALSE,
  waiting BOOLEAN NOT NULL DEFAULT FALSE,
  live_ended BOOLEAN NOT NULL DEFAULT FALSE,
  status_message TEXT NOT NULL DEFAULT 'Offline',
  viewers INTEGER NOT NULL DEFAULT 0,
  desired BOOLEAN NOT NULL DEFAULT FALSE,
  session_start BIGINT
);
CREATE INDEX IF NOT EXISTS rooms_username ON rooms(username);
CREATE INDEX IF NOT EXISTS rooms_created ON rooms(created_at);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  frame JSONB NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_room_id ON events(room_id, id);
CREATE INDEX IF NOT EXISTS events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS room_sessions (
  room_id TEXT PRIMARY KEY,
  peak_viewers INTEGER NOT NULL DEFAULT 0,
  total_diamonds INTEGER NOT NULL DEFAULT 0,
  last_viewers INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id BIGSERIAL PRIMARY KEY,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_created ON logs(created_at);

CREATE TABLE IF NOT EXISTS metrics (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  created_at BIGINT NOT NULL
);
"""


def init_db() -> None:
    with db().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(SCHEMA)
        conn.commit()


def now_ms() -> int:
    return int(time.time() * 1000)


# ----------------------------------------------------------------------- shapes
def room_dict(r: dict) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "username": r["username"] or "",
        "provider": r["provider"] or "tiktok",
        "config": r["config"] or {},
        "createdAt": r["created_at"],
        "connected": bool(r["connected"]),
        "connecting": bool(r["connecting"]),
        "waiting": bool(r["waiting"]),
        "liveEnded": bool(r["live_ended"]),
        "statusMessage": r["status_message"] or "Offline",
        "viewers": r["viewers"] or 0,
        "desired": bool(r["desired"]),
    }


def get_room(room_id: str) -> dict | None:
    row = one("SELECT * FROM rooms WHERE id=%s", (room_id,))
    return room_dict(row) if row else None


def get_room_by_username(username: str) -> dict | None:
    row = one("SELECT * FROM rooms WHERE lower(username)=lower(%s) ORDER BY created_at LIMIT 1", (username,))
    return room_dict(row) if row else None


STATUS_KEYS = {
    "overlaySize": "size",
    "overlayNameColour": "nameColour",
    "overlayTextColour": "textColour",
    "overlayBg": "background",
    "overlayMax": "max",
    "overlayDelay": "delay",
    "overlayFont": "font",
    "overlayPosition": "position",
    "overlayMaxWidth": "maxWidth",
    "overlayBubbleOpacity": "bubbleOpacity",
    "overlayGiftColour": "giftColour",
    "overlayTitle": "title",
    "overlayTitleColour": "titleColour",
    "catPalette": "pal",
    "catChonk": "chonk",
    "likeTarget": "likeTarget",
    "likeTitle": "likeTitle",
    "likeSize": "likeSize",
    "likeBarColour": "likeBarColour",
    "likeTextColour": "likeTextColour",
    "likePosition": "likePosition",
}


def page_config(config: dict | None) -> dict:
    return {page: config[key] for key, page in STATUS_KEYS.items() if config and key in config}


def status_frame(room: dict) -> dict:
    frame: dict[str, Any] = {
        "type": "status",
        "connected": bool(room.get("connected")),
        "message": room.get("statusMessage") or ("Connected" if room.get("connected") else "Offline"),
    }
    for flag in ("connecting", "waiting", "liveEnded"):
        if room.get(flag):
            frame[flag] = True
    return frame


# ------------------------------------------------------------------ websockets
clients: dict[str, set[WebSocket]] = defaultdict(set)
watchers: dict[str, "Watcher"] = {}


async def broadcast(room_id: str, frame: dict) -> None:
    payload = json.dumps(frame, ensure_ascii=False, default=str)
    dead = []
    for ws in list(clients.get(room_id, ())):
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients[room_id].discard(ws)


async def persist_and_broadcast(room_id: str, kind: str, frame: dict, user: dict | None = None) -> int:
    user = user or {}
    created = now_ms()
    with db().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO events(room_id,kind,user_name,user_id,frame,created_at) VALUES(%s,%s,%s,%s,%s::jsonb,%s) RETURNING id AS event_id",
                (room_id, kind, user.get("user", ""), user.get("userId", ""), json.dumps(frame, ensure_ascii=False, default=str), created),
            )
            event_id = int(cur.fetchone()["event_id"])
            cur.execute(
                """INSERT INTO room_sessions(room_id,peak_viewers,total_diamonds,last_viewers,updated_at)
                   VALUES(%s,0,0,0,%s) ON CONFLICT (room_id) DO NOTHING""",
                (room_id, created),
            )
            if kind == "viewers" and isinstance(frame.get("count"), (int, float)):
                cur.execute(
                    """UPDATE room_sessions SET last_viewers=%s,
                       peak_viewers=GREATEST(peak_viewers,%s), updated_at=%s WHERE room_id=%s""",
                    (int(frame["count"]), int(frame["count"]), created, room_id),
                )
            if kind == "gift" and isinstance(frame.get("diamonds"), (int, float)):
                cur.execute(
                    "UPDATE room_sessions SET total_diamonds=total_diamonds+%s, updated_at=%s WHERE room_id=%s",
                    (int(frame["diamonds"]), created, room_id),
                )
            conn.commit()
    await broadcast(room_id, frame)
    return event_id


def set_room_status(room_id: str, **fields: Any) -> None:
    columns = {
        "connected": "connected",
        "connecting": "connecting",
        "waiting": "waiting",
        "live_ended": "live_ended",
        "viewers": "viewers",
        "desired": "desired",
        "session_start": "session_start",
    }
    values: dict[str, Any] = {}
    for key, value in fields.items():
        if key == "message":
            values["status_message"] = value
        elif key in columns:
            values[columns[key]] = value
    if not values:
        return
    assignments = ", ".join(f"{k}=%s" for k in values)
    with db().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE rooms SET {assignments} WHERE id=%s", (*values.values(), room_id))
            conn.commit()
    room = get_room(room_id)
    if room:
        asyncio.get_running_loop().create_task(broadcast(room_id, status_frame(room)))


def write_log(level: str, source: str, message: str) -> None:
    run("INSERT INTO logs(level,source,message,created_at) VALUES(%s,%s,%s,%s)", (level, source, str(message)[:500], now_ms()))


# ---------------------------------------------------------------------- watcher
def user_info(user: Any) -> dict:
    if not user:
        return {}
    nickname = str(getattr(user, "nickname", "") or "").strip()
    uid = str(getattr(user, "unique_id", "") or getattr(user, "id", "") or "").strip()
    avatar = ""
    for attr in ("avatar_thumb", "avatar_medium", "avatar_large", "avatar"):
        model = getattr(user, attr, None)
        urls = getattr(model, "url_list", None) if model else None
        if urls:
            avatar = str(urls[0])
            break
    return {"user": nickname or uid, "userId": uid or nickname, "avatar": avatar}


class Watcher:
    """One TikTokLive client per room, with exponential reconnect while desired."""

    def __init__(self, room_id: str, username: str):
        self.room_id = room_id
        self.username = username
        self.client = TikTokLiveClient(unique_id=username.lstrip("@"))
        self.running = True
        self.attempts = 0
        self.task: asyncio.Task | None = None
        self._wire()

    def _wire(self) -> None:
        client = self.client

        @client.on(ConnectEvent)
        async def on_connect(_event: Any) -> None:
            self.attempts = 0
            log.info("@%s connected", self.username)
            set_room_status(
                self.room_id, connected=True, connecting=False, waiting=False,
                live_ended=False, session_start=now_ms(),
                message=f"Connected to @{self.username}",
            )
            await self._emit_intro()

        @client.on(DisconnectEvent)
        async def on_disconnect(_event: Any) -> None:
            log.warning("@%s disconnected", self.username)
            set_room_status(
                self.room_id, connected=False, connecting=self.running,
                live_ended=False, message=f"Disconnected from @{self.username}",
            )
            if self.running:
                self.schedule_reconnect("socket dropped")

        @client.on(LiveEndEvent)
        async def on_end(_event: Any) -> None:
            log.info("@%s stream ended", self.username)
            self.running = False
            set_room_status(
                self.room_id, connected=False, connecting=False, live_ended=True,
                desired=False, message=f"@{self.username} is no longer live",
            )
            watchers.pop(self.room_id, None)

        @client.on(CommentEvent)
        async def on_comment(event: Any) -> None:
            info = user_info(getattr(event, "user", None))
            if not info["user"]:
                return
            text = str(getattr(event, "content", "") or "")
            await persist_and_broadcast(self.room_id, "comment", {
                "type": "comment", **info, "text": text,
            }, info)

        @client.on(GiftEvent)
        async def on_gift(event: Any) -> None:
            info = user_info(getattr(event, "user", None))
            gift = getattr(event, "gift", None)
            if not info["user"] or not gift:
                return
            name = str(getattr(gift, "name", "") or "Gift")
            diamonds = int(getattr(gift, "diamond_count", 0) or 0)
            count = int(getattr(event, "combo_count", 1) or 1)
            await persist_and_broadcast(self.room_id, "gift", {
                "type": "gift", **info, "giftName": name,
                "giftId": int(getattr(gift, "id", 0) or 0),
                "count": count, "diamonds": diamonds * count,
            }, info)

        @client.on(JoinEvent)
        async def on_join(event: Any) -> None:
            info = user_info(getattr(event, "user", None))
            if info["user"]:
                await persist_and_broadcast(self.room_id, "join", {"type": "join", **info}, info)

        @client.on(LikeEvent)
        async def on_like(event: Any) -> None:
            info = user_info(getattr(event, "user", None))
            if info["user"]:
                await persist_and_broadcast(self.room_id, "like", {
                    "type": "like", **info,
                    "count": int(getattr(event, "like_count", 1) or 1),
                }, info)

        @client.on(FollowEvent)
        async def on_follow(event: Any) -> None:
            await persist_and_broadcast(self.room_id, "follow", {"type": "follow"})

    async def _emit_intro(self) -> None:
        info = {"user": self.username, "userId": self.username, "avatar": ""}
        await persist_and_broadcast(self.room_id, "intro", {
            "type": "intro", **info, "title": f"@{self.username} went live",
        }, info)

    def schedule_reconnect(self, reason: str) -> None:
        if not self.running or (self.task and not self.task.done()):
            return
        self.attempts += 1
        delay = min(5 * self.attempts, 60)
        log.warning("@%s reconnect in %ss (%s)", self.username, delay, reason)
        self.task = asyncio.create_task(self._reconnect(delay))

    async def _reconnect(self, delay: float) -> None:
        await asyncio.sleep(delay)
        if not self.running:
            return
        set_room_status(self.room_id, connected=False, connecting=True, message=f"Reconnecting to @{self.username}…")
        try:
            await self.client.connect()
        except Exception as exc:
            log.warning("@%s reconnect failed: %s", self.username, exc)
            offline = any(word in str(exc).lower() for word in ("offline", "not live", "no live"))
            set_room_status(
                self.room_id, connected=False, connecting=True, waiting=offline,
                message=f"@{self.username} is not live yet" if offline else f"Could not connect to @{self.username}",
            )
            self.schedule_reconnect("still offline")

    async def start(self) -> None:
        set_room_status(self.room_id, connected=False, connecting=True, waiting=False,
                        live_ended=False, message=f"Connecting to @{self.username}")
        try:
            await self.client.connect()
        except Exception as exc:
            log.warning("@%s initial connect failed: %s", self.username, exc)
            offline = any(word in str(exc).lower() for word in ("offline", "not live", "no live"))
            set_room_status(
                self.room_id, connected=False, connecting=True, waiting=offline,
                message=f"@{self.username} is not live yet" if offline else f"Could not connect to @{self.username}",
            )
            self.schedule_reconnect("initial connect failed")

    async def stop(self) -> None:
        self.running = False
        if self.task:
            self.task.cancel()
        try:
            await self.client.disconnect()
        except Exception:
            pass


# ------------------------------------------------------------------- lifecycle
@asynccontextmanager
async def lifespan(_app: FastAPI):
    global pool
    pool = ConnectionPool(DATABASE_URL, min_size=1, max_size=10, open=True,
                          kwargs={"row_factory": dict_row})
    init_db()
    prune_old_events()
    for room in all_rows("SELECT * FROM rooms WHERE desired=TRUE AND username<>''"):
        log.info("restoring @%s after restart", room["username"])
        watchers[room["id"]] = Watcher(room["id"], room["username"])
        asyncio.create_task(watchers[room["id"]].start())
    yield
    for watcher in list(watchers.values()):
        await watcher.stop()
    pool.close()


app = FastAPI(title="StreamKit Python backend", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def authorized(request: Request, args: dict | None = None) -> bool:
    supplied = request.headers.get("x-streamkit-token", "")
    if not supplied and args:
        supplied = str(args.get("token", "") or "")
    return bool(API_TOKEN) and hmac.compare_digest(supplied, API_TOKEN)


# ----------------------------------------------------------------------- events
def session_for(room_id: str) -> dict:
    room = get_room(room_id) or {}
    session = one("SELECT * FROM room_sessions WHERE room_id=%s", (room_id,)) or {}
    rows = all_rows(
        "SELECT kind, count(*) AS n FROM events WHERE room_id=%s GROUP BY kind", (room_id,)
    )
    totals = {r["kind"]: int(r["n"]) for r in rows}
    start = room.get("session_start") or session.get("updated_at") or now_ms()
    return {
        "connected": bool(room.get("connected")),
        "live_seconds": max(0, (now_ms() - int(start)) // 1000) if room.get("connected") else 0,
        "peak_viewers": int(session.get("peak_viewers") or 0),
        "peak_viewers_age": None,
        "repeats": {},
        "topGifters": [],
        "total_diamonds": int(session.get("total_diamonds") or 0),
        "totals": totals,
        "viewers": int(session.get("last_viewers") or room.get("viewers") or 0),
        "viewers_age": None,
    }


def top_chatters(room_id: str, limit: int = 10) -> list[dict]:
    rows = all_rows(
        """SELECT user_name AS name, count(*) AS messages FROM events
           WHERE room_id=%s AND kind='comment' AND user_name<>''
           GROUP BY user_name ORDER BY messages DESC LIMIT %s""",
        (room_id, max(1, min(limit, 50))),
    )
    return [{"name": r["name"], "messages": int(r["messages"])} for r in rows]


def prune_old_events(hours: int = 48) -> int:
    cutoff = now_ms() - hours * 3600_000
    with db().connection() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM events WHERE created_at < %s", (cutoff,))
            deleted = cur.rowcount
            conn.commit()
    return deleted


FRAME_BUILDERS = {
    "alert": lambda a: {"type": "alert", "text": a.get("text") or "Alert"},
    "notice": lambda a: {"type": "notice", "text": a.get("text") or ""},
    "intro": lambda a: {"type": "intro", "title": a.get("title") or ""},
    "comment": lambda a: {"type": "comment", "user": a.get("user") or "", "text": a.get("text") or ""},
    "like": lambda a: {"type": "like", "user": a.get("user") or "", "count": int(a.get("count") or 1)},
    "gift": lambda a: {"type": "gift", "user": a.get("user") or "", "giftName": a.get("title") or "Gift",
                       "count": int(a.get("count") or 1), "diamonds": int(a.get("diamonds") or 0)},
    "viewers": lambda a: {"type": "viewers", "count": int(a.get("count") or 0)},
}


def trigger_frame(args: dict) -> dict:
    kind = str(args.get("kind") or "alert")
    builder = FRAME_BUILDERS.get(kind, FRAME_BUILDERS["alert"])
    return builder(args)


# ------------------------------------------------------------------------- RPC
def rpc(name: str, args: dict, request: Request) -> Any:
    public = {"rooms:publicList", "events:health", "rooms:create"}
    if name not in public and not authorized(request, args):
        raise HTTPException(401, "Invalid or missing token")

    if name == "rooms:list":
        return [room_dict(r) for r in all_rows("SELECT * FROM rooms ORDER BY created_at")]
    if name == "rooms:publicList":
        return [
            {"id": r["id"], "username": r["username"] or "", "name": r["name"],
             "connected": bool(r["connected"]), "provider": r["provider"] or "tiktok"}
            for r in all_rows("SELECT * FROM rooms ORDER BY created_at")
        ]
    if name in ("rooms:get", "rooms:getByExternal"):
        key = "id" if name == "rooms:get" else "externalId"
        return get_room(str(args.get(key, ""))) or {"notFound": True}
    if name == "rooms:create":
        room_id = str(uuid.uuid4())
        run(
            "INSERT INTO rooms(id,name,username,provider,config,created_at) VALUES(%s,%s,%s,%s,%s::jsonb,%s)",
            (room_id, str(args.get("name") or "Untitled"), str(args.get("username") or ""),
             str(args.get("provider") or "tiktok"), json.dumps(args.get("config") or {}), now_ms()),
        )
        return {"id": room_id}
    if name == "rooms:update":
        fields = {k: args[k] for k in ("name", "username", "provider") if k in args}
        if fields:
            assignments = ", ".join(f"{k}=%s" for k in fields)
            run(f"UPDATE rooms SET {assignments} WHERE id=%s", (*fields.values(), args.get("roomId")))
        return {"ok": True}
    if name == "rooms:updateConfig":
        run("UPDATE rooms SET config=%s::jsonb WHERE id=%s",
            (json.dumps(args.get("config") or {}), args.get("roomId")))
        room = get_room(str(args.get("roomId")))
        if room:
            asyncio.get_running_loop().create_task(broadcast(room["id"], {
                "type": "config", "config": page_config(room["config"]),
            }))
        return {"ok": True}
    if name == "rooms:deleteRoom":
        room_id = str(args.get("roomId"))
        watcher = watchers.pop(room_id, None)
        if watcher:
            asyncio.get_running_loop().create_task(watcher.stop())
        for table in ("events", "room_sessions"):
            run(f"DELETE FROM {table} WHERE room_id=%s", (room_id,))
        run("DELETE FROM rooms WHERE id=%s", (room_id,))
        return {"ok": True}
    if name == "rooms:findOrCreateByUsername":
        username = str(args.get("username") or "").lstrip("@")
        room = get_room_by_username(username)
        if not room:
            room_id = str(uuid.uuid4())
            run(
                "INSERT INTO rooms(id,name,username,provider,config,created_at) VALUES(%s,%s,%s,%s,%s::jsonb,%s)",
                (room_id, username, username, str(args.get("provider") or "tiktok"),
                 json.dumps(args.get("config") or {}), now_ms()),
            )
            room = get_room(room_id)
        return {"id": room["id"], "created": True}
    if name == "rooms:setStatus":
        set_room_status(str(args.get("roomId")), **{k: v for k, v in args.items() if k != "roomId" and k != "token"})
        return {"ok": True}
    if name == "rooms:setDesired":
        run("UPDATE rooms SET desired=%s WHERE id=%s", (bool(args.get("desired")), args.get("roomId")))
        return {"ok": True}
    if name == "rooms:getSession":
        return session_for(str(args.get("roomId")))
    if name == "rooms:analytics":
        rooms = [room_dict(r) for r in all_rows("SELECT * FROM rooms ORDER BY created_at")]
        return {"rooms": [{"id": r["id"], "name": r["name"], "connected": r["connected"],
                           "viewers": r["viewers"], "session": session_for(r["id"])} for r in rooms]}
    if name == "events:health":
        with_rooms = bool(args.get("withRooms"))
        payload: dict[str, Any] = {"status": "ok", "activeRooms": len(watchers),
                                   "websocketConnections": sum(len(v) for v in clients.values())}
        if with_rooms:
            payload["rooms"] = [room_dict(r) for r in all_rows("SELECT * FROM rooms ORDER BY created_at")]
        return payload
    if name == "events:metricsSummary":
        return {"rooms": len(all_rows("SELECT id FROM rooms")), "events": len(all_rows("SELECT id FROM events")),
                "logs": len(all_rows("SELECT id FROM logs"))}
    if name == "events:listLogs":
        limit = max(1, min(int(args.get("limit") or 200), 500))
        rows = all_rows("SELECT * FROM logs ORDER BY created_at DESC LIMIT %s", (limit,))
        if args.get("level"):
            rows = [r for r in rows if r["level"] == args["level"]]
        if args.get("q"):
            needle = str(args["q"]).lower()
            rows = [r for r in rows if needle in (r["message"] + r["source"]).lower()]
        return {"capacity": 500, "total": len(rows), "entries": [
            {"level": r["level"], "source": r["source"], "message": r["message"],
             "createdAt": r["created_at"]} for r in rows
        ]}
    if name == "events:appendLog":
        write_log(str(args.get("level") or "info"), str(args.get("source") or "backend"),
                  str(args.get("message") or ""))
        return {"ok": True}
    if name == "events:appendEvent":
        async_task = asyncio.get_running_loop().create_task(
            persist_and_broadcast(str(args.get("roomId")), str(args.get("kind") or "alert"),
                                  args.get("frame") or trigger_frame(args))
        )
        async_task.add_done_callback(lambda t: t.exception() and log.error("appendEvent failed: %s", t.exception()))
        return {"ok": True}
    if name == "events:trigger":
        frame = trigger_frame(args)
        user = {"user": str(args.get("user") or ""), "userId": str(args.get("userId") or "")}
        async_task = asyncio.get_running_loop().create_task(
            persist_and_broadcast(str(args.get("roomId")), str(args.get("kind") or "alert"), frame, user)
        )
        async_task.add_done_callback(lambda t: t.exception() and log.error("trigger failed: %s", t.exception()))
        return {"ok": True}
    if name == "events:latestCursor":
        row = one("SELECT id FROM events WHERE room_id=%s ORDER BY id DESC LIMIT 1", (args.get("roomId"),))
        return int(row["id"]) if row else 0
    if name == "events:recentForRoom":
        cursor = int(args.get("sinceCreationTime") or 0)
        limit = max(1, min(int(args.get("limit") or 100), 500))
        rows = all_rows("SELECT id, frame FROM events WHERE room_id=%s AND id>%s ORDER BY id LIMIT %s",
                        (args.get("roomId"), cursor, limit))
        return [{"frame": r["frame"], "cursor": r["id"]} for r in rows]
    if name == "events:topChatters":
        return top_chatters(str(args.get("roomId")), int(args.get("limit") or 10))
    if name == "cleanup:pruneOldEvents":
        return {"deleted": prune_old_events(int(args.get("olderThanHours") or 48))}
    raise HTTPException(404, f"unknown rpc {name}")


@app.post("/rpc")
async def rpc_endpoint(request: Request) -> Any:
    body = await request.json()
    name = str(body.get("path") or "")
    args = body.get("args") or {}
    return rpc(name, args, request)


# ------------------------------------------------------------- control endpoints
@app.get("/health")
def health() -> dict:
    return {"status": "ok", "activeRooms": len(watchers),
            "websocketConnections": sum(len(v) for v in clients.values())}


async def connect_room(room_id: str, username: str) -> dict:
    username = username.strip().lstrip("@")
    existing = watchers.get(room_id)
    if existing and existing.running and existing.username == username:
        return {"room_id": room_id, "status": "already-connected", "username": username, "connected": True}
    if existing:
        await existing.stop()
        watchers.pop(room_id, None)
    run("UPDATE rooms SET username=%s, desired=TRUE WHERE id=%s", (username, room_id))
    watcher = Watcher(room_id, username)
    watchers[room_id] = watcher
    asyncio.create_task(watcher.start())
    return {"room_id": room_id, "status": "connecting", "username": username, "provider": "tiktok"}


async def disconnect_room(room_id: str) -> dict:
    run("UPDATE rooms SET desired=FALSE WHERE id=%s", (room_id,))
    watcher = watchers.pop(room_id, None)
    if watcher:
        await watcher.stop()
    set_room_status(room_id, connected=False, connecting=False, waiting=False,
                    message="Disconnected")
    return {"status": "disconnected"}


@app.post("/api/room-connect-by-username")
async def connect_by_username(request: Request) -> dict:
    body = await request.json()
    username = str(body.get("username") or "").strip().lstrip("@")
    if not username:
        raise HTTPException(400, "username is required")
    room = get_room_by_username(username)
    if not room:
        room_id = str(uuid.uuid4())
        run("INSERT INTO rooms(id,name,username,provider,config,created_at) VALUES(%s,%s,%s,%s,%s::jsonb,%s)",
            (room_id, username, username, "tiktok", "{}", now_ms()))
    else:
        room_id = room["id"]
    return await connect_room(room_id, username)


@app.post("/api/room-connect/{room_id}")
async def connect_existing(room_id: str, request: Request) -> dict:
    if not authorized(request):
        raise HTTPException(401, "Invalid or missing token")
    room = get_room(room_id)
    if not room or not room["username"]:
        raise HTTPException(409, "room has no username configured")
    return await connect_room(room_id, room["username"])


@app.post("/api/connect")
async def connect_direct(request: Request) -> dict:
    if not authorized(request):
        raise HTTPException(401, "Invalid or missing token")
    body = await request.json()
    username = str(body.get("username") or "").strip().lstrip("@")
    if not username:
        raise HTTPException(400, "username is required")
    room_id = str(body.get("room_id") or "default")
    if not get_room(room_id):
        run("INSERT INTO rooms(id,name,username,provider,config,created_at) VALUES(%s,%s,%s,%s,%s::jsonb,%s)",
            (room_id, username, username, "tiktok", "{}", now_ms()))
    return await connect_room(room_id, username)


@app.post("/api/disconnect")
async def disconnect(request: Request) -> dict:
    if not authorized(request):
        raise HTTPException(401, "Invalid or missing token")
    body = await request.json()
    return await disconnect_room(str(body.get("room_id") or "default"))


# ------------------------------------------------------------------- websockets
@app.websocket("/ws/{client_type}/{room_id}")
async def overlay_socket(ws: WebSocket, client_type: str, room_id: str) -> None:
    if client_type not in ("room", "customizer", "overlay"):
        await ws.close(code=1008, reason="unknown client type")
        return
    room = get_room(room_id)
    if not room:
        await ws.close(code=1008, reason="unknown room")
        return
    await ws.accept()
    clients[room_id].add(ws)
    try:
        await ws.send_text(json.dumps({"type": "config", "config": page_config(room["config"])}, ensure_ascii=False))
        await ws.send_text(json.dumps(status_frame(room), ensure_ascii=False))
        while True:
            message = await ws.receive_text()
            try:
                frame = json.loads(message)
            except Exception:
                continue
            if not isinstance(frame, dict):
                continue
            if frame.get("type") == "ping":
                await ws.send_text('{"type":"pong"}')
            elif frame.get("type") == "topChatters":
                await ws.send_text(json.dumps({
                    "type": "topChatters",
                    "chatters": top_chatters(room_id, int(frame.get("limit") or 10)),
                }, ensure_ascii=False))
    except WebSocketDisconnect:
        pass
    finally:
        clients[room_id].discard(ws)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
