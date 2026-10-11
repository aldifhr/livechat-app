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
mod sound;
mod speech;

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

/// Asks the configured model a question about the room.
///
/// The endpoint, the key and the model are read from disk here rather than sent in
/// by the page, so the credential travels from the config file to the socket and
/// nowhere else. It is the one asymmetry with `llm_models`, which has to take them
/// from the page because its whole job is to test settings the user has not saved
/// yet; nothing here is worth testing unsaved.
///
/// `context` is the chat excerpt the question is about, already chosen and trimmed
/// by the page — deciding which messages are relevant is a reading decision, and
/// it belongs where the feed is.
#[tauri::command]
async fn llm_chat(
    app: tauri::AppHandle,
    question: String,
    context: Vec<String>,
) -> Result<String, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("nothing to ask".into());
    }

    let config = llm::read_config(&app);
    if config.base_url.trim().is_empty() || config.api_key.trim().is_empty() {
        return Err("no endpoint configured — set one up under Model first".into());
    }
    if config.model.trim().is_empty() {
        return Err("no model selected — pick one under Model first".into());
    }

    let transcript = if context.is_empty() {
        "(the chat is empty)".to_string()
    } else {
        context.join("\n")
    };

    let messages = vec![
        llm::Turn::system(
            "You are answering questions about a TikTok live chat, given an excerpt of it. \
             Answer from the excerpt. If the excerpt does not say, say so plainly rather than \
             guessing. Be brief: a couple of sentences at most.",
        ),
        llm::Turn::user(format!("Chat so far:\n{transcript}\n\nQuestion: {question}")),
    ];

    match llm::chat(&config.base_url, &config.api_key, &config.model, &messages).await {
        Ok(answer) => Ok(answer),
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
        llm_chat,
        llm_config_get,
        llm_config_save,
        llm_config_clear,
        open_stream,
        speak,
        pick_sound_file,
        backend_config_get,
        backend_config_save,
        backend_connect,
        backend_disconnect
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
