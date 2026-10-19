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
mod sound;
mod speech;

use std::sync::Arc;

use tauri::{Emitter as _, Manager, State};
use tauri_plugin_notification::NotificationExt;

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

/// Whether a URL is one this app is willing to hand to the OS.
///
/// The frontend builds this string, but the frontend is not trusted with it: an
/// opener that will take any string is an opener that will launch whatever a
/// compromised page asks for. Checked here instead, where the rule cannot be
/// edited from the page.
fn is_watchable(url: &str) -> bool {
    let rest = match url.strip_prefix("https://") {
        Some(rest) => rest,
        None => return false,
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    // `www.` included because that is the form the UI produces, and the check is
    // on the whole host rather than a suffix so `eviltiktok.com` cannot pass.
    host.eq_ignore_ascii_case("tiktok.com") || host.eq_ignore_ascii_case("www.tiktok.com")
}

/// Opens the stream in the default browser.
///
/// Refused by host rather than by the page: the webview is what asks, and an
/// opener that takes whatever it is given is an opener that will eventually be
/// handed something worse. `is_watchable` is the whole rule, and it lives beside
/// the rest of the code the page cannot edit.
#[tauri::command]
fn open_stream(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt as _;
    if !is_watchable(&url) {
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
    //
    // Both the record of which files were chosen and the grant that makes them
    // reachable belong to `sound`, which owns both; this command is only the one
    // place a new path can enter.
    let path = chosen.as_path().ok_or_else(|| "not a local file".to_string())?;
    sound::remember(&app, path)?;
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
///
/// `pace` and `language` are optional so a page that does not know about a choice —
/// an older build, or a host command called by hand — still speaks at the service's
/// own pace in the chat's own language rather than erroring.
#[tauri::command]
async fn speak(text: String, pace: Option<String>, language: Option<String>) -> Result<String, String> {
    use base64::Engine as _;

    let chosen = pace.as_deref().unwrap_or(speech::NORMAL);
    let audio = speech::say(&text, chosen, language.as_deref())
        .await
        .map_err(|e| e.to_string())?;

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
    // The new generation, taken before the spawn so the frames the pump emits are
    // stamped with the session the app is about to be told about. `renew` also
    // invalidates whatever was running, which is what makes Connect over a live
    // session replace it rather than double it.
    let generation = state.backend.renew();
    let shared = Arc::clone(&state.backend);
    tauri::async_runtime::spawn(async move {
        backend::pump(app, config, shared, generation).await;
    });
    Ok(())
}

/// Stops reading from the backend.
///
/// The order of the two statements is the whole point. `stop()` bumps the
/// generation first, so every frame still in flight from the session being closed
/// is stamped with a generation the app has already been told to forget; the
/// status frame is emitted afterwards and deliberately carries no session, so it
/// gets through where those do not.
///
/// Doing it the other way round — emit, then stop — is what the reported bug was:
/// the confirmation was queued while the reader was still live, so frames emitted
/// in the same instant arrived *after* the app had been told the reading stopped,
/// and the feed kept growing under a "Not connected" badge.
#[tauri::command]
fn backend_disconnect(state: State<'_, AppState>, app: tauri::AppHandle) {
    state.backend.stop();
    let _ = app.emit(
        backend::EVENT,
        backend::status_frame("bridge", false, "Disconnected"),
    );
}

/// The current connection state, for a frontend that has just started.
///
/// A reload of the webview — which `tauri:dev` does on every code change — throws
/// the whole frontend away while this process keeps reading the stream. The new
/// page starts from an idle room, so without asking it shows "Not connected" and a
/// Connect button while chat rows are still arriving. That is not a cosmetic
/// mismatch: the button offers to connect to a room that is already connected.
///
/// So the page asks, once, as it attaches its listener. The answer is a status
/// frame like any other, carrying the session the reader is on — which is also
/// what lets the reloaded page tell a frame from that session apart from a
/// straggler of an older one.
///
/// A command rather than a pushed frame because the host has no way to know a
/// webview reloaded: Tauri re-creates the page without telling the Rust side, so
/// there is no moment to push at. Asking is the only reliable signal.
#[tauri::command]
fn backend_status(state: State<'_, AppState>) -> serde_json::Value {
    state.backend.snapshot()
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
        open_stream,
        speak,
          pick_sound_file,
        backend_config_get,
        backend_config_save,
        backend_connect,
        backend_disconnect,
        backend_status
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
