//! Extracting the chat bridge out of this executable.
//!
//! The bridge is a ~85 MB self-contained binary that has to run as its own
//! process, so it cannot be linked — but it can be carried inside this binary and
//! written to disk on first run. That is what makes the app a single `.exe`:
//! nothing else needs to be installed beside it.
//!
//! It is written once into a versioned cache directory and then reused. The
//! version in the path is a fingerprint of the embedded bytes rather than a
//! hand-maintained constant, so upgrading the app cannot silently run a stale
//! bridge from an earlier build.

use std::fs;
use std::path::{Path, PathBuf};

/// The bridge as shipped inside this executable.
const EMBEDDED: &[u8] = include_bytes!("../resources/livechat-bridge.exe");

/// Decides where to unpack the bridge.
///
/// Beside the exe first, so the app is portable: copy it to a USB stick and it
/// works there, and deleting the folder removes the app completely. That only
/// works when the exe's own directory is writable, which it is not once the app
/// has been installed into `Program Files`, so `%LOCALAPPDATA%` is the fallback.
fn choose_dir() -> Result<PathBuf, String> {
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .map(|dir| dir.join("bridge"))
        .filter(|dir| is_writable(dir));

    if let Some(dir) = beside {
        return Ok(dir);
    }

    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("TEMP").map(PathBuf::from))
        .ok_or("the exe folder is not writable and neither LOCALAPPDATA nor TEMP is set")?;
    Ok(base.join("com.local.livechatapp").join("bridge"))
}

/// Whether a directory can actually be written to.
///
/// Created if absent, because a probe that only checks for an existing directory
/// would reject the normal case of a folder the app has not used yet.
fn is_writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-probe");
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// FNV-1a over the embedded bytes. Only used to name the cache directory, so
/// collision resistance is not the point — being stable across runs is.
fn fingerprint() -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in EMBEDDED {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}-{}", EMBEDDED.len())
}

/// Write `bytes` to `path` via a temporary file and a rename.
///
/// The rename is what makes this atomic: a run interrupted by a power loss
/// leaves either the old complete file or no file, never a truncated bridge that
/// would fail to start with a confusing error.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("partial");
    fs::write(&temp, bytes).map_err(|e| format!("could not write {}: {e}", temp.display()))?;
    fs::rename(&temp, path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("could not move the bridge into place: {e}")
    })
}

/// Returns the path of a ready-to-run bridge, extracting it if needed.
///
/// Extraction happens once per build. Every later launch finds the file already
/// there and skips the work entirely, so the size check is on the length alone
/// rather than a hash of 85 MB on each start.
pub fn prepare() -> Result<PathBuf, String> {
    let path = choose_dir()?.join(fingerprint()).join("livechat-bridge.exe");

    if let Ok(metadata) = fs::metadata(&path) {
        if metadata.len() == EMBEDDED.len() as u64 {
            return Ok(path);
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    write_atomic(&path, EMBEDDED)?;
    Ok(path)
}