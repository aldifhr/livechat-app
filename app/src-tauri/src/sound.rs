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
//! own record of every file that was actually chosen through the dialog, and
//! grants them all on the way up.
//!
//! Every file, not the last one: the page lets the user pick a different file per
//! event, so a record of one path meant the gift file worked until the chat file
//! was chosen and then stopped. The record is a set of picks, not a single slot.
//!
//! Only ever files the user picked in the file dialog. Nothing here widens what
//! is reachable beyond the paths that dialog already returned.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The remembered custom sounds.
///
/// Only the paths are kept. The bytes stay on disk and are read when a sound
/// fires, so a large file is not held in memory for a sound that may never play.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SoundConfig {
    /// The absolute paths of every file the user has chosen, in the order they
    /// were picked. Empty means "use the templates".
    pub paths: Vec<String>,
}

/// Reads a record from its JSON, migrating the single-path shape it used to have.
///
/// The old file was `{"path": "..."}` because there was one custom sound for the
/// whole app. There are now up to three, one per event, so a record of one path
/// silently lost the other two — this reads the old key when the new one is
/// absent, so a user who had already picked a file keeps it instead of having to
/// pick again after the upgrade.
pub fn parse_config(raw: &str) -> SoundConfig {
    if let Ok(config) = serde_json::from_str::<SoundConfig>(raw) {
        if !config.paths.is_empty() {
            return config;
        }
    }
    #[derive(Deserialize)]
    struct Legacy {
        path: String,
    }
    if let Ok(legacy) = serde_json::from_str::<Legacy>(raw) {
        if !legacy.path.trim().is_empty() {
            return SoundConfig {
                paths: vec![legacy.path],
            };
        }
    }
    SoundConfig::default()
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

/// Reads the remembered sounds.
///
/// A missing or unreadable file is an empty one rather than an error: not having
/// chosen a file yet is the normal state on first launch.
pub fn read_config(app: &tauri::AppHandle) -> SoundConfig {
    config_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|raw| parse_config(&raw))
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

/// Grants every remembered sound to the page's asset scope.
///
/// Called once at startup so sounds chosen last run still play without the user
/// having to pick them again. Fails quietly: a sound that cannot be granted costs
/// the user that one custom sound and nothing else.
pub fn regrant(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    let config = read_config(app);
    for path in &config.paths {
        if let Some(path) = grantable(path) {
            let _ = app.asset_protocol_scope().allow_file(path);
        }
    }
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
            paths: vec![named("chime.mp3"), named("blip.mp3")],
        };
        let body = serde_json::to_string(&config).expect("serialises");
        // camelCase, to match every other field on this wire.
        assert!(body.contains("\"paths\""));
        let back: SoundConfig = serde_json::from_str(&body).expect("parses");
        assert_eq!(back.paths, config.paths);
    }

    #[test]
    fn a_single_path_record_is_migrated() {
        // The shape before this was a list: one file for the whole app. Reading
        // it as an empty list would drop the file the user had already chosen, so
        // the old key is read when the new one is absent.
        let back = parse_config(&format!("{{\"path\": {:?}}}", named("chime.mp3")));
        assert_eq!(back.paths, vec![named("chime.mp3")]);
    }

    #[test]
    fn every_picked_path_is_kept() {
        // The regression: the record used to hold one path, so picking a second
        // file for a second event silently dropped the first, and its grant went
        // with it on the next launch.
        let back = parse_config(&format!(
            "{{\"paths\": [{:?}, {:?}]}}",
            named("gift.mp3"),
            named("chat.mp3")
        ));
        assert_eq!(back.paths.len(), 2);
    }

    #[test]
    fn an_empty_file_parses_to_no_sound() {
        let back: SoundConfig = serde_json::from_str("{}").expect("parses");
        assert!(back.paths.is_empty());
        // A record that names nothing is the same as no record at all.
        assert!(parse_config("{}").paths.is_empty());
        assert!(parse_config("{\"paths\": []}").paths.is_empty());
        assert!(parse_config("{\"path\": \"  \"}").paths.is_empty());
    }
}