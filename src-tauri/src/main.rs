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

use std::sync::Arc;

use tauri::{Manager, State};
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
        Err(llm::ModelListError::Unreachable(why)) => Err(format!("could not reach {base_url}: {why}")),
        Err(llm::ModelListError::Refused(why)) => Err(why),
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
#[tauri::command]
fn backend_disconnect(state: State<'_, AppState>) {
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
        .manage(AppState {
            backend: Arc::new(backend::BackendState::default()),
        })
        .invoke_handler(tauri::generate_handler![
        minimize_to_tray,
        set_always_on_top,
        notify,
        llm_models,
        llm_config_get,
        llm_config_save,
        llm_config_clear,
        open_stream,
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
