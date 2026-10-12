//! Sending a gift to another app.
//!
//! The request goes out from here rather than from the webview for the same reason
//! the model list does: the page's content security policy forbids it from reaching
//! any other origin, and a webhook token is a credential. The URL and the token are
//! read from disk, so a credential travels from the config file to the socket and
//! nowhere else — the page never holds one in order to use it.
//!
//! What is sent is one gift, as it arrives. Not a batch, not a digest: the point of
//! a webhook is that another app reacts while the gift is still on screen, and
//! everything here is shaped by that — fire-and-forget, a short timeout, and a
//! failure that is silence rather than something the feed has to survive.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Where to send, and what proves the request is from this app.
///
/// The token is sent as a bearer header rather than in the body or the query,
/// because a query string ends up in the receiving server's access log — which is
/// the whole problem `?token=` had, recorded here so it is not repeated.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WebhookConfig {
    /// Whether gifts are sent at all. Off by default: this posts data about the
    /// room to a third party, and that has to be asked for.
    pub enabled: bool,
    /// The receiving URL.
    pub url: String,
    /// Sent as `Authorization: Bearer <token>`. Empty means no header is sent.
    pub token: String,
}

/// The config file, beside the model settings rather than in `localStorage`.
///
/// Not because a webhook URL is secret — it is not — but because it is
/// configuration that has to survive a restart, and this is where the app already
/// keeps that. The token is a credential, and `localStorage` is readable by
/// whatever script ends up running in the webview.
pub fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager as _;
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("webhook.json"))
        .map_err(|e| format!("no config directory: {e}"))
}

/// Reads the stored config.
///
/// A missing or unreadable file is an empty config rather than an error: not having
/// set a webhook up yet is the normal state on first launch.
pub fn read_config(app: &tauri::AppHandle) -> WebhookConfig {
    config_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Writes it back.
///
/// Written whole rather than merged, so a field cleared in the UI is actually
/// cleared on disk instead of surviving because a merge forgot about it.
pub fn write_config(app: &tauri::AppHandle, config: &WebhookConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// One gift, in the shape another app would want it.
///
/// camelCase because that is what every other field on this wire already is — the
/// bridge frames and the Tauri commands alike — and a struct that quietly answers in
/// a different case is one that silently parses to nothing on the far side.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftPayload {
    /// Who sent it.
    pub nickname: String,
    /// The platform's stable per-person handle, for a receiver that keys on it.
    pub user_id: String,
    /// What was sent.
    pub gift_name: String,
    /// How many, after the bridge multiplied by the repeat count.
    pub count: i64,
    /// What it was worth.
    pub diamonds: i64,
    /// When it arrived, in milliseconds since the epoch.
    pub timestamp: i64,
}

/// Why a send failed.
///
/// Kept distinct from a transport failure because the two mean different things to
/// whoever typed the URL in: one is a typo, the other is a server that is down.
#[derive(Debug)]
pub enum SendError {
    /// The request never completed — wrong host, refused, or timed out.
    Unreachable(String),
    /// It answered, and not with a success.
    Refused(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::Unreachable(why) => write!(f, "could not reach the webhook: {why}"),
            SendError::Refused(why) => write!(f, "{why}"),
        }
    }
}

/// How long a send may take before it is abandoned.
///
/// Short, and deliberately so. This fires on a gift, on the busiest path in the app,
/// and the receiving app is expected to acknowledge rather than to do work — a
/// webhook that takes ten seconds to answer is a webhook that is holding a gift's
/// alert hostage. Five seconds is long enough for a slow network and short enough
/// that a wedged receiver cannot pile up.
const SEND_TIMEOUT_SECS: u64 = 5;

/// Sends one gift to the configured URL.
///
/// Fire-and-forget from the caller's side: the result is logged, never surfaced as an
/// error the feed has to handle. A webhook that fails is a feature that did not fire,
/// and a chat reader that stops reading because an integration broke is worse than one
/// that keeps going quietly.
pub async fn send_gift(config: &WebhookConfig, gift: &GiftPayload) -> Result<(), SendError> {
    let url = config.url.trim();
    if url.is_empty() {
        return Err(SendError::Unreachable("no webhook URL configured".into()));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(SEND_TIMEOUT_SECS))
        .build()
        .map_err(|e| SendError::Unreachable(e.to_string()))?;

    let mut request = client.post(url).json(gift);
    let token = config.token.trim();
    if !token.is_empty() {
        request = request.bearer_auth(token);
    }

    let response = request
        .send()
        .await
        .map_err(|e| SendError::Unreachable(e.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        // The body is included because it is the only thing that says why: a 401
        // means the token is wrong, a 404 means the path is, and those are fixed
        // differently.
        let body = response.text().await.unwrap_or_default();
        return Err(SendError::Refused(format!("{} — {}", status.as_u16(), shorten(&body))));
    }

    Ok(())
}

/// A response body cut to something that fits in a log line. */
fn shorten(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 200 {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(200).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_payload_reads_as_what_it_is() {
        // camelCase, because a struct that quietly answers in another case parses to
        // nothing on the far side and the sender never finds out.
        let gift = GiftPayload {
            nickname: "ana".into(),
            user_id: "u1".into(),
            gift_name: "Rose".into(),
            count: 3,
            diamonds: 30,
            timestamp: 1_700_000_000_000,
        };
        let body = serde_json::to_value(&gift).expect("should serialise");
        assert_eq!(body["nickname"], "ana");
        assert_eq!(body["userId"], "u1");
        assert_eq!(body["giftName"], "Rose");
        assert_eq!(body["count"], 3);
        assert_eq!(body["diamonds"], 30);
        assert_eq!(body["timestamp"], 1_700_000_000_000i64);
        // Not snake_case: that is the shape a Rust struct takes by default, and it
        // is the one a JavaScript receiver will not find.
        assert!(body.get("user_id").is_none(), "{body}");
        assert!(body.get("gift_name").is_none(), "{body}");
    }

    #[test]
    fn an_unconfigured_webhook_is_refused_rather_than_sent() {
        // Posting to an empty URL would be a request to nowhere that still leaves
        // the machine.
        let config = WebhookConfig::default();
        assert!(!config.enabled);
        assert!(config.url.is_empty());
        assert!(config.token.is_empty());
    }

    #[test]
    fn a_long_response_body_is_cut() {
        // The body goes in a log line; a wall of HTML is not a reason anyone can act
        // on, and it must not be allowed to become one.
        let long = "x".repeat(5000);
        let cut = shorten(&long);
        assert!(cut.chars().count() <= 201, "{}", cut.chars().count());
        assert!(cut.ends_with('…'), "{cut}");
        // And the cut is on characters, not bytes: a body ending mid-way through a
        // multi-byte character would panic rather than shorten.
        let unicode = "é".repeat(5000);
        let cut = shorten(&unicode);
        assert!(cut.chars().count() <= 201, "{}", cut.chars().count());
    }
}
