//! The host.
//!
//! The app does not talk to TikTok itself. It reads a StreamKit backend, which
//! does that, and re-emits what it receives as Tauri events so the webview has
//! one vocabulary regardless of where the frames came from.

// Without this the app is a console-subsystem binary, so double-clicking it
// flashes a command prompt window behind the UI and leaves one attached for the
// whole session. Release builds only — in debug the console is where the Rust
// side's diagnostics go.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod llm;
mod overlay;
mod sound;
mod speech;
mod webhook;

use std::sync::Arc;

use tauri::{Emitter as _, Manager, State};
use tauri_plugin_notification::NotificationExt;
use serde_json::json;

pub struct AppState {
    /// Which backend reader loop is current, so a new Connect cancels the old one.
    backend: Arc<backend::BackendState>,
}

/// Hides the window without stopping the stream.
#[tauri::command]
fn minimize_to_tray(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// Keeps the window above others, for reading it on a second monitor.
#[tauri::command]
fn set_always_on_top(app: tauri::AppHandle, on_top: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(on_top);
    }
}

/// A desktop toast.
///
/// Built here rather than called from the webview so the notification plugin
/// needs no capability and no JavaScript package: the frontend names what
/// happened, the host decides whether Windows is in a state to show it.
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// The models an OpenAI-compatible endpoint offers.
///
/// Returns the ids, already sorted and de-duplicated, so the frontend has a
/// dropdown rather than something to clean up. Errors come back as a message
/// worth reading: "wrong host" and "wrong key" are the two things that actually go
/// wrong, and the user can only fix whichever one they are told about.
#[tauri::command]
async fn llm_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    match llm::list_models(&base_url, &api_key).await {
        Ok(ids) => Ok(ids),
        Err(llm::EndpointError::Unreachable(why)) => Err(format!("could not reach {base_url}: {why}")),
        Err(llm::EndpointError::Refused(why)) => Err(why),
    }
}

/// The stored endpoint settings, or a reason there are none.
///
/// Shared by both AI commands because the credential is the reason this side owns
/// the request at all: the endpoint, the key and the model are read from disk here
/// rather than sent in by the page, so a key never travels anywhere but the config
/// file and the socket. The three checks are the same for every caller, and a
/// feature that answered "no endpoint configured" in one shape and "set one up
/// first" in another is a feature whose error message cannot be quoted.
fn configured_llm(app: &tauri::AppHandle) -> Result<llm::LlmConfig, String> {
    let config = llm::read_config(app);
    if config.base_url.trim().is_empty() || config.api_key.trim().is_empty() {
        return Err("no endpoint configured — set one up under Model first".into());
    }
    if config.model.trim().is_empty() {
        return Err("no model selected — pick one under Model first".into());
    }
    Ok(config)
}

/// Sends one batch of messages and returns what the model made of them.
///
/// The page decides which messages go out and numbers them; this side only sends
/// them. That split is what keeps the feature cheap — a busy room would otherwise
/// spend a request per message — and it keeps the mapping from an answer back onto
/// rows where the rows live.
///
/// `count` is how many were sent. It is passed separately rather than derived from
/// `messages` because the page caps a batch below the prompt's own limit, and an
/// index outside the batch has to be dropped rather than acted on.
#[tauri::command]
async fn llm_moderate(
    app: tauri::AppHandle,
    messages: Vec<String>,
    rules: String,
    count: usize,
) -> Result<Vec<llm::Verdict>, String> {
    if messages.is_empty() {
        return Err("nothing to moderate".into());
    }
    // The page's own number, capped to what it sent: an out-of-range index must
    // not name a row, and a wrong `count` here would widen or narrow what is
    // considered real.
    let count = count.min(messages.len());

    let config = configured_llm(&app)?;

    let batch = messages.join("\n");
    let extra = rules.trim();
    let mut system = String::from(
        "You moderate a live chat. Each line is one message, numbered from 1, as \
         \"number: nickname: text\".\n\n\
         Flag a message only when it would be harmful in a public live chat: \
         harassment, slurs or hate, threats, sexual content involving minors, \
         doxxing, or spam and scam links. Ordinary disagreement, jokes, swearing \
         and plain rudeness are not harmful here.\n\n\
         Answer with JSON and nothing else — no prose, no code fence: \
         {\"flagged\":[{\"index\":<number>,\"label\":\"<short category>\",\
         \"reason\":\"<why, one sentence>\"}]}\n\
         \"flagged\" is an empty list when every message is fine.",
    );
    if !extra.is_empty() {
        // The user's own rules, appended rather than substituted: they narrow what
        // the model was told, and a streamer who says "swearing is fine here" is
        // correcting the default rather than replacing the reasoning behind it.
        system.push_str("\n\nThe streamer adds these rules for this room, which take precedence:");
        system.push_str("\n");
        system.push_str(extra);
    }

    let messages = vec![llm::Turn::system(system), llm::Turn::user(batch)];
    let answer = match llm::chat(&config.base_url, &config.api_key, &config.model, &messages).await {
        Ok(answer) => answer,
        Err(llm::EndpointError::Unreachable(why)) => {
            return Err(format!("could not reach {}: {why}", config.base_url))
        }
        Err(llm::EndpointError::Refused(why)) => return Err(why),
    };

    Ok(llm::parse_verdicts(&answer, count))
}

/// Asks the model whether it has anything to say, and returns what it said.
///
/// `None` is a real answer and the common one — the prompt asks for it by name,
/// because a model that answers every time it is offered the room is spam with a
/// latency. The page decides how often to offer it; this decides whether to take
/// it.
///
/// `topic` is what the stream is: a title and a handle go a long way towards an
/// answer that is about this room rather than about live chat in general.
#[tauri::command]
async fn llm_autoreply(
    app: tauri::AppHandle,
    context: Vec<String>,
    topic: String,
    persona: String,
) -> Result<Option<String>, String> {
    let config = configured_llm(&app)?;

    let transcript = if context.is_empty() {
        "(the chat is empty)".to_string()
    } else {
        context.join("\n")
    };

    let stream = topic.trim();
    let mut system = String::from(
        "You are the co-host of a live stream, talking to viewers in the chat as \
         yourself.\n\n\
         Be brief: one or two sentences, and never mention that you are an AI. \
         Answer a viewer's question when they ask one, say nothing when there is \
         nothing to say. Reply only when a viewer has asked something worth \
         answering or the room has gone quiet enough to need a nudge — most of \
         the time the right answer is to stay quiet.\n\n\
         Answer with JSON and nothing else — no prose, no code fence: \
         {\"reply\":\"what to post\"} to speak, or {\"reply\":null} to stay quiet.",
    );
    let extra = persona.trim();
    if !extra.is_empty() {
        system.push_str(
            "\n\nThe streamer has asked you to behave like this, which takes precedence:",
        );
        system.push_str("\n");
        system.push_str(extra);
    }

    let mut user = String::new();
    if !stream.is_empty() {
        user.push_str("The stream: ");
        user.push_str(stream);
        user.push_str("\n\n");
    }
    user.push_str("Chat so far, one message per line as \"nickname: text\":\n");
    user.push_str(&transcript);
    user.push_str("\n\nSpeak now.");

    let messages = vec![llm::Turn::system(system), llm::Turn::user(user)];
    let answer = match llm::chat(&config.base_url, &config.api_key, &config.model, &messages).await {
        Ok(answer) => answer,
        Err(llm::EndpointError::Unreachable(why)) => {
            return Err(format!("could not reach {}: {why}", config.base_url))
        }
        Err(llm::EndpointError::Refused(why)) => return Err(why),
    };

    Ok(llm::parse_reply(&answer))
}

/// Asks the configured model one trivial question, and returns what it said.
///
/// The check for "does my LLM work", which until now had no answer anywhere in
/// the app. Fetching the model list proves the address and the key; it says
/// nothing about whether a completion comes back, which is a different failure —
/// a proxy that lists models and then refuses to answer, a model name the
/// endpoint accepts in a list and not in a request, a quota that ran out.
///
/// What it returns is the model's own words. "OK" is the prompt, not the answer:
/// any model can be asked to say one word, and the reply is whatever the
/// endpoint actually produced, so a reply that is empty or an error message is
/// visible rather than inferred.
///
/// Deliberately not given a token limit. `max_tokens` is the obvious way to make
/// this cheap and it is not portable — providers disagree about whether it is
/// accepted, and some want the newer name instead — so a check that failed on
/// the parameter would be reporting a problem with the check. One word in, one
/// word out, is a few hundredth of a cent whichever way the provider spells it.
#[tauri::command]
async fn llm_test(app: tauri::AppHandle) -> Result<String, String> {
    let config = configured_llm(&app)?;

    let messages = vec![
        llm::Turn::system("Answer with one word and nothing else."),
        llm::Turn::user("Reply with exactly this word: ok"),
    ];

    // Twenty seconds, not the two minutes a real question gets. This is a check,
    // and a check that hangs for two minutes is worse than one that gives up: the
    // person pressing it is waiting to find out whether to go live.
    let started = std::time::Instant::now();
    match llm::chat_within(&config.base_url, &config.api_key, &config.model, &messages, 20).await {
        Ok(answer) => {
            let took = started.elapsed().as_secs_f32();
            // Timed in the answer rather than returned separately: the elapsed
            // time is only ever read next to what was said, and a caller that has
            // to hold both in step is a caller that will eventually show one
            // without the other.
            Ok(format!("{answer}  ({took:.1}s)"))
        }
        Err(llm::EndpointError::Unreachable(why)) => {
            Err(format!("could not reach {}: {why}", config.base_url))
        }
        Err(llm::EndpointError::Refused(why)) => Err(why),
    }
}

/// The stored endpoint settings, or an empty one on first launch.
#[tauri::command]
fn llm_config_get(app: tauri::AppHandle) -> llm::LlmConfig {
    llm::read_config(&app)
}

/// Saves the endpoint settings.
///
/// The API key is one of the three fields, and it is here rather than in the
/// page's storage for that reason: `localStorage` is readable by whatever script
/// ends up running in the webview, and this is a credential.
#[tauri::command]
fn llm_config_save(app: tauri::AppHandle, config: llm::LlmConfig) -> Result<(), String> {
    llm::write_config(&app, &config)
}

/// Forgets the key, the model and the URL alike.
#[tauri::command]
fn llm_config_clear(app: tauri::AppHandle) -> Result<(), String> {
    llm::clear_config(&app)
}

/// Opens the stream in the default browser.
///
/// Refused by host rather than by the page: the webview is what asks, and an
/// opener that takes whatever it is given is an opener that will eventually be
/// handed something worse. `llm::is_watchable` is the whole rule, and it lives
/// beside the rest of the code the page cannot edit.
#[tauri::command]
fn open_stream(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt as _;
    if !llm::is_watchable(&url) {
        return Err(format!("refusing to open {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("could not open a browser: {e}"))
}

/// Opens a file picker and returns the chosen sound file's path.
///
/// Empty string when the user cancels, so the page can tell "no pick" from "a
/// pick" without treating a cancellation as an error. The path is handed back
/// rather than the bytes: the file stays where it is and the page reads it when
/// the sound fires, which is how a large file avoids being held in memory for a
/// sound that may never play.
#[tauri::command]
async fn pick_sound_file(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt as _;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Audio", &["mp3", "wav", "ogg", "m4a", "flac", "aac"])
        .pick_file(move |chosen| {
            // A cancelled dialog sends nothing; the receiver gets a dropped
            // sender, which reads as an error below and becomes an empty path.
            let _ = tx.send(chosen);
        });
    let chosen = match rx.await {
        Ok(Some(path)) => path,
        // Cancelled, or the sender went away: both mean "no file chosen", which
        // is not a failure the user has to act on.
        _ => return Ok(String::new()),
    };
    // The path is registered with the asset protocol so the webview can load it,
    // then handed back as a path: the page converts it with `convertFileSrc` at
    // play time. Doing the conversion here instead would put a URL where the
    // setting stores a file, and the setting has to survive a restart.
    let path = chosen.as_path().ok_or_else(|| "not a local file".to_string())?;
    // Remembered host-side, because the asset scope is rebuilt empty on every
    // launch and the page's own storage cannot grant itself anything. Without
    // this the chosen sound works until the next restart and then silently stops.
    sound::write_config(
        &app,
        &sound::SoundConfig {
            path: path.to_string_lossy().into_owned(),
        },
    )?;
    let _ = app.asset_protocol_scope().allow_file(path);
    Ok(chosen.to_string())
}

/// Reads a line of chat aloud with the neural voice, and returns MP3 bytes.
///
/// The audio comes back to the page rather than being played here: the page owns
/// the one AudioContext every other sound goes through, and a second audio path in
/// the host would put the voice at its own volume, on its own clock, unable to be
/// silenced by the same control as the rest.
///
/// Base64 because the bytes cross as a JSON string — Tauri's command channel is
/// not a binary one, and a `Vec<u8>` would arrive as an array of numbers, four
/// times the size.
#[tauri::command]
async fn speak(text: String) -> Result<String, String> {
    use base64::Engine as _;

    let said = text.trim();
    if said.is_empty() {
        return Err("nothing to say".into());
    }

    // The connection is opened per utterance and dropped after. A chat line is a
    // few hundred milliseconds of speech and the gap between messages is longer
    // than a handshake, so holding one open would idle a socket for no gain; the
    // cost that mattered — decoding, not connecting — is paid either way.
    let voice = speech::Speech::connect()
        .await
        .map_err(|e| e.to_string())?;
    let audio = voice.say(said).await.map_err(|e| e.to_string())?;

    Ok(base64::engine::general_purpose::STANDARD.encode(audio))
}

/// The stored webhook settings.
#[tauri::command]
fn webhook_config_get(app: tauri::AppHandle) -> webhook::WebhookConfig {
    webhook::read_config(&app)
}

/// Saves them.
#[tauri::command]
fn webhook_config_save(app: tauri::AppHandle, config: webhook::WebhookConfig) -> Result<(), String> {
    webhook::write_config(&app, &config)
}

/// Sends one test gift to the configured URL, and reports what came back.
///
/// The only webhook call whose result the user sees. Everything else fires on a gift
/// and logs quietly, because a failed integration must not be able to interrupt a
/// stream — but a URL typed into a settings box has no other way to find out whether
/// it was right, and "saved" is not evidence of anything.
#[tauri::command]
async fn webhook_test(app: tauri::AppHandle) -> Result<String, String> {
    let config = webhook::read_config(&app);
    if config.url.trim().is_empty() {
        return Err("no webhook URL configured".into());
    }

    let gift = webhook::GiftPayload {
        nickname: "Test".into(),
        user_id: "test".into(),
        gift_name: "Rose".into(),
        count: 1,
        diamonds: 1,
        timestamp: backend::now_ms(),
    };

    webhook::send_gift(&config, &gift)
        .await
        .map(|()| "Sent. The receiving app should have it now.".to_string())
        .map_err(|e| e.to_string())
}

/// Sends one gift to the configured webhook.
///
/// The gift arrives from the page, but the URL and the token do not: they are read
/// from disk here. That split is the point — a credential handed to the page in
/// order to be used is a credential the page can leak.
#[tauri::command]
async fn webhook_send(app: tauri::AppHandle, gift: webhook::GiftPayload) -> Result<(), String> {
    let config = webhook::read_config(&app);
    if !config.enabled {
        return Ok(());
    }
    webhook::send_gift(&config, &gift)
        .await
        .map_err(|e| e.to_string())
}

/// The stored backend settings, or an empty one on first launch.
#[tauri::command]
fn backend_config_get(app: tauri::AppHandle) -> backend::BackendConfig {
    backend::read_config(&app)
}

/// Saves them.
#[tauri::command]
fn backend_config_save(app: tauri::AppHandle, config: backend::BackendConfig) -> Result<(), String> {
    backend::write_config(&app, &config)
}

/// Starts reading from the backend.
///
/// Cancels any loop already running, so Connect twice does not leave two sockets
/// open feeding the same feed. Returns as soon as the pump is spawned — it
/// connects, retries and eventually gives up on its own, and none of that should
/// hold up the UI thread that asked for it.
#[tauri::command]
fn backend_connect(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    config: backend::BackendConfig,
) -> Result<(), String> {
    if let Some(missing) = config.describe_missing() {
        return Err(format!("backend not configured: {missing} is missing"));
    }
    let generation = state.backend.renew();
    let shared = Arc::clone(&state.backend);
    tauri::async_runtime::spawn(async move {
        backend::pump(app, config, shared, generation).await;
    });
    Ok(())
}

/// Stops reading from the backend.
///
/// Emits a status frame before cancelling, because a stop that only closes the
/// socket is a stop with no record: the reader loop ends, nothing is said, and the
/// log shows connections appearing and never ending — which reads as a feed that
/// hung rather than one that was stopped on purpose. The frontend levels this as
/// `warn` on a `connected: false`, so it lands in the log beside the connects it
/// closes out.
#[tauri::command]
fn backend_disconnect(state: State<'_, AppState>, app: tauri::AppHandle) {
    let _ = app.emit(
        backend::EVENT,
        json!({ "type": "status", "platform": "bridge", "connected": false, "message": "Disconnected" }),
    );
    state.backend.stop();
}

/// The overlay page, for the URL a streamer puts in OBS.
///
/// Built here rather than in the page because the two facts it needs are not the
/// page's: the backend address lives in a config file and the handle the user
/// typed lives in the toolbar's state. Everything else travels in the URL, so
/// this is a URL with the two parts the page could not know appended — and
/// `base` is left out entirely when it is the default, because a link with a
/// parameter in it that everybody has is a link nobody reads.
///
/// `room_id` is accepted but not used: a bare `?room=<id>` link depends on the
/// styling having been stored on the room, and when it has not, the link renders
/// at the page's defaults — a different overlay from the one configured. The
/// handle link carries the look in itself, so it is right either way. Kept in the
/// signature so the command's shape does not churn for the page that calls it.
#[tauri::command]
fn overlay_url(app: tauri::AppHandle, username: String, style: OverlayStyle, _room_id: Option<String>) -> String {
    let config = backend::read_config(&app);
    let base = normalise_base(&config.base_url);
    // Served from the backend, not from this app's loopback port. The overlay page
    // opens its own socket to the backend anyway, so the only thing OBS needs to
    // reach is the backend — which means a browser source can live on any machine,
    // not just the one running the app. The loopback server still exists for the
    // preview and the local case, but the URL handed out points at the domain.
    let mut url = format!("{}/overlay/", base.trim_end_matches('/'));

    let mut query: Vec<String> = Vec::new();
    // The handle names the room and the styling travels with it — a link that is
    // one readable line describing exactly what is on screen. The room id is not
    // used here: a bare `?room=<id>` link depends on the styling having been
    // stored on the room, and when it has not, the link renders at the page's
    // defaults — which is a different overlay from the one configured. The handle
    // link carries the look in itself, so it is right whether or not anything was
    // stored.
    let handle = username.trim().trim_start_matches('@').to_string();
    if !handle.is_empty() {
        query.push(format!("room={}", encode_component(&handle)));
    }
    if base != backend::DEFAULT_BASE_URL {
        query.push(format!("base={}", encode_component(&base)));
    }
    for (key, value) in [
        ("size", style.size.to_string()),
        ("max", style.max.to_string()),
        ("delay", style.delay.to_string()),
        ("bg", format!("{:.2}", style.bg)),
        ("name", encode_component(&style.name_colour)),
        ("color", encode_component(&style.text_colour)),
        ("font", encode_component(&style.font)),
    ] {
        query.push(format!("{key}={value}"));
    }

    if !query.is_empty() {
        url.push('?');
        url.push_str(&query.join("&"));
    }
    url
}

/// Opens the overlay page in the user's browser.
///
/// A separate command from `open_stream` rather than a second entry in its rule.
/// That rule is "TikTok and nothing else" and the overlay is not TikTok; widening
/// it would mean loosening the one rule that exists to be narrow, and the page
/// would gain the ability to open any address on the loopback interface. Here the
/// rule is this app's own overlay and nothing else, checked in `overlay::is_own_page`
/// because the URL arrives from the page.
///
/// The host does this rather than the webview calling `window.open`: the app's
/// content security policy does not permit the page to navigate anywhere, and the
/// page asking for a new window is not something the platform will grant it.
#[tauri::command]
fn overlay_open(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt as _;
    // Two origins count as the overlay now: the loopback server and the backend's
    // /overlay/ path. The backend prefix is built here from the saved config, the
    // same address `overlay_url` hands out, so the preview and the copied link
    // open under the same rule.
    let base = normalise_base(&backend::read_config(&app).base_url);
    let backend_prefix = format!("{}/overlay/", base.trim_end_matches('/'));
    if !overlay::is_own_page(&url, &backend_prefix) {
        return Err(format!("refusing to open {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("could not open a browser: {e}"))
}

/// Whether the overlay server is actually answering.
///
/// A poll rather than a flag, because "the port is bound" and "the port is mine"
/// are different claims: something else on the machine can hold 4319, and a
/// streamer who has been told the overlay is ready and then watches nothing is
/// worse off than one who is told it is not.
#[tauri::command]
async fn overlay_running() -> bool {
    let url = format!("http://127.0.0.1:{}/health", overlay::PORT);
    match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(client) => matches!(client.get(url).send().await, Ok(response) if response.status().is_success()),
        Err(_) => false,
    }
}

/// The styling a link carries, narrowed to the types the page understands.
///
/// Narrowed here because this comes from the page and `url` pastes most of it
/// into a URL: a colour of `red; background: url(...)` is a query parameter that
/// the page would put straight into a style attribute.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStyle {
    #[serde(default = "default_overlay_size")]
    size: u32,
    #[serde(default = "default_overlay_max")]
    max: u32,
    #[serde(default = "default_overlay_delay")]
    delay: u32,
    #[serde(default)]
    bg: f32,
    #[serde(default = "default_name_colour")]
    name_colour: String,
    #[serde(default = "default_text_colour")]
    text_colour: String,
    #[serde(default = "default_overlay_font")]
    font: String,
}

fn default_overlay_size() -> u32 {
    22
}
fn default_overlay_max() -> u32 {
    8
}
fn default_overlay_delay() -> u32 {
    500
}
fn default_name_colour() -> String {
    "#ffd76a".into()
}
fn default_text_colour() -> String {
    "#ffffff".into()
}
fn default_overlay_font() -> String {
    // The double quotes are part of the value: this is a font *stack*, and CSS
    // only treats a multi-word family name as one name when it is quoted.
    r#""Segoe UI", system-ui, sans-serif"#.into()
}

/// Percent-encodes the few characters that would otherwise end a query value.
fn encode_component(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            // Space as `+` rather than `%20` because that is what a form encodes
            // it as, and the font stack is mostly spaces.
            ' ' => "+".to_string(),
            other => other
                .to_string()
                .bytes()
                .map(|b| format!("%{b:02X}"))
                .collect::<String>(),
        })
        .collect()
}

fn normalise_base(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        backend::DEFAULT_BASE_URL.to_string()
    } else {
        trimmed.to_string()
    }
}

/// The tray icon and its menu.
///
/// Exists because closing the window now only hides it � without somewhere to
/// reach the app from, that would leave no way to bring it back or to quit.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let builder = TrayIconBuilder::with_id("main")
        .tooltip("TikTok Live Chat")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                // Stops the reader before exiting so the socket is closed
                // deliberately rather than being torn down with the process.
                if let Some(state) = app.try_state::<AppState>() {
                    state.backend.stop();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });

    // `TrayIconBuilder` starts with no image and never falls back to the window's
    // own, so without this the tray entry is a blank square in a row of icons —
    // and the tray is the only way back into an app whose close button only
    // hides it. Taken from the bundle's icon rather than a second copy of the
    // file, so the tray and the taskbar cannot drift apart.
    let builder = match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone()),
        None => builder,
    };

    // Shown only on Windows, where a tray icon is the normal way to reach a
    // running app. Elsewhere the window close button is left alone.
    if cfg!(windows) {
        builder.build(app)?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState {
            backend: Arc::new(backend::BackendState::default()),
        })
        .invoke_handler(tauri::generate_handler![
        minimize_to_tray,
        set_always_on_top,
        notify,
        llm_models,
        llm_moderate,
        llm_autoreply,
        llm_test,
        llm_config_get,
        llm_config_save,
        llm_config_clear,
        open_stream,
        speak,
        pick_sound_file,
        webhook_config_get,
        webhook_config_save,
        webhook_test,
        webhook_send,
        backend_config_get,
        backend_config_save,
        backend_connect,
        backend_disconnect,
        overlay_url,
        overlay_open,
        overlay_running
    ])
        .setup(|app| {
            // Closing the window hides it rather than ending the app, so a stream keeps
            // being read while the window is out of the way. The tray is where it
            // comes back from, and where quitting actually lives.
            build_tray(app.handle())?;

            // Re-grants the sound chosen last run, and only that one file. The
            // asset scope is empty on a fresh launch, so without this a saved
            // custom sound would stop playing after a restart.
            sound::regrant(app.handle());

            // The overlay server, started whether or not anybody is going to use
            // it — the URL a streamer copies has to be true at the moment they
            // copy it, and asking them to start it first is a step that gets
            // forgotten until the stream is about to begin.
            //
            // Spawned rather than awaited, and a failure is reported rather than
            // propagated: a port already in use is something the streamer needs to
            // know about and can fix, and it must not be the reason the app does
            // not open.
            let handle_for_overlay = app.handle().clone();
            let overlay_config = backend::read_config(app.handle());
            tauri::async_runtime::spawn(async move {
                let defaults = overlay::OverlayDefaults {
                    base_url: normalise_base(&overlay_config.base_url),
                    username: overlay_config.username,
                    port: overlay::PORT,
                };
                if let Err(why) = overlay::serve(defaults).await {
                    let _ = handle_for_overlay.emit(
                        overlay::EVENT,
                        serde_json::json!({
                            "type": "log",
                            "platform": "bridge",
                            "level": "warn",
                            "message": format!("chat overlay is not serving: {why}")
                        }),
                    );
                }
            });

            let handle = app.handle().clone();
            if let Some(window) = app.get_webview_window("main") {
                // Cloned so the handler can hold it while `window` is still
                // borrowed by the match arm that hides it.
                let hideable = window.clone();
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = hideable.hide();
                    }
                    // The app being killed outright, where nothing else gets to run.
                    tauri::WindowEvent::Destroyed => {
                        if let Some(state) = handle.try_state::<AppState>() {
                            state.backend.stop();
                        }
                    }
                    _ => {}
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the application");
}

#[cfg(test)]
mod overlay_url_tests {
    use super::*;

    fn style() -> OverlayStyle {
        OverlayStyle {
            size: 22,
            max: 8,
            delay: 500,
            bg: 0.0,
            name_colour: "#ffd76a".into(),
            text_colour: "#ffffff".into(),
            font: r#""Segoe UI", system-ui, sans-serif"#.into(),
        }
    }

    /// Every field the settings dialog has, with a value of its own.
    ///
    /// Distinct on purpose: a builder that quietly left one out still produces a
    /// URL, and a field that is always the default looks exactly like one that
    /// works until somebody changes it.
    fn every_field_is_in(url: &str) {
        assert!(url.contains("size=22"), "size missing from {url}");
        assert!(url.contains("max=8"), "max missing from {url}");
        assert!(url.contains("delay=500"), "delay missing from {url}");
        assert!(url.contains("name=%23ffd76a"), "name missing from {url}");
        assert!(url.contains("color=%23ffffff"), "text colour missing from {url}");
        assert!(url.contains("font=%22Segoe+UI%22%2C+system-ui%2C+sans-serif"), "font missing from {url}");
    }

    #[test]
    fn a_style_becomes_a_query_string_the_page_can_read() {
        let mut query = Vec::new();
        for (key, value) in [
            ("size", "22".to_string()),
            ("max", "8".to_string()),
            ("delay", "500".to_string()),
            ("name", encode_component(&style().name_colour)),
            ("color", encode_component(&style().text_colour)),
            ("font", encode_component(&style().font)),
        ] {
            query.push(format!("{key}={value}"));
        }
        let url = format!("http://127.0.0.1:{}/?{}", overlay::PORT, query.join("&"));
        every_field_is_in(&url);
        // And the host is willing to open what it built, which is the preview's
        // own rule — so this also checks the URL is one it considers its own.
        assert!(overlay::is_own_page(&url, ""), "{url}");
    }

    #[test]
    fn a_colour_is_encoded_rather_than_bare() {
        // A `#` in a query string starts a fragment. Unencoded, the page reads
        // `ffd76a` as the fragment and the colour comes back as the default, which
        // is the setting looking like it did nothing.
        assert_eq!(encode_component("#ffd76a"), "%23ffd76a");
        assert_eq!(encode_component("a#b?c&d=e"), "a%23b%3Fc%26d%3De");
    }

    #[test]
    fn a_font_stack_is_encoded_as_one_value() {
        // The default is full of commas and quotes. A comma is the separator, so
        // an unencoded stack arrives as a dozen parameters rather than one.
        let encoded = encode_component(&style().font);
        assert!(!encoded.contains(','), "a comma survived: {encoded}");
        assert!(!encoded.contains('"'), "a quote survived: {encoded}");
        assert_eq!(encoded, "%22Segoe+UI%22%2C+system-ui%2C+sans-serif");
    }

    #[test]
    fn an_at_sign_is_off_a_handle() {
        // `@ana` and `ana` are the same room to the backend, and a room named
        // "@ana" is not one.
        assert_eq!("@ana".trim().trim_start_matches('@'), "ana");
    }
}
