//! The StreamKit backend as an event source.
//!
//! The backend is the same thing the local bridge is — it reads TikTok's
//! websocket and fans the result out — but it runs on a machine the user chose
//! rather than on theirs. When it is reachable it replaces the bridge outright,
//! because the two produce the same events and only one of them costs 85 MB.
//!
//! Frames are mapped onto the app's own `SidecarEvent` shape before being
//! emitted, so `useChat`, the statistics and the gift alerts need to know nothing
//! about where a frame came from. That is the whole point of doing this in the
//! host: the frontend is written against one vocabulary, and a second source is a
//! producer rather than a rewrite.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::Emitter as _;
use tauri_plugin_notification::NotificationExt as _;

/// The event name the host has always emitted on, and which the frontend's single
/// `attach` already listens to.
const EVENT: &str = "sidecar-event";

/// Client type used in the socket path.
///
/// The backend scopes clients by type so an OBS browser source and a desktop app
/// are distinguishable to it. This app is not an overlay and does not render one.
const CLIENT_TYPE: &str = "desk";

/// How long to wait for a frame before checking whether we have been cancelled.
///
/// A quiet room sends nothing for minutes, and a loop that only notices
/// cancellation when a frame arrives would hold its socket open long after Stop.
const POLL_SECS: u64 = 2;

/// Attempts before giving up and reporting.
///
/// Bounded rather than forever: a background retry loop that never surfaces is
/// indistinguishable from an app that silently stopped reading chat, which is the
/// failure mode this whole module exists to avoid.
const ATTEMPTS: u32 = 5;

/// Delay between attempts, in seconds. Doubles, because a server that is
/// restarting comes back in a known time and one that is down stays down.
const BACKOFF_START_SECS: u64 = 1;
const BACKOFF_MAX_SECS: u64 = 15;

/// Where the backend lives and which overlay to read.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackendConfig {
    /// Origin and optional path, as typed: `https://kit-backend.example`.
    pub base_url: String,
    /// Which overlay's room to read. One overlay is one connected room.
    pub overlay_id: String,
}

impl BackendConfig {
    /// Whether there is enough here to open a socket.
    ///
    /// Checked before connecting so an unconfigured app reports what is missing
    /// rather than a DNS failure about an empty hostname.
    pub fn describe_missing(&self) -> Option<&'static str> {
        if self.base_url.trim().is_empty() {
            Some("a backend URL")
        } else if self.overlay_id.trim().is_empty() {
            Some("an overlay id")
        } else {
            None
        }
    }
}

/// Cancels whichever reader loop is running.
///
/// A generation counter rather than a cancellation token: it needs no dependency,
/// and a stale loop that misses one check simply misses the next one, because it
/// compares before every connect and after every frame.
#[derive(Default)]
pub struct BackendState {
    generation: AtomicU64,
}

impl BackendState {
    /// Starts a new generation, making whatever is running stop.
    pub fn renew(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    fn current(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
}

/// The socket URL for one overlay.
///
/// The scheme follows the page: a backend reached over `https` must be reached
/// over `wss`, and quietly downgrading would leave the key on the wire if anyone
/// adds one later.
pub fn socket_url(base: &str, overlay_id: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    let scheme = if trimmed.starts_with("https://") {
        "wss://"
    } else {
        "ws://"
    };
    let host = trimmed
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    format!("{scheme}{host}/ws/{CLIENT_TYPE}/{}", overlay_id.trim())
}

/// Turns a backend frame into the app's own event shape, or `None` for anything
/// the app has no use for.
///
/// Pure, because this is the whole compatibility surface and a mapping that
/// quietly drops a field is invisible: the feed just gets sparser.
pub fn to_app_event(frame: &Value, now_ms: i64) -> Option<Value> {
    let kind = frame.get("type")?.as_str()?;
    // The app's status and error rows say which room they belong to, and every
    // room is TikTok now — but the field has to be present or the frame is
    // treated as being about the bridge and dropped.
    let platform = json!("tiktok");

    // Stamped on arrival rather than taken from the frame, because the backend
    // sends no timestamp at all. The app uses it for the clock beside each row
    // and for the collapse window, and both are about when a message showed up,
    // not about when TikTok generated it — a message that waited behind the
    // fan-out gate should not read as older than it was delivered.
    let timestamp = now_ms;
    let user = || {
        frame
            .get("user")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let id = || {
        let raw = frame.get("userId").and_then(Value::as_str).unwrap_or_default();
        // The backend falls back to the nickname when it has no stable handle,
        // but an empty one would key every such viewer to the same row.
        if raw.is_empty() { user() } else { raw.to_string() }
    };
    // The backend carries no avatar: TikTokLive has none on its events, and the
    // only way to get one is a profile-page scrape per viewer. The feed renders
    // an initial instead, which is why this is an empty string rather than a
    // field the app would have to treat as missing.
    let avatar = "";

    let count = frame.get("count").and_then(Value::as_i64).unwrap_or(1);

    Some(match kind {
        "comment" => json!({
            "type": "chat", "platform": platform, "nickname": user(), "id": id(),
            "avatar": avatar, "text": frame.get("text").and_then(Value::as_str).unwrap_or_default(),
            "timestamp": timestamp,
        }),
        "like" => json!({
            "type": "like", "platform": platform, "nickname": user(), "id": id(),
            "avatar": avatar, "count": count, "timestamp": timestamp,
        }),
        "gift" => json!({
            "type": "gift", "platform": platform, "nickname": user(), "id": id(),
            "avatar": avatar,
            "giftName": frame.get("giftName").and_then(Value::as_str).unwrap_or("Gift"),
            "count": count,
            // Already a total, not a unit price: the backend multiplies by the
            // repeat count before it emits, so this must not be multiplied again
            // or the diamonds double on every frame of a wave.
            "diamonds": frame.get("value").and_then(Value::as_i64).unwrap_or(0),
            "timestamp": timestamp,
        }),
        "join" => json!({
            "type": "join", "platform": platform, "nickname": user(), "id": id(),
            "avatar": avatar, "timestamp": timestamp,
        }),
        "follow" => json!({
            "type": "follow", "platform": platform, "nickname": user(), "id": id(),
            "avatar": avatar, "timestamp": timestamp,
        }),
        "share" => json!({
            "type": "share", "platform": platform, "nickname": user(), "id": id(),
            "avatar": avatar, "timestamp": timestamp,
        }),
        "viewers" => json!({
            "type": "viewers", "platform": platform,
            "count": frame.get("count").and_then(Value::as_i64).unwrap_or(0),
        }),
        "status" => json!({
            "type": "status", "platform": platform,
            "connected": frame.get("connected").and_then(Value::as_bool).unwrap_or(false),
            "connecting": frame.get("connecting").and_then(Value::as_bool).unwrap_or(false),
            "message": frame.get("message").and_then(Value::as_str).unwrap_or_default(),
        }),
        "error" => json!({
            "type": "error", "platform": platform,
            "message": frame.get("message").and_then(Value::as_str).unwrap_or_default(),
        }),
        // `config` is the overlay's own widget settings, `alert` is a donation
        // hook. Neither is a chat event, and silently folding a donation into a
        // gift row would put a number in the diamonds total that nobody sent.
        _ => return None,
    })
}



/// Reports a failure the way the rest of the app reports one.
///
/// The log line is for the panel; the status frame is what the toolbar shows. A
/// backend that is down has to be visible on the status line, not only in a log
/// nobody has open.
fn report(app: &tauri::AppHandle, message: String) {
    let _ = app.emit(
        EVENT,
        json!({ "type": "log", "platform": "bridge", "level": "warn", "message": message.clone() }),
    );
    let _ = app.emit(
        EVENT,
        json!({ "type": "status", "platform": "tiktok", "connected": false, "message": message }),
    );
    let _ = app
        .notification()
        .builder()
        .title("Live chat backend")
        .body(message)
        .show();
}

/// Opens the socket and pumps frames until cancelled or given up on.
///
/// Runs on Tauri's runtime rather than a thread of its own so `Stop` reaches it
/// without waiting for a blocking read to return.
pub async fn pump(
    app: tauri::AppHandle,
    config: BackendConfig,
    state: Arc<BackendState>,
    generation: u64,
) {
    if let Some(missing) = config.describe_missing() {
        report(&app, format!("Backend not configured: {missing} is missing."));
        return;
    }
    let url = socket_url(&config.base_url, &config.overlay_id);

    let mut delay = Duration::from_secs(BACKOFF_START_SECS);
    for attempt in 1..=ATTEMPTS {
        if state.current() != generation {
            return;
        }
        match run_once(&app, &url, &state, generation).await {
            Ok(()) => return,
            Err(why) => {
                let said = if attempt == 1 {
                    format!("Connecting to the backend at {url}…")
                } else {
                    format!("Backend attempt {attempt}/{ATTEMPTS} failed: {why}")
                };
                let _ = app.emit(
                    EVENT,
                    json!({ "type": "log", "platform": "bridge", "level": "warn", "message": said }),
                );
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(BACKOFF_MAX_SECS));
            }
        }
    }

    // Out of attempts. Say so in words that name the way out, because a feed that
    // has gone quiet with no explanation is the failure people cannot act on.
    report(
        &app,
        format!("Could not read from the backend at {url}. Switch the source back to Bridge to keep reading."),
    );
}

/// One connection, from open until closed or cancelled.
async fn run_once(
    app: &tauri::AppHandle,
    url: &str,
    state: &BackendState,
    generation: u64,
) -> Result<(), String> {
    use futures_util::StreamExt as _;

    let (mut stream, _response) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|e| e.to_string())?;

    // Read straight off the stream rather than splitting it: nothing is ever sent
    // on this socket, and splitting allocates a queue for a write half nobody
    // touches.
    loop {
        if state.current() != generation {
            return Ok(());
        }
        let next = tokio::time::timeout(Duration::from_secs(POLL_SECS), stream.next())
            .await
            .map_err(|_| "no frames arriving")?
            .ok_or("the backend closed the connection")?;

        // The tungstenite message type carries its own result so a text frame
        // that could not be decoded arrives rather than being lost — which is why
        // a single bad frame must not be allowed to end the connection.
        match next {
            Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                    // A frame that is not JSON is the backend's problem, not a
                    // reason to drop the connection and reconnect-storm.
                    continue;
                };
                if let Some(event) = to_app_event(&frame, now_ms()) {
                    let _ = app.emit(EVENT, event);
                }
            }
            Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => {
                return Err("the backend closed the connection".into())
            }
            Err(e) => return Err(e.to_string()),
            // Ping, pong and binary are the socket talking to itself.
            _ => {}
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The config file, beside the model settings rather than in `localStorage`.
///
/// Not because a feed URL is secret — it is not — but because it is configuration
/// that has to survive a restart, and this is where the app already keeps that.
pub fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager as _;
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("backend.json"))
        .map_err(|e| format!("no config directory: {e}"))
}

pub fn read_config(app: &tauri::AppHandle) -> BackendConfig {
    config_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn write_config(app: &tauri::AppHandle, config: &BackendConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("could not write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_700_000_000_000;

    fn mapped(frame: Value) -> Value {
        to_app_event(&frame, NOW).expect("should map")
    }

    #[test]
    fn the_socket_follows_the_page() {
        assert_eq!(
            socket_url("https://kit.example", "abc"),
            "wss://kit.example/ws/desk/abc"
        );
        assert_eq!(socket_url("http://127.0.0.1:8000/", "abc"), "ws://127.0.0.1:8000/ws/desk/abc");
        // Never silently downgrade: a backend reached over https must be reached
        // over wss, or anything later sent on this socket is in the clear.
        assert!(socket_url("https://kit.example", "abc").starts_with("wss://"));
    }

    #[test]
    fn a_comment_arrives_as_a_chat_row() {
        let out = mapped(json!({ "type": "comment", "user": "eko", "userId": "7", "text": "hi" }));
        assert_eq!(out["type"], "chat");
        assert_eq!(out["nickname"], "eko");
        assert_eq!(out["id"], "7");
        assert_eq!(out["text"], "hi");
        assert_eq!(out["timestamp"], NOW);
        // Without this the app treats the frame as being about the bridge and
        // drops it, which is a silent total blackout rather than a visible fault.
        assert_eq!(out["platform"], "tiktok");
    }

    #[test]
    fn gift_diamonds_are_not_multiplied_again() {
        // The backend already sent a total: diamond_count * repeat_count.
        let out = mapped(json!({ "type": "gift", "user": "a", "userId": "a", "giftName": "Rose", "count": 3, "value": 99 }));
        assert_eq!(out["diamonds"], 99);
        assert_eq!(out["count"], 3);
        assert_eq!(out["giftName"], "Rose");
    }

    #[test]
    fn follow_exists_so_the_filter_is_not_a_lie() {
        let out = mapped(json!({ "type": "follow", "user": "a", "userId": "9" }));
        assert_eq!(out["type"], "follow");
        assert_eq!(out["id"], "9");
    }

    #[test]
    fn viewers_passes_through_untouched() {
        let out = mapped(json!({ "type": "viewers", "count": 1234 }));
        assert_eq!(out["type"], "viewers");
        assert_eq!(out["count"], 1234);
    }

    #[test]
    fn a_missing_handle_falls_back_to_the_nickname() {
        // The backend does this itself, but an empty id would key every such
        // viewer to the same row, so it is worth being sure the app is not the
        // one collapsing them.
        let out = mapped(json!({ "type": "comment", "user": "eko", "userId": "", "text": "x" }));
        assert_eq!(out["id"], "eko");
    }

    #[test]
    fn a_donation_is_not_a_gift() {
        // Folding a webhook donation into a gift would put a number in the
        // diamonds total that nobody sent.
        assert!(to_app_event(&json!({ "type": "alert", "amount": 50000 }), NOW).is_none());
        assert!(to_app_event(&json!({ "type": "config", "config": {} }), NOW).is_none());
    }

    #[test]
    fn nonsense_does_not_panic() {
        assert!(to_app_event(&json!({}), NOW).is_none());
        assert!(to_app_event(&json!({ "type": 7 }), NOW).is_none());
        assert!(to_app_event(&json!({ "type": "comment" }), NOW).is_some());
        assert_eq!(mapped(json!({ "type": "gift", "user": "a" }))["diamonds"], 0);
    }

    #[test]
    fn an_unconfigured_source_says_what_is_missing() {
        let empty = BackendConfig::default();
        assert_eq!(empty.describe_missing(), Some("a backend URL"));
        let no_id = BackendConfig { base_url: "https://kit.example".into(), ..Default::default() };
        assert_eq!(no_id.describe_missing(), Some("an overlay id"));
        let ready = BackendConfig { base_url: "https://kit.example".into(), overlay_id: "a".into() };
        assert_eq!(ready.describe_missing(), None);
    }
}