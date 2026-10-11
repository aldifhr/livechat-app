//! Remembering which local sound file the user picked.
//!
//! The page hands back a path and plays the file through the asset protocol,
//! which is the only way a webview reads something off this machine. That protocol
//! is scoped: a file has to be granted before the page can fetch it, and the
//! grant is deliberately not wildcarded, so that a script which finds its way
//! into the webview cannot read `C:\Users\someone\.ssh\id_rsa` by asking for it.
//!
//! The cost of not wildcarding is that a grant does not survive a restart — the
//! scope is rebuilt empty every launch, and the page's own `localStorage` is not
//! consulted because the page is not the thing that grants. So the host keeps its
//! own record of the last file that was actually chosen through the dialog, and
//! grants exactly that one file on the way up.
//!
//! Only ever a file the user picked in the file dialog. Nothing here widens what
//! is reachable beyond the single path that dialog already returned.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The remembered custom sound.
///
/// Only the path is kept. The bytes stay on disk and are read when the sound
/// fires, so a large file is not held in memory for a sound that may never play.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SoundConfig {
    /// The absolute path of the chosen file, or empty for "use the templates".
    pub path: String,
}

/// Where the record lives, under the app's own config directory.
///
/// Beside the rest of Tauri-managed state so a reinstall or an OS cleanup finds
/// it, rather than somewhere the app would have to create on first run.
pub fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager as _;
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("sound.json"))
        .map_err(|e| format!("no config directory: {e}"))
}

/// Reads the remembered sound.
///
/// A missing or unreadable file is an empty one rather than an error: not having
/// chosen a file yet is the normal state on first launch.
pub fn read_config(app: &tauri::AppHandle) -> SoundConfig {
    config_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Writes it back.
///
/// Written whole rather than merged, so a sound the user cleared is actually
/// cleared on disk instead of surviving because a merge forgot about it.
pub fn write_config(app: &tauri::AppHandle, config: &SoundConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Whether a remembered path is one this app is willing to grant.
///
/// The recorded path is host-written, so it is not attacker-controlled in
/// principle — but it is a file on disk that anything running as the user can
/// edit, and the grant it buys is read access to that path. So the check is
/// deliberately strict and deliberately does not trust the record: the path must
/// exist, must be an absolute path, and must name an extension the file dialog
/// was even offering. An empty record grants nothing.
pub fn grantable(path: &str) -> Option<&Path> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = Path::new(trimmed);
    // A relative path would be resolved against whatever the host's working
    // directory happens to be, which is not something a grant should depend on.
    if !candidate.is_absolute() {
        return None;
    }
    let extension = candidate
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    if !matches!(extension.as_str(), "mp3" | "wav" | "ogg" | "m4a" | "flac" | "aac") {
        return None;
    }
    // A path that no longer exists cannot be fetched, and granting it would leave
    // a dead entry in the scope that reads as a permission but grants nothing.
    if !candidate.is_file() {
        return None;
    }
    Some(candidate)
}

/// Grants the remembered sound to the page's asset scope.
///
/// Called once at startup so a sound chosen last run still plays without the
/// user having to pick it again. Fails quietly: a sound that cannot be granted
/// costs the user their custom sound and nothing else.
pub fn regrant(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    let config = read_config(app);
    let Some(path) = grantable(&config.path) else {
        return;
    };
    let _ = app.asset_protocol_scope().allow_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(name: &str) -> String {
        if cfg!(windows) {
            format!("C:\\sounds\\{name}")
        } else {
            format!("/sounds/{name}")
        }
    }

    #[test]
    fn an_empty_record_grants_nothing() {
        assert!(grantable("").is_none());
        assert!(grantable("   ").is_none());
    }

    #[test]
    fn a_relative_path_is_refused() {
        // Resolved against the host's working directory otherwise, which is not
        // something a read grant should depend on.
        assert!(grantable("sounds/chime.mp3").is_none());
        assert!(grantable("C:chime.mp3").is_none());
    }

    #[test]
    fn an_extension_the_dialog_never_offered_is_refused() {
        assert!(grantable(&named("secrets.env")).is_none());
        assert!(grantable(&named("id_rsa")).is_none());
        assert!(grantable(&named("notes.txt")).is_none());
        // No extension at all, including a dotfile.
        assert!(grantable(&named("id_rsa")).is_none());
    }

    #[test]
    fn a_missing_file_is_refused() {
        // The extension is right but nothing is there: granting it would leave a
        // dead entry in the scope that reads as a permission.
        assert!(grantable(&named("does-not-exist.mp3")).is_none());
    }

    #[test]
    fn the_record_survives_a_round_trip() {
        let config = SoundConfig {
            path: named("chime.mp3"),
        };
        let body = serde_json::to_string(&config).expect("serialises");
        // camelCase, to match every other field on this wire.
        assert!(body.contains("\"path\""));
        let back: SoundConfig = serde_json::from_str(&body).expect("parses");
        assert_eq!(back.path, config.path);
    }

    #[test]
    fn an_empty_file_parses_to_no_sound() {
        let back: SoundConfig = serde_json::from_str("{}").expect("parses");
        assert_eq!(back.path, "");
    }
}