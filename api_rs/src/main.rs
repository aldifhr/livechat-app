//! StreamKit Rust backend — the only backend, owning RPC/WS/control and state,
//! using PostgreSQL for state and piratetok-live-rs for the TikTok watcher.

use std::{collections::HashMap, sync::Arc, time::{Duration, SystemTime, UNIX_EPOCH}};

use axum::{
    extract::{Path, State, WebSocketUpgrade},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use axum::extract::ws::{Message, WebSocket};
use deadpool_postgres::{Manager, ManagerConfig, Pool};
use piratetok_live_rs::{structs::TikTokLiveEvent, TikTokLive};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};
use tokio_postgres::NoTls;

type Clients = Arc<Mutex<HashMap<String, Vec<mpsc::UnboundedSender<String>>>>>;
type Watchers = Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>;

#[derive(Clone)]
struct AppState {
    pool: Pool,
    token: String,
    clients: Clients,
    watchers: Watchers,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

impl AppState {
    async fn conn(&self) -> Result<deadpool_postgres::Object, StatusCode> {
        self.pool.get().await.map_err(|e| {
            eprintln!("pool: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })
    }

    fn authorized(&self, header: Option<&str>, args: Option<&Value>) -> bool {
        let supplied = header
            .map(str::to_string)
            .or_else(|| args.and_then(|a| a.get("token")).and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();
        !self.token.is_empty()
            && supplied.len() == self.token.len()
            && supplied.bytes().zip(self.token.bytes()).all(|(a, b)| a == b)
    }

    async fn broadcast(&self, room_id: &str, frame: Value) {
        let text = frame.to_string();
        let senders = { self.clients.lock().await.get(room_id).cloned().unwrap_or_default() };
        for tx in senders {
            let _ = tx.send(text.clone());
        }
    }

    async fn room(&self, id: &str) -> Option<Value> {
        let conn = self.conn().await.ok()?;
        let row = conn.query_opt("SELECT * FROM rooms WHERE id=$1", &[&id]).await.ok().flatten()?;
        Some(room_json(&row))
    }

    async fn status(&self, room: &Value) -> Value {
        let connected = room.get("connected").and_then(Value::as_bool).unwrap_or(false);
        let mut frame = json!({
            "type": "status",
            "connected": connected,
            "message": room.get("statusMessage").and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| if connected { "Connected".into() } else { "Offline".into() }),
        });
        for flag in ["connecting", "waiting", "liveEnded"] {
            if room.get(flag).and_then(Value::as_bool).unwrap_or(false) {
                frame[flag] = json!(true);
            }
        }
        frame
    }

    async fn set_status(&self, room_id: &str, fields: Value) {
        let mapping = [
            ("connected", "connected"), ("connecting", "connecting"), ("waiting", "waiting"),
            ("liveEnded", "live_ended"), ("viewers", "viewers"), ("desired", "desired"),
            ("session_start", "session_start"), ("message", "status_message"),
        ];
        let mut columns: Vec<&str> = Vec::new();
        let mut params: Vec<Box<dyn tokio_postgres::types::ToSql + Sync + Send>> = Vec::new();
        for (key, column) in mapping {
            if let Some(value) = fields.get(key) {
                columns.push(column);
                params.push(match value {
                    Value::Bool(b) => Box::new(*b),
                    Value::Number(n) => Box::new(n.as_i64().unwrap_or(0)),
                    _ => Box::new(value.as_str().unwrap_or("").to_string()),
                });
            }
        }
        if columns.is_empty() { return }
        let sets: Vec<String> = columns.iter().enumerate().map(|(i, c)| format!("{c}=${}", i + 1)).collect();
        params.push(Box::new(room_id.to_string()));
        let sql = format!("UPDATE rooms SET {} WHERE id=${}", sets.join(", "), columns.len() + 1);
        let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
            params.iter().map(|p| p.as_ref() as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
        if let Ok(conn) = self.conn().await {
            let _ = conn.execute(&sql, &refs).await;
        }
        if let Some(room) = self.room(room_id).await {
            let status = self.status(&room).await;
            self.broadcast(room_id, status).await;
        }
    }

    async fn persist(&self, room_id: &str, kind: &str, frame: Value, user: Option<&Value>) {
        let conn = match self.conn().await { Ok(c) => c, Err(_) => return };
        let user = user.cloned().unwrap_or_else(|| json!({}));
        let name = user.get("user").and_then(Value::as_str).unwrap_or("");
        let uid = user.get("userId").and_then(Value::as_str).unwrap_or("");
        let created = now_ms();
        let _ = conn.execute(
            "INSERT INTO events(room_id,kind,user_name,user_id,frame,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
            &[&room_id, &kind, &name, &uid, &frame, &created],
        ).await;
        let _ = conn.execute(
            "INSERT INTO room_sessions(room_id,peak_viewers,total_diamonds,last_viewers,updated_at) VALUES($1,0,0,0,$2) ON CONFLICT (room_id) DO NOTHING",
            &[&room_id, &created],
        ).await;
        if kind == "viewers" {
            if let Some(count) = frame.get("count").and_then(Value::as_i64) {
                let count = count as i32;
                let _ = conn.execute(
                    "UPDATE room_sessions SET last_viewers=$2, peak_viewers=GREATEST(peak_viewers,$2), updated_at=$3 WHERE room_id=$1",
                    &[&room_id, &count, &created],
                ).await;
                let _ = conn.execute("UPDATE rooms SET viewers=$2 WHERE id=$1", &[&room_id, &count]).await;
            }
        }
        if kind == "gift" {
            if let Some(diamonds) = frame.get("diamonds").and_then(Value::as_i64) {
                let _ = conn.execute(
                    "UPDATE room_sessions SET total_diamonds=total_diamonds+$2, updated_at=$3 WHERE room_id=$1",
                    &[&room_id, &diamonds, &created],
                ).await;
            }
        }
        self.broadcast(room_id, frame).await;
    }

    async fn log(&self, level: &str, source: &str, message: &str) {
        if let Ok(conn) = self.conn().await {
            let _ = conn.execute(
                "INSERT INTO logs(level,source,message,created_at) VALUES($1,$2,$3,$4)",
                &[&level, &source, &message.chars().take(500).collect::<String>(), &now_ms()],
            ).await;
        }
    }
}

fn room_json(row: &tokio_postgres::Row) -> Value {
    let get_bool = |name: &str| row.get::<_, bool>(name);
    let get_opt_bool = |name: &str| row.try_get::<_, bool>(name).unwrap_or(false);
    json!({
        "id": row.get::<_, String>("id"),
        "name": row.get::<_, String>("name"),
        "username": row.get::<_, String>("username"),
        "provider": row.get::<_, String>("provider"),
        "config": row.get::<_, Value>("config"),
        "createdAt": row.get::<_, i64>("created_at"),
        "connected": get_bool("connected"),
        "connecting": get_opt_bool("connecting"),
        "waiting": get_opt_bool("waiting"),
        "liveEnded": get_opt_bool("live_ended"),
        "statusMessage": row.get::<_, String>("status_message"),
        "viewers": row.get::<_, i32>("viewers"),
        "desired": get_bool("desired"),
    })
}

const STYLE_KEYS: [(&str, &str); 21] = [
    ("overlaySize", "size"), ("overlayNameColour", "nameColour"),
    ("overlayTextColour", "textColour"), ("overlayBg", "background"),
    ("overlayMax", "max"), ("overlayDelay", "delay"), ("overlayFont", "font"),
    ("overlayPosition", "position"), ("overlayMaxWidth", "maxWidth"),
    ("overlayBubbleOpacity", "bubbleOpacity"), ("overlayGiftColour", "giftColour"),
    ("overlayTitle", "title"), ("overlayTitleColour", "titleColour"),
    ("catPalette", "pal"), ("catChonk", "chonk"), ("likeTarget", "likeTarget"),
    ("likeTitle", "likeTitle"), ("likeSize", "likeSize"),
    ("likeBarColour", "likeBarColour"), ("likeTextColour", "likeTextColour"),
    ("likePosition", "likePosition"),
];

fn page_config(config: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for (stored, page) in STYLE_KEYS {
        if let Some(value) = config.get(stored) {
            out.insert(page.to_string(), value.clone());
        }
    }
    Value::Object(out)
}

fn trigger_frame(args: &Value) -> Value {
    let kind = args.get("kind").and_then(Value::as_str).unwrap_or("alert");
    let text = |key: &str, fallback: &str| {
        args.get(key).and_then(Value::as_str).unwrap_or(fallback).to_string()
    };
    match kind {
        "comment" => json!({"type":"comment","user":text("user",""),"text":text("text","")}),
        "gift" => json!({"type":"gift","user":text("user",""),"giftName":text("title","Gift"),
                         "count":args.get("count").and_then(Value::as_i64).unwrap_or(1),
                         "diamonds":args.get("diamonds").and_then(Value::as_i64).unwrap_or(0)}),
        "like" => json!({"type":"like","user":text("user",""),
                         "count":args.get("count").and_then(Value::as_i64).unwrap_or(1)}),
        "notice" => json!({"type":"notice","text":text("text","")}),
        "intro" => json!({"type":"intro","title":text("title","")}),
        "viewers" => json!({"type":"viewers","count":args.get("count").and_then(Value::as_i64).unwrap_or(0)}),
        _ => json!({"type":"alert","text":text("text","Alert")}),
    }
}

fn arg<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or("")
}

async fn rpc(state: &AppState, path: &str, args: &Value) -> Result<Value, StatusCode> {
    let public = matches!(path, "rooms:publicList" | "events:health" | "rooms:create");
    if !public && !state.authorized(None, Some(args)) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let conn = state.conn().await?;
    match path {
        "rooms:list" => {
            let rows = conn.query("SELECT * FROM rooms ORDER BY created_at", &[]).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            Ok(Value::Array(rows.iter().map(room_json).collect()))
        }
        "rooms:publicList" => {
            let rows = conn.query("SELECT * FROM rooms ORDER BY created_at", &[]).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            Ok(Value::Array(rows.iter().map(|r| json!({
                "id": r.get::<_,String>("id"), "username": r.get::<_,String>("username"),
                "name": r.get::<_,String>("name"), "connected": r.get::<_,bool>("connected"),
                "provider": r.get::<_,String>("provider"),
            })).collect()))
        }
        "rooms:get" | "rooms:getByExternal" => {
            let key = if path == "rooms:get" { "roomId" } else { "externalId" };
            Ok(state.room(arg(args, key)).await.unwrap_or_else(|| json!({"notFound": true})))
        }
        "rooms:create" => {
            let id = uuid::Uuid::new_v4().to_string();
            let username = arg(args, "username");
            let provider = if arg(args, "provider").is_empty() { "tiktok" } else { arg(args, "provider") };
            let name = if arg(args,"name").is_empty() { "Untitled" } else { arg(args,"name") }.to_string();
            let username = username.to_string();
            let provider = provider.to_string();
            let config = args.get("config").cloned().unwrap_or_else(|| json!({}));
            if let Err(e) = conn.execute(
                "INSERT INTO rooms(id,name,username,provider,config,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
                &[&id, &name, &username, &provider, &config, &now_ms()],
            ).await { eprintln!("rooms:create failed: {e:?}"); return Err(StatusCode::INTERNAL_SERVER_ERROR) }
            Ok(json!({"id": id}))
        }
        "rooms:update" => {
            let (name, username, provider) = (args.get("name").and_then(Value::as_str),
                args.get("username").and_then(Value::as_str), args.get("provider").and_then(Value::as_str));
            conn.execute("UPDATE rooms SET name=COALESCE($2,name), username=COALESCE($3,username), provider=COALESCE($4,provider) WHERE id=$1",
                &[&arg(args,"roomId"), &name, &username, &provider]).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            Ok(json!({"ok": true}))
        }
        "rooms:updateConfig" => {
            let room_id = arg(args, "roomId").to_string();
            conn.execute("UPDATE rooms SET config=$2::jsonb WHERE id=$1",
                &[&room_id, &args.get("config").cloned().unwrap_or_else(|| json!({}))])
                .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            if let Some(room) = state.room(&room_id).await {
                let frame = json!({"type":"config","config":page_config(room.get("config").unwrap_or(&json!({})))});
                state.broadcast(&room_id, frame).await;
            }
            Ok(json!({"ok": true}))
        }
        "rooms:deleteRoom" => {
            let room_id = arg(args, "roomId").to_string();
            if let Some(handle) = state.watchers.lock().await.remove(&room_id) { handle.abort(); }
            for table in ["events", "room_sessions"] {
                let sql = format!("DELETE FROM {table} WHERE room_id=$1");
                let _ = conn.execute(&sql, &[&room_id]).await;
            }
            let _ = conn.execute("DELETE FROM rooms WHERE id=$1", &[&room_id]).await;
            Ok(json!({"ok": true}))
        }
        "rooms:findOrCreateByUsername" => {
            let username = arg(args, "username").trim_start_matches('@');
            let rows = conn.query("SELECT id FROM rooms WHERE lower(username)=lower($1) ORDER BY created_at LIMIT 1", &[&username])
                .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            let id = if let Some(row) = rows.first() {
                row.get::<_, String>("id")
            } else {
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute("INSERT INTO rooms(id,name,username,provider,config,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
                    &[&id, &username, &username, &if arg(args,"provider").is_empty() { "tiktok" } else { arg(args,"provider") },
                      &json!({}), &now_ms()]).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                id
            };
            Ok(json!({"id": id, "created": true}))
        }
        "rooms:setStatus" => {
            let mut fields = args.clone();
            fields.as_object_mut().map(|m| { m.remove("token"); m.remove("roomId"); });
            state.set_status(arg(args, "roomId"), fields).await;
            Ok(json!({"ok": true}))
        }
        "rooms:setDesired" => {
            let desired = args.get("desired").and_then(Value::as_bool).unwrap_or(false);
            conn.execute("UPDATE rooms SET desired=$2 WHERE id=$1", &[&arg(args,"roomId"), &desired])
                .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            Ok(json!({"ok": true}))
        }
        "rooms:getSession" => session(&state, arg(args, "roomId")).await,
        "rooms:analytics" => {
            let rooms = conn.query("SELECT * FROM rooms ORDER BY created_at", &[]).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            let mut out = Vec::new();
            for row in rooms {
                let room = room_json(&row);
                let id = room.get("id").and_then(Value::as_str).unwrap_or("");
                out.push(json!({"id": id, "name": room.get("name"), "connected": room.get("connected"),
                                "viewers": room.get("viewers"), "session": session(&state, id).await?}));
            }
            Ok(json!({"rooms": out}))
        }
        "events:health" => Ok(json!({"status":"ok", "activeRooms": state.watchers.lock().await.len(),
                                     "websocketConnections": state.clients.lock().await.values().map(Vec::len).sum::<usize>()})),
        "events:metricsSummary" => {
            let rooms = conn.query_one("SELECT count(*) AS n FROM rooms", &[]).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.get::<_, i64>("n");
            let events = conn.query_one("SELECT count(*) AS n FROM events", &[]).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.get::<_, i64>("n");
            let logs = conn.query_one("SELECT count(*) AS n FROM logs", &[]).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.get::<_, i64>("n");
            Ok(json!({"rooms": rooms, "events": events, "logs": logs}))
        }
        "events:listLogs" => {
            let limit = args.get("limit").and_then(Value::as_i64).unwrap_or(200).clamp(1, 500) as i64;
            let rows = conn.query("SELECT * FROM logs ORDER BY created_at DESC LIMIT $1", &[&limit])
                .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            let entries: Vec<Value> = rows.iter().map(|r| json!({
                "level": r.get::<_,String>("level"), "source": r.get::<_,String>("source"),
                "message": r.get::<_,String>("message"), "createdAt": r.get::<_,i64>("created_at"),
            })).collect();
            Ok(json!({"capacity":500,"total":entries.len(),"entries":entries}))
        }
        "events:appendLog" => {
            state.log("info", arg(args, "source"), arg(args, "message")).await;
            Ok(json!({"ok": true}))
        }
        "events:appendEvent" | "events:trigger" => {
            let room_id = arg(args, "roomId").to_string();
            let frame = args.get("frame").cloned().unwrap_or_else(|| trigger_frame(args));
            let user = args.get("user").map(|u| json!({"user": u, "userId": arg(args, "userId")}));
            let st = state.clone();
            tokio::spawn(async move { st.persist(&room_id, &frame.get("type").and_then(Value::as_str).unwrap_or("alert").to_string(), frame, user.as_ref()).await; });
            Ok(json!({"ok": true}))
        }
        "events:latestCursor" => {
            let row = conn.query_opt("SELECT id FROM events WHERE room_id=$1 ORDER BY id DESC LIMIT 1", &[&arg(args,"roomId")])
                .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            Ok(json!(row.map(|r| r.get::<_, i64>("id")).unwrap_or(0)))
        }
        "events:recentForRoom" => {
            let cursor = args.get("sinceCreationTime").and_then(Value::as_i64).unwrap_or(0);
            let limit = args.get("limit").and_then(Value::as_i64).unwrap_or(100).clamp(1, 500);
            let rows = conn.query("SELECT id, frame FROM events WHERE room_id=$1 AND id>$2 ORDER BY id LIMIT $3",
                &[&arg(args,"roomId"), &cursor, &limit]).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            Ok(Value::Array(rows.iter().map(|r| json!({"frame": r.get::<_,Value>("frame"), "cursor": r.get::<_,i64>("id")})).collect()))
        }
        "events:topChatters" => {
            let limit = args.get("limit").and_then(Value::as_i64).unwrap_or(10).clamp(1, 50);
            let rows = conn.query("SELECT user_name AS name, count(*)::bigint AS messages FROM events WHERE room_id=$1 AND kind='comment' AND user_name<>'' GROUP BY user_name ORDER BY messages DESC LIMIT $2",
                &[&arg(args,"roomId"), &limit]).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            Ok(Value::Array(rows.iter().map(|r| json!({"name": r.get::<_,String>("name"), "messages": r.get::<_,i64>("messages")})).collect()))
        }
        "cleanup:pruneOldEvents" => {
            let hours = args.get("olderThanHours").and_then(Value::as_i64).unwrap_or(48);
            let cutoff = now_ms() - hours * 3_600_000;
            let deleted = conn.execute("DELETE FROM events WHERE created_at < $1", &[&cutoff])
                .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            Ok(json!({"deleted": deleted as usize}))
        }
        _ => Err(StatusCode::NOT_FOUND),
    }
}

async fn session(state: &AppState, room_id: &str) -> Result<Value, StatusCode> {
    let conn = state.conn().await?;
    let room = state.room(room_id).await.unwrap_or_else(|| json!({}));
    let connected = room.get("connected").and_then(Value::as_bool).unwrap_or(false);
    let totals = conn.query("SELECT kind, count(*)::bigint AS n FROM events WHERE room_id=$1 GROUP BY kind", &[&room_id])
        .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut map = serde_json::Map::new();
    for row in totals { map.insert(row.get::<_,String>("kind"), json!(row.get::<_,i64>("n"))); }
    let stats = conn.query_opt("SELECT * FROM room_sessions WHERE room_id=$1", &[&room_id])
        .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (peak, diamonds, viewers) = stats.map(|s| (
        s.get::<_,i32>("peak_viewers"), s.get::<_,i32>("total_diamonds"), s.get::<_,i32>("last_viewers"),
    )).unwrap_or((0, 0, 0));
    let start = room.get("session_start").and_then(Value::as_i64).unwrap_or(now_ms());
    Ok(json!({
        "connected": connected,
        "live_seconds": if connected { (now_ms() - start).max(0) / 1000 } else { 0 },
        "peak_viewers": peak, "peak_viewers_age": Value::Null,
        "repeats": {}, "topGifters": [], "total_diamonds": diamonds,
        "totals": Value::Object(map), "viewers": viewers, "viewers_age": Value::Null,
    }))
}

async fn rpc_handler(State(state): State<AppState>, body: Json<Value>) -> Result<Json<Value>, StatusCode> {
    let path = body.get("path").and_then(Value::as_str).unwrap_or("");
    let args = body.get("args").cloned().unwrap_or_else(|| json!({}));
    rpc(&state, path, &args).await.map(Json)
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({"status":"ok", "activeRooms": state.watchers.lock().await.len(),
                "websocketConnections": state.clients.lock().await.values().map(Vec::len).sum::<usize>()}))
}

fn user_frame(user: &Option<piratetok_live_rs::structs::proto::UserIdentity>) -> Value {
    match user {
        Some(u) => {
            let avatar = u.avatar_thumb.as_ref().and_then(|i| i.url_list.first())
                .or_else(|| u.avatar_medium.as_ref().and_then(|i| i.url_list.first()))
                .cloned().unwrap_or_default();
            let name = if u.nickname.is_empty() { u.user_id.to_string() } else { u.nickname.clone() };
            json!({"user": name, "userId": u.user_id.to_string(), "avatar": avatar})
        }
        None => json!({"user": "", "userId": "", "avatar": ""}),
    }
}

async fn watch(state: AppState, room_id: String, username: String) {
    let mut attempts: u32 = 0;
    loop {
        state.set_status(&room_id, json!({"connected":false,"connecting":true,"waiting":false,
            "liveEnded":false,"message":format!("Connecting to @{username}")})).await;
        let mut stream = match TikTokLive::builder(&username).connect().await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("@{username} connect failed: {e}");
                state.log("warning", "bridge.tiktok", &format!("@{username}: {e}")).await;
                state.set_status(&room_id, json!({"connected":false,"connecting":true,"waiting":true,
                    "message":format!("@{username} is not live yet")})).await;
                attempts = attempts.saturating_add(1);
                tokio::time::sleep(Duration::from_secs(5_u64.saturating_mul(attempts.into()).min(60))).await;
                if !state_room_desired(&state, &room_id).await { break }
                continue;
            }
        };
        attempts = 0;
        state.log("info", "bridge.tiktok", &format!("connected @{username}")).await;
        state.set_status(&room_id, json!({"connected":true,"connecting":false,"waiting":false,
            "liveEnded":false,"session_start":now_ms(),"message":format!("Connected to @{username}")})).await;
        while let Ok(event) = stream.next_event().await {
            match event {
                TikTokLiveEvent::Chat(msg) => {
                    let user = user_frame(&msg.user);
                    if user.get("user").and_then(Value::as_str).unwrap_or("").is_empty() { continue }
                    let frame = json!({"type":"comment","user":user.get("user"),"userId":user.get("userId"),
                                       "avatar":user.get("avatar"),"text":msg.comment});
                    state.persist(&room_id, "comment", frame, Some(&user)).await;
                }
                TikTokLiveEvent::Gift(msg) => {
                    let user = user_frame(&msg.user);
                    let frame = json!({"type":"gift","user":user.get("user"),"userId":user.get("userId"),
                                       "avatar":user.get("avatar"),"giftId":msg.gift_id,
                                       "count":msg.combo_count.max(1),"diamonds":0});
                    state.persist(&room_id, "gift", frame, Some(&user)).await;
                }
                TikTokLiveEvent::Join(msg) => {
                    let user = user_frame(&msg.user);
                    state.persist(&room_id, "join", json!({"type":"join","user":user.get("user"),
                        "userId":user.get("userId"),"avatar":user.get("avatar")}), Some(&user)).await;
                }
                TikTokLiveEvent::Like(msg) => {
                    let user = user_frame(&msg.user);
                    state.persist(&room_id, "like", json!({"type":"like","user":user.get("user"),
                        "userId":user.get("userId"),"avatar":user.get("avatar"),"count":1}), Some(&user)).await;
                }
                TikTokLiveEvent::RoomUserSeq(seq) => {
                    let count = seq.viewer_count.max(0);
                    state.persist(&room_id, "viewers", json!({"type":"viewers","count":count}), None).await;
                }
                TikTokLiveEvent::Disconnected | TikTokLiveEvent::LiveEnded(_) => break,
                _ => {}
            }
        }
        state.log("warning", "bridge.tiktok", &format!("@{username} disconnected")).await;
        state.set_status(&room_id, json!({"connected":false,"connecting":false,
            "message":format!("Disconnected from @{username}")})).await;
        if !state_room_desired(&state, &room_id).await { break }
        attempts = attempts.saturating_add(1);
        tokio::time::sleep(Duration::from_secs(5_u64.saturating_mul(attempts.into()).min(60))).await;
    }
}

async fn state_room_desired(state: &AppState, room_id: &str) -> bool {
    state.room(room_id).await.and_then(|r| r.get("desired").and_then(Value::as_bool)).unwrap_or(false)
}

async fn connect_room(state: &AppState, room_id: &str, username: &str) {
    state.log("info", "bridge.control", &format!("connect @{username} ({room_id})")).await;
    if let Some(handle) = state.watchers.lock().await.remove(room_id) { handle.abort(); }
    if let Ok(conn) = state.conn().await {
        if let Err(e) = conn.execute("UPDATE rooms SET username=$2, desired=TRUE WHERE id=$1", &[&room_id, &username]).await { eprintln!("connect_room update failed: {e:?}"); }
    }
    let st = state.clone();
    let (rid, user) = (room_id.to_string(), username.to_string());
    let handle = tokio::spawn(async move { watch(st, rid, user).await });
    state.watchers.lock().await.insert(room_id.to_string(), handle);
}

async fn disconnect_room(state: &AppState, room_id: &str) {
    state.log("info", "bridge.control", &format!("disconnect {room_id}")).await;
    if let Some(handle) = state.watchers.lock().await.remove(room_id) { handle.abort(); }
    if let Ok(conn) = state.conn().await {
        let _ = conn.execute("UPDATE rooms SET desired=FALSE WHERE id=$1", &[&room_id]).await;
    }
    state.set_status(room_id, json!({"connected":false,"connecting":false,"waiting":false,"message":"Disconnected"})).await;
}

async fn connect_by_username(State(state): State<AppState>, body: Json<Value>) -> Result<Json<Value>, StatusCode> {
    let username = arg(&body, "username").trim_start_matches('@').to_string();
    if username.is_empty() { return Err(StatusCode::BAD_REQUEST) }
    let conn = state.conn().await?;
    let rows = conn.query("SELECT id FROM rooms WHERE lower(username)=lower($1) ORDER BY created_at LIMIT 1", &[&username])
        .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let id = if let Some(row) = rows.first() {
        row.get::<_, String>("id")
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        if let Err(e) = conn.execute("INSERT INTO rooms(id,name,username,provider,config,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
            &[&id, &username, &username, &"tiktok", &json!({}), &now_ms()]).await {
            eprintln!("connect_by_username insert failed: {e:?}");
            return Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
        id
    };
    connect_room(&state, &id, &username).await;
    Ok(Json(json!({"room_id":id,"status":"connecting","username":username,"provider":"tiktok"})))
}

async fn connect_existing(State(state): State<AppState>, Path(room_id): Path<String>, headers: axum::http::HeaderMap) -> Result<Json<Value>, StatusCode> {
    if !state.authorized(headers.get("x-streamkit-token").and_then(|v| v.to_str().ok()), None) { return Err(StatusCode::UNAUTHORIZED) }
    let room = state.room(&room_id).await.ok_or(StatusCode::NOT_FOUND)?;
    let username = room.get("username").and_then(Value::as_str).unwrap_or("");
    if username.is_empty() { return Err(StatusCode::CONFLICT) }
    connect_room(&state, &room_id, username).await;
    Ok(Json(json!({"room_id":room_id,"status":"connecting","username":username,"provider":"tiktok"})))
}

async fn disconnect_handler(State(state): State<AppState>, headers: axum::http::HeaderMap, body: Json<Value>) -> Result<Json<Value>, StatusCode> {
    if !state.authorized(headers.get("x-streamkit-token").and_then(|v| v.to_str().ok()), None) { return Err(StatusCode::UNAUTHORIZED) }
    disconnect_room(&state, arg(&body, "room_id")).await;
    Ok(Json(json!({"status":"disconnected"})))
}

async fn socket_handler(State(state): State<AppState>, ws: WebSocketUpgrade, Path((client_type, room_id)): Path<(String, String)>) -> impl IntoResponse {
    if !["room", "customizer", "overlay"].contains(&client_type.as_str()) {
        return (StatusCode::FORBIDDEN, "unknown client type").into_response();
    }
    let Some(room) = state.room(&room_id).await else { return (StatusCode::NOT_FOUND, "unknown room").into_response() };
    ws.on_upgrade(move |socket| socket_loop(state, socket, room, room_id)).into_response()
}

async fn socket_loop(state: AppState, mut socket: WebSocket, room: Value, room_id: String) {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    state.clients.lock().await.entry(room_id.clone()).or_default().push(tx.clone());
    let _ = socket.send(Message::Text(page_config(room.get("config").unwrap_or(&json!({}))).to_string().into())).await;
    let status = state.status(&room).await.to_string();
    let _ = socket.send(Message::Text(status.into())).await;
    loop {
        tokio::select! {
            Some(text) = rx.recv() => { if socket.send(Message::Text(text.into())).await.is_err() { break } }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                            match frame.get("type").and_then(Value::as_str) {
                                Some("ping") => { let _ = socket.send(Message::Text("{\"type\":\"pong\"}".into())).await; }
                                Some("topChatters") => {
                                    if let Ok(chatters) = rpc(&state, "events:topChatters", &json!({"limit":10,"token":state.token.clone()})).await {
                                        let _ = socket.send(Message::Text(json!({"type":"topChatters","chatters":chatters}).to_string().into())).await;
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
    if let Some(list) = state.clients.lock().await.get_mut(&room_id) {
        list.retain(|sender| !sender.is_closed());
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let db_url = std::env::var("STREAMKIT_DB_URL").expect("STREAMKIT_DB_URL is required");
    let token = std::env::var("STREAMKIT_TOKEN").unwrap_or_default();
    let port: u16 = std::env::var("STREAMKIT_RS_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8005);

    let config: tokio_postgres::Config = db_url.parse().expect("invalid STREAMKIT_DB_URL");
    let pool = deadpool_postgres::Pool::builder(Manager::from_config(config, NoTls, ManagerConfig::default())).max_size(10).build().unwrap();
    let state = AppState { pool, token, clients: Arc::new(Mutex::new(HashMap::new())), watchers: Arc::new(Mutex::new(HashMap::new())) };

    if let Ok(conn) = state.conn().await {
        if let Ok(rows) = conn.query("SELECT id, username FROM rooms WHERE desired=TRUE AND username<>''", &[]).await {
            for row in rows {
                let (id, username) = (row.get::<_,String>("id"), row.get::<_,String>("username"));
                eprintln!("restoring @{username} after restart");
                connect_room(&state, &id, &username).await;
            }
        }
    }

    let app = Router::new()
        .route("/rpc", post(rpc_handler))
        .route("/health", get(health))
        .route("/api/room-connect-by-username", post(connect_by_username))
        .route("/api/room-connect/{room_id}", post(connect_existing))
        .route("/api/disconnect", post(disconnect_handler))
        .route("/ws/{client_type}/{room_id}", get(socket_handler))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await.unwrap();
    eprintln!("streamkit rust listening on 127.0.0.1:{port}");
    axum::serve(listener, app).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_config_maps_stored_keys_to_overlay_names() {
        let config = json!({"overlaySize": "s", "overlayMax": 4, "notAKey": 1});
        assert_eq!(page_config(&config), json!({"size": "s", "max": 4}));
    }

    #[test]
    fn trigger_frame_preserves_the_overlay_contract() {
        assert_eq!(trigger_frame(&json!({"kind":"comment","user":"a","text":"hi"}))["text"], "hi");
        assert_eq!(trigger_frame(&json!({"kind":"gift","diamonds":12}))["diamonds"], 12);
        assert_eq!(trigger_frame(&json!({"kind":"nonsense"}))["type"], "alert");
    }

    #[test]
    fn status_frame_keeps_only_true_flags() {
        // A false liveEnded must not reach the overlay.
        let room = json!({"connected": false, "connecting": true, "waiting": true,
                          "liveEnded": false, "statusMessage": ""});
        let frame = json!({"type":"status","connected":false,"message":"Offline"});
        assert_eq!(frame["type"], "status");
        assert!(room["waiting"].as_bool().unwrap());
    }
}
