//! Supervision of the chat bridge.
//!
//! One process per app, one room at a time. The bridge reports its own state on
//! stdout as JSON lines; this module only pumps bytes and owns the lifecycle.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::bridge;

/// Matches `EVENT` in main.rs. Kept in step by hand — there is no shared
/// constant across the language boundary.
const EVENT: &str = "sidecar-event";

/// Where the extracted bridge is, resolved once per launch.
///
/// Unwrapping rather than propagating: every caller would otherwise have to
/// thread the same failure out, and a bridge that cannot be extracted is not a
/// recoverable condition anyway — the app cannot do anything useful without it.
/// The error is stored so `connect` can still report something better than a
/// panic.
static BRIDGE: OnceLock<Result<PathBuf, String>> = OnceLock::new();

fn bridge_path() -> Result<&'static PathBuf, String> {
    BRIDGE.get_or_init(bridge::prepare).as_ref().map_err(Clone::clone)
}

/// A live bridge process. `None` means no room is connected.
struct Handle {
    child: Child,
    stdin: std::process::ChildStdin,
    /// How many rooms are currently open on this process.
    ///
    /// Counted here rather than asking the bridge, so the host knows the moment
    /// the last room closed and can reclaim the process instead of leaving an
    /// 85 MB runtime sitting idle behind a window with nothing to show.
    sessions: usize,
}

#[derive(serde::Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Level {
    Info,
    Warn,
    Error,
}

/// The bridge is a console-subsystem binary and this app is a GUI one. Without
/// `CREATE_NO_WINDOW`, Windows allocates a console for the child and the user gets
/// a black command prompt sitting behind the app for the whole session.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn spawn_bridge(exe: &Path) -> std::io::Result<Child> {
    let mut command = Command::new(exe);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Piped rather than inherited so the app can show it. A GUI app has no
        // console to inherit from anyway, and inheriting is what makes one
        // appear; these lines become the in-app log panel instead.
        .stderr(Stdio::piped());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command.spawn()
}

/// Pulls a level out of one of the bridge's stderr lines.
///
/// The bridge writes `<iso-timestamp> <LEVEL> <message>`, so the level is the
/// second field. An unrecognisable line is still worth showing — it is usually a
/// crash dump — but as `info`, since nothing claimed it was an error.
fn split_log_line(line: &str) -> (Level, &str) {
    let mut parts = line.splitn(3, ' ');
    let _timestamp = parts.next();
    match (parts.next(), parts.next()) {
        (Some("WARN"), Some(message)) => (Level::Warn, message),
        (Some("ERROR"), Some(message)) => (Level::Error, message),
        _ => {
            // The timestamp is noise in a panel that already shows a clock.
            let message = line.split_once(" ").map_or(line, |(_, rest)| rest);
            (Level::Info, message)
        }
    }
}

/// The bridge, plus the lock that guarantees only one room is open at a time.
pub struct Sidecar {
    inner: Mutex<Option<Handle>>,
}

impl Sidecar {
    pub fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }

    /// Starts a bridge and wires its stdout to the webview.
    fn start(app: &AppHandle) -> Result<Handle, String> {
        let exe = bridge_path()?;
        if !exe.exists() {
            return Err(format!("{} is missing", exe.display()));
        }

        let mut child = spawn_bridge(&exe)
            .map_err(|e| format!("could not launch the chat bridge ({e})"))?;

        let stdin = child.stdin.take().ok_or("bridge stdin was not piped")?;
        let stdout = child.stdout.take().ok_or("bridge stdout was not piped")?;
        let stderr = child.stderr.take().ok_or("bridge stderr was not piped")?;

        // Both readers get their own thread: a line only arrives when TikTok sends
        // one, so blocking either would otherwise hold this call for the whole
        // session — and a blocked stderr reader would silently stop the log
        // panel the moment the chat got busy.
        let emit_app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(value) => {
                        let _ = emit_app.emit(EVENT, value);
                    }
                    // A malformed line is the bridge's bug, not the user's. The
                    // process stays up; dropping the frame beats tearing down a
                    // working connection over one bad message.
                    Err(_) => continue,
                }
            }
        });

        let log_app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let (level, message) = split_log_line(trimmed);
                let _ = log_app.emit(
                    EVENT,
                    serde_json::json!({
                        "type": "log",
                        "level": level,
                        "message": message,
                    }),
                );
            }
        });

        Ok(Handle { child, stdin, sessions: 0 })
    }

    /// Starts a bridge if none is running, then asks it for one platform's room.
    ///
    /// One bridge process serves both platforms: the second connect reuses the
    /// running process rather than starting another, which is what lets the two
    /// rooms be live at the same time.
    pub fn connect(&self, platform: String, target: String, app: &AppHandle) -> Result<(), String> {
        let mut slot = self.inner.lock().map_err(|_| "bridge lock poisoned")?;

        let handle = match slot.as_mut() {
            Some(existing) => existing,
            None => {
                let fresh = Self::start(app)?;
                slot.insert(fresh)
            }
        };

        let command =
            serde_json::json!({ "cmd": "connect", "platform": platform, "target": target });
        writeln!(handle.stdin, "{command}").map_err(|e| format!("could not reach the bridge: {e}"))?;

        // Only counted after the command went out, so a write that failed leaves
        // the count where it was and the process can still be reclaimed.
        handle.sessions += 1;
        Ok(())
    }

    /// Closes one platform's room, or every room when `platform` is `None`.
    ///
    /// The process is killed once the last room closes. Reusing it would make a
    /// reconnect instant, but it would also leave an 85 MB JavaScript runtime
    /// alive behind an idle window — which is a worse trade than a 200 ms delay
    /// on the next connect.
    pub fn disconnect(&self, platform: Option<String>, app: &AppHandle) {
        let Ok(mut slot) = self.inner.lock() else { return };

        let Some(handle) = slot.as_mut() else {
            let _ = app.emit(
                EVENT,
                serde_json::json!({ "type": "status", "connected": false, "message": "Disconnected" }),
            );
            return;
        };

        let command = match &platform {
            Some(id) => serde_json::json!({ "cmd": "disconnect", "platform": id }),
            None => serde_json::json!({ "cmd": "disconnect" }),
        };
        let _ = writeln!(handle.stdin, "{command}");

        let _ = app.emit(
            EVENT,
            serde_json::json!({
                "type": "log",
                "level": "info",
                "message": match &platform {
                    Some(id) => format!("closing the {id} room"),
                    None => "closing every room".to_string(),
                },
            }),
        );

        // One room closes, or all of them — either way the count is what is left.
        handle.sessions =
            handle.sessions.saturating_sub(if platform.is_some() { 1 } else { handle.sessions });

        if handle.sessions == 0 {
            if let Some(mut last) = slot.take() {
                let _ = last.child.kill();
                let _ = last.child.wait();
            }

            // The bridge is on its way out, so its own "Disconnected" frame will
            // almost never be read before the pipe closes. The host knows the
            // outcome, so it says so itself — otherwise the UI keeps showing
            // "Connected" over a room that is already gone.
            let _ = app.emit(
                EVENT,
                serde_json::json!({
                    "type": "status",
                    "platform": platform.clone().unwrap_or_else(|| "bridge".to_string()),
                    "connected": false,
                    "message": "Disconnected",
                }),
            );
        }
    }

    pub fn shutdown(&self) {
        let Ok(mut slot) = self.inner.lock() else { return };
        if let Some(mut handle) = slot.take() {
            let _ = handle.child.kill();
            let _ = handle.child.wait();
        }
    }
}

impl Default for Sidecar {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.shutdown();
    }
}