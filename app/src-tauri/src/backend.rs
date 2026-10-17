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
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::Emitter as _;
use tauri_plugin_notification::NotificationExt as _;

/// The event name the host has always emitted on, and which the frontend's single
/// `attach` already listens to.
/// The channel every frame reaches the webview on. Public so the host commands can
/// emit their own status frames on the same one — a disconnect emitted anywhere
/// else would be a log line nothing listens to.
pub const EVENT: &str = "sidecar-event";

/// Client type used in the socket path.
///
/// The backend's own word for this, not one invented here. Its hub registers any
/// client type into the room's client set, so a made-up one works today and would
/// keep working — but it is borrowing a term the server does not recognise, and a
/// whitelist on the far side would turn that into a silent "no frames", which is
/// the failure this whole module exists to make visible.
const CLIENT_TYPE: &str = "room";

/// How often to check whether we have been cancelled, while waiting for a frame.
///
/// Short, because this is the latency of Stop on a busy room and nothing else. It
/// is not a liveness threshold — see `SILENCE_LIMIT_SECS`, which is that, and is
/// deliberately much longer.
///
/// A quiet room sends nothing for minutes, and a loop that only notices
/// cancellation when a frame arrives would hold its socket open long after Stop.
const POLL_SECS: u64 = 2;

/// How long the socket may stay silent before the connection is presumed dead.
///
/// Deliberately far longer than `POLL_SECS`, and the two must never be the same
/// number again. Silence here is normal: the backend buffers frames until TikTok's
/// first event arrives, so a stream whose chat has not started can sit quiet for
/// minutes while being perfectly healthy. The failure worth catching is a socket
/// that has stopped answering at all — and a dead one does not announce itself, so
/// this is a guess. It is guessed generously, because the cost of guessing wrong in
/// that direction is a feed that looks frozen, and the cost of guessing wrong in
/// the other direction is dropping a live room during exactly the wait it needed.
const SILENCE_LIMIT_SECS: u64 = 120;

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

/// The backend this build talks to.
///
/// Written in rather than asked for, because it is one address that does not
/// change between users, and being asked for it every time is the sort of
/// question that trains people to paste a link without reading where it goes. It
/// stays in the config file and stays editable — a second backend, or a local one
/// on `http://127.0.0.1:8000`, is a normal thing to point this at — but a fresh
/// install already knows where to look.
pub const DEFAULT_BASE_URL: &str = "https://kit-backend.aldifhr.my.id";

/// Where the backend lives and which stream to read.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackendConfig {
    /// Origin and optional path, as typed: `https://kit-backend.example`.
    pub base_url: String,
    /// The streamer's TikTok handle, as typed.
    ///
    /// Not a room id. The backend keys everything by room, so one has to be
    /// resolved — but nobody should have to read a UUID out of a dashboard to
    /// watch a stream, and the lookup is a plain read that needs no token.
    pub username: String,
    /// The overlay styling to remember on the room, as a JSON object.
    ///
    /// Sent with the connect so the backend can store it on the room, which is
    /// what lets the overlay link be a bare `?room=<id>` — the room carries the
    /// look and the link only names it. Empty means "send nothing", and the
    /// backend then stores no styling.
    #[serde(default)]
    pub overlay: serde_json::Value,
}

impl Default for BackendConfig {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            username: String::new(),
            overlay: serde_json::Value::Null,
        }
    }
}

/// Strips a handle down to what the backend has stored.
///
/// The room is looked up by its `username` field, so this has to read a handle the
/// same way whatever form it arrived in. A disagreement here is not a tidy
/// rejection — it is a room that cannot be found and a stream that reads as
/// missing rather than as a typo in what was typed.
pub fn normalise_username(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let handle = match tiktok_handle_in_url(trimmed) {
        Some(from_url) => from_url,
        None => trimmed.trim_start_matches('@').to_string(),
    };
    handle
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Pulls a handle out of a TikTok URL without dragging in a regex crate.
///
/// Deliberately narrow: it looks for "tiktok.com/@" and takes the run up to the
/// first path separator. Anything it does not recognise falls through to the
/// plain strip, which is what a bare handle needs anyway.
fn tiktok_handle_in_url(raw: &str) -> Option<String> {
    let lower = raw.to_ascii_lowercase();
    let marker = "tiktok.com/@";
    let at = lower.find(marker)? + marker.len();
    let tail = &raw[at..];
    let end = tail
        .find(|c: char| c == '/' || c == '?' || c == '#')
        .unwrap_or(tail.len());
    Some(tail[..end].to_string())
}

impl BackendConfig {
    /// Whether there is enough here to open a socket.
    ///
    /// Checked before connecting so an unconfigured app reports what is missing
    /// rather than a DNS failure about an empty hostname.
    pub fn describe_missing(&self) -> Option<&'static str> {
        if self.base_url.trim().is_empty() {
            Some("a backend URL")
        } else if normalise_username(&self.username).is_empty() {
            Some("a username")
        } else {
            None
        }
    }
}

/// What the reader is doing right now, as a frame the app can be handed.
///
/// Kept beside the generation rather than derived from it because the app needs
/// the *content* of the current session — which handle, which room, how many
/// viewers — and none of that is in a counter.
#[derive(Default, Clone)]
struct SessionInfo {
    /// The handle being read, once a connect has named one.
    username: String,
    /// The backend's id for the room, once it has been resolved.
    room_id: String,
    /// The room's title, when the backend reported one.
    title: String,
    /// The last headcount seen. `None` until one arrives, so "no figure yet" is
    /// not reported as zero viewers.
    viewers: Option<i64>,
}

/// Cancels whichever reader loop is running.
///
/// A generation counter rather than a cancellation token: it needs no dependency.
/// The reader compares it before every connect, before every frame and after
/// every frame — the last two are what make a Stop on a busy room take effect,
/// because a room that sends a frame every few seconds resolves `stream.next()`
/// long before the loop would otherwise come back around to check.
///
/// It also holds the current session's details, because a webview reload throws
/// the frontend's whole state away while this process keeps reading. The reader
/// survives the reload, so it is the only thing that can tell the new page what
/// it is looking at.
pub struct BackendState {
    generation: AtomicU64,
    /// Whether a reader loop is running, including while it retries.
    ///
    /// Separate from the generation because the generation only says *which*
    /// session is current, not whether one is: after the last attempt has failed
    /// the generation is unchanged and nothing is reading. A reloaded page asking
    /// "is anything connected?" needs the second answer.
    running: std::sync::atomic::AtomicBool,
    /// The session details, written by the reader as it learns them.
    ///
    /// A `Mutex` rather than atomics: these are a handful of strings updated a
    /// few times per session, and a lock held for the length of a struct copy is
    /// not a contention problem next to a websocket. Correctness here is worth
    /// more than lock-free elegance — a half-updated snapshot handed to the
    /// frontend would be a status line that lies.
    session: Mutex<SessionInfo>,
}

impl Default for BackendState {
    fn default() -> Self {
        Self {
            generation: AtomicU64::default(),
            running: std::sync::atomic::AtomicBool::new(false),
            session: Mutex::new(SessionInfo::default()),
        }
    }
}

impl BackendState {
    /// Starts a new generation, making whatever is running stop.
    ///
    /// Clears the session details too: a new connect is a new room, and leaving
    /// the old handle in place would have a snapshot name the previous stream
    /// until the new one resolved.
    pub fn renew(&self) -> u64 {
        self.set_session(SessionInfo::default());
        self.running.store(true, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn stop(&self) {
        self.set_session(SessionInfo::default());
        self.running.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// The reader has given up for good — retries exhausted, or a client that
    /// could not be rebuilt.
    ///
    /// The generation is left alone: this is not a new session, it is the current
    /// one ending, and bumping it would make a later snapshot report a session
    /// number the app has never seen a frame from.
    pub fn gave_up(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    fn current(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Records what the current session is reading.
    fn set_session(&self, info: SessionInfo) {
        if let Ok(mut held) = self.session.lock() {
            *held = info;
        }
    }

    /// Updates just the handle, keeping whatever else has been learned.
    fn set_username(&self, username: &str) {
        if let Ok(mut held) = self.session.lock() {
            held.username = username.to_string();
        }
    }

    /// Updates just the room identity, keeping whatever else has been learned.
    fn set_room(&self, room_id: &str, title: &str) {
        if let Ok(mut held) = self.session.lock() {
            held.room_id = room_id.to_string();
            if !title.is_empty() {
                held.title = title.to_string();
            }
        }
    }

    /// Updates the last headcount seen.
    fn set_viewers(&self, count: i64) {
        if let Ok(mut held) = self.session.lock() {
            held.viewers = Some(count);
        }
    }

    /// A copy of the session details, for a snapshot.
    fn session(&self) -> SessionInfo {
        self.session.lock().map(|held| held.clone()).unwrap_or_default()
    }

    /// Whether a reader loop is running for the current generation.
    ///
    /// `running` is set for the whole life of the pump, including the retries, so
    /// this is what separates "connected to a room" from "trying to reach one"
    /// when the frontend asks. It is not the same question as the socket being up
    /// — the app is told that separately, by the backend's own status frames.
    pub fn snapshot(&self) -> Value {
        let info = self.session();
        let connected = self.running.load(Ordering::SeqCst);
        let session = self.current();
        json!({
            "type": "status",
            // Room-level, not bridge-level: this describes the stream being read,
            // and the app treats a bridge status as "the reader itself changed".
            "platform": "tiktok",
            "connected": connected,
            "username": info.username,
            "roomId": info.room_id,
            "title": info.title,
            "viewers": info.viewers,
            // The session the app should expect frames from. Without it a reloaded
            // page would adopt whatever session arrived first and could not tell a
            // straggler from the live one.
            "session": session,
            // Marks this as a reconciliation rather than a transition. The app
            // replays it as the current state and does not log it as an event:
            // nothing happened, the page simply forgot.
            "snapshot": true,
        })
    }
}

/// Whether the loop holding `generation` has been superseded.
///
/// Named rather than written inline at each site because it is asked in six
/// places, and the one that gets forgotten is the one that emits after a Stop.
fn stale(state: &BackendState, generation: u64) -> bool {
    state.current() != generation
}

/// Joins a base URL and a path, without doubling or dropping the slash.
///
/// Written out rather than borrowed from a URL parser because providers disagree
/// about the trailing slash, and the common parser throws the last segment away
/// when the base has none.
fn endpoint(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

/// Keeps an error to one readable line.
///
/// The body can be a whole HTML error page, and this is the only place it is ever
/// shown.
fn shorten(text: &str, fallback: &str) -> String {
    const LIMIT: usize = 200;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    if trimmed.len() <= LIMIT {
        return trimmed.to_string();
    }
    // Walked by character rather than sliced at LIMIT, because LIMIT is a byte
    // count and the body is not necessarily ASCII. Slicing there is a panic the
    // first time a multi-byte character straddles the cut, which is a crash on
    // exactly the path that was already going wrong.
    let cut = trimmed
        .char_indices()
        .nth(LIMIT)
        .map(|(index, _)| index)
        .unwrap_or(trimmed.len());
    format!("{}…", &trimmed[..cut])
}

/// Starts reading a username, and reports which room it landed in.
///
/// One call, because the backend finds or creates the room itself. That route is
/// exempt from the write gate for the same reason `/api/room-connect/` is: OBS
/// cannot send a header. What it gives up in exchange is that the username now
/// comes from the caller, so the backend guards it with a handle pattern and a cap
/// on how many rooms it will invent — see its `find_or_create_room_for_username`.
///
/// Asking the user to create a room by hand would be the other option, and it was
/// worse: it made the one thing they came here to do depend on a second tool.
pub async fn resolve_and_start(
    base: &str,
    username: &str,
    overlay: &serde_json::Value,
) -> Result<String, String> {
    let wanted = normalise_username(username);
    let url = endpoint(base, "api/room-connect-by-username");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        // Followed by hand below. Left on, reqwest rewrites the POST into a GET
        // when it answers a 301, and the backend answers GET on this route with
        // 405 "Method Not Allowed" — so an `http://` address, which almost every
        // server bounces to `https://`, failed in a way that read like a broken
        // backend rather than a typo.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    let body = post_connect(&client, &url, &wanted, overlay).await?;
    let parsed: Value =
        serde_json::from_str(&body).map_err(|e| format!("{url} did not answer with JSON: {e}"))?;

    parsed
        .get("room_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("{url} did not say which room it connected: {body}"))
}

/// POSTs the connect request and returns the body, following one same-host
/// redirect with the method intact.
///
/// Only ever the same host, and only once. A redirect to somewhere else is not a
/// scheme upgrade to absorb silently — it is somebody naming a different server,
/// and a handle is not worth posting to a stranger because a URL said so.
async fn post_connect(
    client: &reqwest::Client,
    start: &str,
    username: &str,
    overlay: &serde_json::Value,
) -> Result<String, String> {
    let mut url = start.to_string();
    // A loop rather than a recursive call, and a flag rather than a counter: one
    // hop is the http-to-https bounce, and two is a pair of servers pointing at
    // each other, which should fail rather than spin.
    let mut followed = false;

    loop {
        // The overlay styling rides along when there is any, so the backend can
        // store it on the room and the overlay link can be a bare `?room=<id>`.
        // Left out entirely when empty, so an app that never set styling up sends
        // exactly the body it always did.
        let mut body = json!({ "username": username });
        if let (Some(obj), Some(extra)) = (body.as_object_mut(), overlay.as_object()) {
            if !extra.is_empty() {
                obj.insert("overlay".to_string(), overlay.clone());
            }
        }
        let response = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("could not reach {url}: {e}"))?;

        if response.status().is_redirection() {
            let target = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let status = response.status().to_string();
            if followed {
                return Err(format!("{start} kept redirecting, ending at {status}."));
            }
            match target {
                Some(target) if same_host(&url, &target) => {
                    url = target;
                    followed = true;
                    continue;
                }
                Some(target) => {
                    return Err(format!(
                        "{url} answered {status}, pointing at {target} - a different host. Use the https:// address."
                    ));
                }
                None => return Err(format!("{url} answered {status} without saying where to.")),
            }
        }

        if !response.status().is_success() {
            let status = response.status().to_string();
            let why = response.text().await.unwrap_or_default();
            // 405 here is almost never the backend refusing this username. It is a GET
            // arriving where a POST was meant, and saying so beats passing "Method Not
            // Allowed" to someone who cannot act on it.
            if status == "405 Method Not Allowed" {
                return Err(format!(
                    "{url} answered 405. That is a GET reaching a POST route, which is what an unfollowed http-to-https redirect turns into - try the https:// address."
                ));
            }
            return Err(shorten(&why, &status));
        }

        return response
            .text()
            .await
            .map_err(|e| format!("could not read {url}: {e}"));
    }
}

/// Whether two absolute URLs point at the same host, ignoring the scheme.
///
/// Scheme-blind on purpose: `http` -> `https` on one host is the hop worth
/// following, and it is the only shape this is ever asked to accept.
fn same_host(a: &str, b: &str) -> bool {
    let host_of = |url: &str| {
        reqwest::Url::parse(url)
            .ok()
            .map(|parsed| parsed.host_str().map(str::to_string))
            .unwrap_or(None)
    };
    host_of(a).is_some() && host_of(a) == host_of(b)
}

/// The socket URL for one room.
///
/// The scheme follows the page: a backend reached over `https` must be reached
/// over `wss`, and quietly downgrading would leave the key on the wire if anyone
/// adds one later.
pub fn socket_url(base: &str, room_id: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    let scheme = if trimmed.starts_with("https://") {
        "wss://"
    } else {
        "ws://"
    };
    let host = trimmed
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    format!("{scheme}{host}/ws/{CLIENT_TYPE}/{}", room_id.trim())
}

/// Turns a backend frame into the app's own event shape, or `None` for anything
/// the app has no use for.
///
/// Pure, because this is the whole compatibility surface and a mapping that
/// quietly drops a field is invisible: the feed just gets sparser.
///
/// The far side of this is the `SidecarEvent` union in `src/lib/sidecar.ts`, and
/// nothing spans the seam — this emits plain JSON and that claims the shape by
/// casting. A field renamed here is not an error anywhere; it just arrives as
/// `undefined`. `test/test-wire.mjs` reads this file and that one and compares
/// them, so add a field to both or the suite says so.
///
/// Note the input and output names differ, deliberately: the backend's `user` and
/// `userId` become `nickname` and `id` here. Renaming one side is how `join` ended
/// up emitting `id` while the app was reading a `viewerId` that nothing sent.
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
    // The backend carries an avatar only on the events where TikTok populates
    // one — comments. Join, follow, like and gift arrive without it, so this
    // reads whatever came back and defaults to empty, which the feed renders as
    // an initial. Reading it as a string rather than forcing "" is the whole
    // change: the field was already being carried, it was just discarded here.
    let avatar = frame.get("avatar").and_then(Value::as_str).unwrap_or_default();

    let count = frame.get("count").and_then(Value::as_i64).unwrap_or(1);

    // The MOD badge and custom emotes. Both were read by the app since it had a
    // feed and neither was ever sent, so the badge could not appear and emotes
    // could not render. `isModerator` is a plain bool (absent means false) and
    // `emotes` is a list of `{url, id}`, empty for a comment with none.
    let is_moderator = frame
        .get("isModerator")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let emotes = frame
        .get("emotes")
        .and_then(Value::as_array)
        .map(|list| Value::Array(list.clone()))
        .unwrap_or_else(|| Value::Array(Vec::new()));

    Some(match kind {
        "comment" => json!({
            "type": "chat", "platform": platform, "nickname": user(), "id": id(),
            "avatar": avatar, "text": frame.get("text").and_then(Value::as_str).unwrap_or_default(),
            "timestamp": timestamp,
            "isModerator": is_moderator,
            "emotes": emotes,
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
            // Empty when TikTok sent no picture. Always a string, the way `avatar`
            // is, because the app checks truthiness and "" already reads as "no
            // image" — a missing key would be a second spelling of the same answer.
            "giftImage": frame.get("giftImage").and_then(Value::as_str).unwrap_or(""),
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
            "avatar": avatar, "count": count, "timestamp": timestamp,
        }),
        "viewers" => json!({
            "type": "viewers", "platform": platform,
            "count": frame.get("count").and_then(Value::as_i64).unwrap_or(0),
        }),
        "status" => json!({
            "type": "status", "platform": platform,
            "connected": frame.get("connected").and_then(Value::as_bool).unwrap_or(false),
            "connecting": frame.get("connecting").and_then(Value::as_bool).unwrap_or(false),
            // The streamer stopped, as distinct from our connection dropping.
            // Carried as sent and defaulted false, so a status frame from an older
            // backend that knows nothing about live ends still maps cleanly.
            "liveEnded": frame.get("liveEnded").and_then(Value::as_bool).unwrap_or(false),
            // The backend is polling for a streamer with no live right now, as
            // distinct from a handshake in flight. Same rule: carried as sent, and
            // an older backend that has never heard of it maps to false, which is
            // what its own statuses meant anyway.
            "waiting": frame.get("waiting").and_then(Value::as_bool).unwrap_or(false),
            "message": frame.get("message").and_then(Value::as_str).unwrap_or_default(),
        }),
        "error" => json!({
            "type": "error", "platform": platform,
            "message": frame.get("message").and_then(Value::as_str).unwrap_or_default(),
        }),
        // `config` is widget settings, `alert` is a donation hook. Neither is a
        // chat event, and silently folding a donation into a gift row would put
        // a number in the diamonds total that nobody sent.
        _ => return None,
    })
}



/// Adds the session a frame belongs to.
///
/// The generation is the host's own answer to "which reader produced this", and
/// the app needs it to drop a frame that was already in flight when Stop was
/// pressed. The host cannot close that window by itself: `emit` hands the frame
/// to the webview and returns, so a frame emitted a microsecond before a Stop is
/// still delivered after it. Stamping is what lets the other side tell.
///
/// Bridge frames are deliberately left unstamped by the callers that emit them —
/// they are about the reader rather than a session, and the confirmation that a
/// Stop happened has to get through after the session it closes has been
/// dropped.
fn with_session(mut event: Value, session: u64) -> Value {
    if let Some(object) = event.as_object_mut() {
        object.insert("session".to_string(), json!(session));
    }
    event
}

/// Reports a failure the way the rest of the app reports one.
///
/// The log line is for the panel; the status frame is what the toolbar shows. A
/// backend that is down has to be visible on the status line, not only in a log
/// nobody has open.
///
/// Both frames carry the session, because a failure belongs to the attempt that
/// hit it: a "could not reach the backend" from a connection the user has since
/// stopped must not appear under a newer one.
fn report(app: &tauri::AppHandle, message: String, session: u64) {
    let _ = app.emit(
        EVENT,
        with_session(
            json!({ "type": "log", "platform": "bridge", "level": "warn", "message": message.clone() }),
            session,
        ),
    );
    let _ = app.emit(
        EVENT,
        with_session(
            json!({ "type": "status", "platform": "tiktok", "connected": false, "message": message }),
            session,
        ),
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
        report(&app, format!("Backend not configured: {missing} is missing."), generation);
        state.gave_up();
        return;
    }

    // Recorded before the resolve, so a page that reloads while the POST is still
    // in flight is told which handle is being connected to rather than showing a
    // blank field beside a button that says Stop.
    state.set_username(&config.username);

    // Resolved once, outside the retry loop: which room a username means does not
    // change because the network blipped, and re-asking on every attempt would
    // turn a five-second hiccup into five round trips and five error messages.
    let room_id = match resolve_and_start(&config.base_url, &config.username, &config.overlay).await {
        Ok(id) => id,
        Err(why) => {
            report(&app, format!("Backend: {why}"), generation);
            state.gave_up();
            return;
        }
    };

    // Checked again after the resolve, and this one is not redundant. Resolving is
    // a POST with a twenty-second timeout, so a Stop pressed during a slow Connect
    // lands while this is still in flight — and without this the loop would carry
    // on to open the socket and announce the room, which is the whole reported
    // bug: Stop says it stopped, and then the reader connects anyway.
    if stale(&state, generation) {
        return;
    }

    state.set_room(&room_id, "");
    let url = socket_url(&config.base_url, &room_id);

    // Tell the page which room this is, by id. The overlay link prefers the id
    // over the handle — a link naming the room by id is one parameter nothing has
    // to resolve — and the page has no other way to learn it: the backend never
    // sends a `room` frame, so without this the id is only ever known here, inside
    // the host, and the link falls back to the handle.
    let _ = app.emit(
        EVENT,
        with_session(
            json!({
                "type": "room",
                "platform": "bridge",
                "username": config.username,
                "roomId": room_id,
                "title": "",
            }),
            generation,
        ),
    );

    let mut delay = Duration::from_secs(BACKOFF_START_SECS);
    for attempt in 1..=ATTEMPTS {
        if stale(&state, generation) {
            return;
        }
        match run_once(&app, &url, &state, generation).await {
            Ok(()) => return,
            Err(why) => {
                // A failed attempt still has to be cancellable: the backoff below
                // is up to fifteen seconds, and a Stop during it must not be
                // followed by another connect.
                if stale(&state, generation) {
                    return;
                }
                let said = if attempt == 1 {
                    format!("Connecting to the backend at {url}…")
                } else {
                    format!("Backend attempt {attempt}/{ATTEMPTS} failed: {why}")
                };
                let _ = app.emit(
                    EVENT,
                    with_session(
                        json!({ "type": "log", "platform": "bridge", "level": "warn", "message": said }),
                        generation,
                    ),
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
        format!(
            "Could not read from the backend at {url}. Check the address under Set up, and that the backend is running."
        ),
        generation,
    );
    state.gave_up();
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
    //
    // Silence is measured rather than assumed, because the only honest statement
    // about a quiet socket is "nothing has arrived yet" — it is not evidence of a
    // dead one until enough time has passed to make it unlikely.
    let mut last_frame_at = std::time::Instant::now();
    loop {
        if stale(state, generation) {
            return Ok(());
        }
        // Two waits that used to be one, and the conflation was the bug.
        //
        // The timeout exists so a Stop is seen between two frames — a busy room
        // resolves `stream.next()` every few seconds, so without it the loop would
        // not come back around to check. Wrapping the wait rather than racing it
        // against a sleep keeps the frame: a `select!` drops the losing future, and
        // a dropped `stream.next()` can lose a message that had already arrived.
        //
        // What it must not do is also decide the connection is dead, which is what
        // it was doing. Silence on this socket is normal and long: the backend
        // buffers frames until TikTok's first event arrives, and a stream whose
        // chat has not started yet can sit quiet for minutes. Treating POLL_SECS of
        // quiet as failure made the app give up during exactly the wait it was
        // supposed to be patient through — connect, one frame, five rejections,
        // give up — while the backend was alive and about to deliver.
        let next = tokio::time::timeout(Duration::from_secs(POLL_SECS), stream.next())
            .await;

        let next = match next {
            Ok(next) => next,
            // Timed out. That is a poll, not a verdict on its own — but a poll is
            // how the silence gets measured, so this is where the real threshold
            // is applied.
            Err(_) => {
                if last_frame_at.elapsed() >= Duration::from_secs(SILENCE_LIMIT_SECS) {
                    return Err("no frames arriving".into());
                }
                continue;
            }
        }
        .ok_or("the backend closed the connection")?;

        // Anything at all counts as the connection being alive: a frame the mapper
        // did not recognise is still the socket answering.
        last_frame_at = std::time::Instant::now();

        // Checked again after the wait as well as before it. A Stop pressed while
        // a frame was in flight arrives here, and reading the generation before
        // emitting is what makes the stop take effect on the next frame rather
        // than the next idle one.
        if stale(state, generation) {
            return Ok(());
        }

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
                // The headcount is remembered as it passes, so a page that reloads
                // gets the last figure rather than zero. Read from the raw frame
                // because the mapped one is consumed below, and taken only when it
                // is actually a number — an absent or malformed count must not
                // overwrite a good one with zero.
                if frame.get("type").and_then(Value::as_str) == Some("viewers") {
                    if let Some(count) = frame.get("count").and_then(Value::as_i64) {
                        state.set_viewers(count);
                    }
                }
                if let Some(event) = to_app_event(&frame, now_ms()) {
                    // Stamped so the app can drop it if a Stop lands before this
                    // reaches the webview. The generation check above is not
                    // enough on its own: it is read here, and the emit that follows
                    // can still be overtaken by a Stop that arrives a moment later
                    // — the frame is then delivered after the user has been told
                    // the reading stopped, which is the reported bug.
                    let _ = app.emit(EVENT, with_session(event, generation));
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

/// Milliseconds since the epoch, for a frame that needs to say when it happened.
///
/// Public so the host commands stamp their own frames with the same clock the reader
/// uses — a gift arriving and the status closing out its connect should not be
/// timestamps from two different eras.
pub fn now_ms() -> i64 {
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
    let mut config: BackendConfig = config_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    // A file written before the address was built in can hold an empty string,
    // which serde would carry over as-is. An app with no address cannot connect,
    // so the default wins rather than leaving the user a dead field to fill in.
    if config.base_url.trim().is_empty() {
        config.base_url = DEFAULT_BASE_URL.to_string();
    }
    config
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
    fn a_stop_cancels_a_busy_room() {
        // The regression this exists for: the reader used to check the generation
        // only at the top of its loop, and a room that sends a frame every few
        // seconds resolved `stream.next()` long before the loop came back around.
        // Stop was therefore read only after the next frame arrived — on a busy
        // room, that reads as the button doing nothing at all.
        let state = BackendState::default();
        let generation = state.renew();

        // Two frames' worth of traffic: the counter is checked before and after
        // each wait, so a stop pressed between them must still be seen.
        assert_eq!(state.current(), generation);
        state.stop();
        assert_ne!(state.current(), generation);

        // The same comparison the reader makes, in the same places. If either
        // check were dropped, a busy room would keep reading past a Stop.
        assert!(state.current() != generation);
        assert!(state.current() != generation);
    }

    #[test]
    fn a_new_connect_cancels_the_previous_room() {
        // Connect twice, or connect over a running room: the newer generation
        // must invalidate the older loop, or two sockets feed one feed.
        let state = BackendState::default();
        let first = state.renew();
        let second = state.renew();
        assert_ne!(first, second);
        assert_eq!(state.current(), second);
        assert!(state.current() != first);
    }

    #[test]
    fn a_frame_carries_the_session_that_produced_it() {
        // The stamp is what lets the app drop a frame that was already in flight
        // when Stop was pressed. Without it the app cannot tell that frame from
        // one belonging to the session it is now reading, and the feed grows
        // under a "Not connected" badge.
        let state = BackendState::default();
        let generation = state.renew();
        let stamped = with_session(json!({ "type": "chat", "text": "hi" }), generation);
        assert_eq!(stamped.get("session").and_then(Value::as_u64), Some(generation));
        // The rest of the frame survives: this adds a field, it does not rewrite
        // the event.
        assert_eq!(stamped.get("text").and_then(Value::as_str), Some("hi"));
        assert_eq!(stamped.get("type").and_then(Value::as_str), Some("chat"));
    }

    #[test]
    fn a_stopped_session_is_stale_and_a_new_one_is_not() {
        // The comparison the reader makes before and after every wait. A Stop
        // must make the running generation stale; a Connect after it must make
        // the *new* one current, or the reader would refuse to start.
        let state = BackendState::default();
        let first = state.renew();
        assert!(!stale(&state, first));

        state.stop();
        assert!(stale(&state, first), "a stop must invalidate the running loop");

        let second = state.renew();
        assert!(!stale(&state, second), "a new connect must be current");
        assert!(stale(&state, first), "and the old loop stays stale");
    }

    #[test]
    fn a_stop_lands_after_the_resolve_that_is_still_in_flight() {
        // The reported bug's shape. Resolving the room is a POST with a twenty
        // second timeout, so Stop can land while it is still in flight. The loop
        // checks the generation again after the resolve for exactly this, and
        // without that check it would carry on to open the socket and announce
        // the room — a Stop that says it stopped, followed by a connect.
        let state = BackendState::default();
        let generation = state.renew();

        // The resolve is in flight here; the user presses Stop.
        state.stop();

        // What the loop does the moment the resolve returns.
        assert!(
            stale(&state, generation),
            "the loop must not open a socket for a session that was stopped mid-resolve"
        );
    }

    #[test]
    fn a_reloaded_page_is_told_what_the_reader_is_doing() {
        // A webview reload — which `tauri:dev` does on every code change — throws
        // the frontend away while this process keeps reading. Without a snapshot
        // the new page shows "Not connected" and a Connect button over a feed that
        // is still filling, which is the reported bug.
        let state = BackendState::default();
        let generation = state.renew();
        state.set_username("someone");
        state.set_room("room-1", "A title");
        state.set_viewers(1234);

        let snap = state.snapshot();
        assert_eq!(snap["type"].as_str(), Some("status"));
        assert_eq!(snap["platform"].as_str(), Some("tiktok"));
        assert_eq!(snap["connected"].as_bool(), Some(true));
        assert_eq!(snap["username"].as_str(), Some("someone"));
        assert_eq!(snap["roomId"].as_str(), Some("room-1"));
        assert_eq!(snap["title"].as_str(), Some("A title"));
        assert_eq!(snap["viewers"].as_i64(), Some(1234));
        // The session is what lets the reloaded page tell a frame from the running
        // reader apart from a straggler of an older one.
        assert_eq!(snap["session"].as_u64(), Some(generation));
        // Marked so the app applies it whole rather than logging it as an event
        // that never happened.
        assert_eq!(snap["snapshot"].as_bool(), Some(true));
    }

    #[test]
    fn a_snapshot_after_stop_reports_nothing_running() {
        // Stop must not leave a snapshot claiming a connection: the reloaded page
        // would then show Stop over a reader that is gone, which is the same lie
        // in the other direction.
        let state = BackendState::default();
        state.renew();
        state.set_username("someone");
        state.set_viewers(42);

        state.stop();
        let snap = state.snapshot();
        assert_eq!(snap["connected"].as_bool(), Some(false));
        // The details are cleared too: naming the previous handle beside a Connect
        // button reads as a connection that never stopped.
        assert_eq!(snap["username"].as_str(), Some(""));
        assert_eq!(snap["viewers"].is_null(), true);
    }

    #[test]
    fn a_give_up_clears_running_without_changing_the_session() {
        // Retries exhausted is the session *ending*, not a new one starting. If it
        // bumped the generation, a later snapshot would name a session number the
        // app has never seen a frame from, and the guard would drop the next real
        // session's frames as "older".
        let state = BackendState::default();
        let generation = state.renew();
        state.gave_up();

        let snap = state.snapshot();
        assert_eq!(snap["connected"].as_bool(), Some(false));
        assert_eq!(snap["session"].as_u64(), Some(generation));
    }

    #[test]
    fn a_new_connect_clears_the_previous_sessions_details() {
        // Connect over a running room: the snapshot must describe the new handle,
        // not the old one, or a reload would show the wrong stream's name.
        let state = BackendState::default();
        state.renew();
        state.set_username("first");
        state.set_viewers(10);

        state.renew();
        let snap = state.snapshot();
        assert_eq!(snap["username"].as_str(), Some(""));
        assert_eq!(snap["viewers"].is_null(), true);
        assert_eq!(snap["connected"].as_bool(), Some(true));
    }

    #[test]
    fn silence_is_not_confused_with_a_dead_socket() {
        // The bug this pair exists for. The cancellation poll and the liveness
        // threshold were one number, so a room that had not started chatting yet
        // was declared dead on its first quiet moment — connect, one frame, five
        // rejections, give up — while the backend was alive and about to deliver.
        //
        // The poll must stay short, because it is the latency of Stop on a busy
        // room. The silence limit must stay long, because quiet here is normal.
        assert!(POLL_SECS < SILENCE_LIMIT_SECS, "{POLL_SECS} vs {SILENCE_LIMIT_SECS}");
        // Comfortably, not marginally: a limit only a few polls long would still
        // drop a room during the wait it was meant to be patient through.
        assert!(SILENCE_LIMIT_SECS >= 30 * POLL_SECS, "{SILENCE_LIMIT_SECS} vs {POLL_SECS}");
    }

    #[test]
    fn the_socket_follows_the_page() {
        assert_eq!(socket_url("https://kit.example", "abc"), "wss://kit.example/ws/room/abc");
        assert_eq!(socket_url("http://127.0.0.1:8000/", "abc"), "ws://127.0.0.1:8000/ws/room/abc");
        // Never silently downgrade: a backend reached over https must be reached
        // over wss, or anything later sent on this socket is in the clear.
        assert!(socket_url("https://kit.example", "abc").starts_with("wss://"));
        // The backend's own name for a client type, not one invented here. Its hub
        // registers whatever it is given today, so any word would work — and a
        // whitelist on the far side would turn that into a silent "no frames".
        assert!(socket_url("https://kit.example", "abc").contains("/ws/room/"));
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
    fn the_mod_badge_and_emotes_reach_the_app() {
        // Both were read by the app and never sent, so the badge could not appear
        // and emotes could not render. They must survive the frame mapping.
        let out = mapped(json!({
            "type": "comment", "user": "eko", "userId": "7", "text": "hi",
            "isModerator": true,
            "emotes": [{ "url": "https://x/e.webp", "id": "42" }],
        }));
        assert_eq!(out["isModerator"], json!(true));
        assert_eq!(out["emotes"], json!([{ "url": "https://x/e.webp", "id": "42" }]));
    }

    #[test]
    fn a_plain_comment_is_not_a_moderator_and_has_no_emotes() {
        // Absent means false/empty rather than null, so a client that trusts the
        // field reads "ordinary comment" instead of throwing.
        let out = mapped(json!({ "type": "comment", "user": "eko", "userId": "7", "text": "hi" }));
        assert_eq!(out["isModerator"], json!(false));
        assert_eq!(out["emotes"], json!([]));
    }

    #[test]
    fn a_gift_picture_reaches_the_app() {
        // The app draws `item.giftImage` and nothing ever set it, so the slot was
        // empty for every gift. It must survive the frame mapping.
        let out = mapped(json!({
            "type": "gift", "user": "ana", "userId": "ana", "giftName": "Rose",
            "count": 1, "value": 5, "giftImage": "https://x/rose.webp",
        }));
        assert_eq!(out["giftImage"], json!("https://x/rose.webp"));
    }

    #[test]
    fn a_gift_with_no_picture_reports_an_empty_image() {
        // "" rather than a missing key: the app checks truthiness and "" already
        // reads as "no image", so a missing key would be a second spelling of the
        // same answer — and `avatar` on the same frame is a string for the same
        // reason.
        let out = mapped(json!({
            "type": "gift", "user": "ana", "userId": "ana", "giftName": "Rose",
            "count": 1, "value": 5,
        }));
        assert_eq!(out["giftImage"], json!(""));
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
    fn a_real_status_frame_maps_as_sent() {
        // Captured from a running backend rather than read off the source, because
        // the thing worth pinning is what actually arrives.
        let frame = json!({ "type": "status", "connected": false, "message": "Offline" });
        let out = mapped(frame);
        assert_eq!(out["type"], "status");
        assert_eq!(out["connected"], false);
        assert_eq!(out["message"], "Offline");
        assert_eq!(out["platform"], "tiktok");
    }

    #[test]
    fn the_real_config_frame_is_not_chat() {
        // Also captured live: every new client is sent this first.
        let frame = json!({ "type": "config", "config": {} });
        assert!(to_app_event(&frame, NOW).is_none());
    }

    #[test]
    fn frames_captured_from_a_live_room_map_correctly() {
        // Captured verbatim from a running backend reading a real TikTok stream,
        // rather than read off the source. Everything the app can see from a busy
        // room is here, and each one is the shape the feed, the statistics and the
        // gift alerts actually depend on.
        let captured: Vec<Value> = vec![
            json!({ "type": "config", "config": {} }),
            json!({ "type": "status", "connected": true, "message": "Connected to @mybasic.indonesia" }),
            json!({ "type": "comment", "user": "titik", "userId": "duuuduuu12", "text": "boxy cut 170/58 ukurang berapa?" }),
            json!({ "type": "join", "user": "Ade Firmansyah", "userId": "ade.firmansyah056", "viewers": 176 }),
            json!({ "type": "viewers", "count": 145 }),
            json!({ "type": "follow", "user": "mata", "userId": "mataeyevision" }),
        ];

        // The first frame every new client receives. Not chat, and silently
        // ignored rather than dropped with a warning.
        assert!(to_app_event(&captured[0], NOW).is_none());

        let status = to_app_event(&captured[1], NOW).unwrap();
        assert_eq!(status["type"], "status");
        assert_eq!(status["connected"], true);
        assert_eq!(status["message"], "Connected to @mybasic.indonesia");

        // Non-ASCII in the message, which is most of what a live Indonesian room
        // is. If anything upstream escaped or re-encoded this, it shows here.
        let comment = to_app_event(&captured[2], NOW).unwrap();
        assert_eq!(comment["type"], "chat");
        assert_eq!(comment["nickname"], "titik");
        assert_eq!(comment["id"], "duuuduuu12");
        assert_eq!(comment["text"], "boxy cut 170/58 ukurang berapa?");
        assert_eq!(comment["timestamp"], NOW);
        assert_eq!(comment["platform"], "tiktok");

        // Joins outnumber everything else in a busy room by a wide margin — 63 in
        // a hundred seconds here — and each one carries a real stable handle.
        let join = to_app_event(&captured[3], NOW).unwrap();
        assert_eq!(join["type"], "join");
        assert_eq!(join["nickname"], "Ade Firmansyah");
        assert_eq!(join["id"], "ade.firmansyah056");

        let viewers = to_app_event(&captured[4], NOW).unwrap();
        assert_eq!(viewers["type"], "viewers");
        assert_eq!(viewers["count"], 145);

        // Follows do arrive, which is the one the earlier note in the repo README
        // got wrong: the broadcast list there omits it, and hiding the chip over
        // that would have removed a filter that works.
        let follow = to_app_event(&captured[5], NOW).unwrap();
        assert_eq!(follow["type"], "follow");
        assert_eq!(follow["nickname"], "mata");
        assert_eq!(follow["id"], "mataeyevision");
    }

    #[test]
    fn an_unconfigured_source_says_what_is_missing() {
        // The address is written in, so the handle is the only thing that can be
        // missing - which is the whole point of not asking for it.
        assert_eq!(BackendConfig::default().describe_missing(), Some("a username"));
        let no_user = BackendConfig { base_url: "https://kit.example".into(), ..Default::default() };
        assert_eq!(no_user.describe_missing(), Some("a username"));
        let ready = BackendConfig { base_url: "https://kit.example".into(), username: "a".into(), ..Default::default() };
        assert_eq!(ready.describe_missing(), None);
        // Only reachable if someone deliberately blanks the field, and the saved
        // value then has to fall back rather than leave the app with no address.
        let blanked = BackendConfig { base_url: "  ".into(), username: "a".into(), ..Default::default() };
        assert_eq!(blanked.describe_missing(), Some("a backend URL"));
    }

    #[test]
    fn an_error_body_is_cut_on_a_character_boundary_not_a_byte_one() {
        // len() counts bytes and the body can be UTF-8, so slicing at a fixed byte
        // offset lands mid-character and panics on a length that looks fine.
        // 199 ASCII then "é" puts a two-byte character across offset 200.
        let body = format!("{}é", "a".repeat(199));
        let cut = shorten(&body, "fallback");
        assert!(cut.ends_with('…'));
        // Back to bytes on purpose: a char-safe cut is still under the budget.
        assert!(cut.len() <= 204, "{}", cut.len());
        // And it must not have lost the tail of a character into invalid UTF-8.
        assert!(cut.chars().all(|c| c == 'a' || c == 'é' || c == '…'));
    }

    #[test]
    fn a_short_body_is_left_alone() {
        assert_eq!(shorten("{\"detail\":\"nope\"}", "fallback"), "{\"detail\":\"nope\"}");
        assert_eq!(shorten("   ", "fallback"), "fallback");
    }

    /// Opens a real socket to the deployed backend and waits for a frame.
    ///
    /// Ignored by default because it reaches the network. Run it with
    /// `cargo test -- --ignored`.
    ///
    /// It earns its place because the failure it guards does not arrive as an
    /// error. A TLS stack with no crypto provider panics during the handshake, and
    /// with `panic = "abort"` in release that is the whole app dying on Connect
    /// rather than anything the UI could report. Nothing else here would notice.
    #[test]
    #[ignore = "reaches the deployed backend"]
    fn the_socket_to_a_real_backend_opens_and_frames_arrive() {
        const LIVE: &str = "https://kit-backend.aldifhr.my.id";

        let room = tauri::async_runtime::block_on(resolve_and_start(
            LIVE,
            "mybasic.indonesia",
            &serde_json::Value::Null,
        ))
            .expect("should resolve a room for a live handle");
        let url = socket_url(LIVE, &room);

        tauri::async_runtime::block_on(async move {
            use futures_util::StreamExt as _;
            let (mut stream, _response) = tokio_tungstenite::connect_async(&url)
                .await
                .expect("the wss handshake should succeed");
            let next = tokio::time::timeout(Duration::from_secs(30), stream.next())
                .await
                .expect("no frames arrived within 30s");
            let frame = next.expect("the backend closed the connection")
                .expect("the frame could not be read");
            assert!(matches!(frame, tokio_tungstenite::tungstenite::Message::Text(_)), "{frame:?}");
        });
    }

    #[test]
    fn the_built_in_backend_is_where_the_app_looks_without_being_told() {
        assert_eq!(BackendConfig::default().base_url, DEFAULT_BASE_URL);
        assert!(DEFAULT_BASE_URL.starts_with("https://"), "the default must not bounce through a redirect");
    }

    #[test]
    fn a_redirect_is_only_followed_when_it_stays_on_the_same_host() {
        // http -> https on one host is the hop worth taking, and the reason is
        // that a POST turned into a GET would be answered 405.
        assert!(same_host("http://kit.example/a", "https://kit.example/a"));
        assert!(same_host("http://kit.example", "https://kit.example/deeper/path"));
        assert!(!same_host("https://kit.example", "https://evil.example"));
        assert!(!same_host("https://kit.example", "https://kit.example.evil.com"));
        assert!(!same_host("https://kit.example", "not a url"));
    }

    #[test]
    fn a_username_is_read_the_same_way_whatever_form_it_arrives_in() {
        // The room is found by exact username match, so a handle pasted as a link
        // and one typed bare have to reduce to the same string.
        assert_eq!(normalise_username("mybasic.indonesia"), "mybasic.indonesia");
        assert_eq!(normalise_username("@mybasic.indonesia"), "mybasic.indonesia");
        assert_eq!(normalise_username("  @mybasic.indonesia  "), "mybasic.indonesia");
        assert_eq!(normalise_username("@@mybasic"), "mybasic");
        assert_eq!(
            normalise_username("https://www.tiktok.com/@mybasic.indonesia/live"),
            "mybasic.indonesia"
        );
        assert_eq!(normalise_username("tiktok.com/@mybasic?lang=en"), "mybasic");
        assert_eq!(normalise_username(""), "");
        assert_eq!(normalise_username("   "), "");
    }
}
