//! Talking to an OpenAI-compatible endpoint.
//!
//! Both the model list and the completions themselves go out from here rather than
//! from the webview. The webview's content security policy forbids it from
//! reaching any other origin, which is not a limitation to work around but the
//! reason this file exists: an API key typed into a page is a key a page can be
//! made to leak.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

/// Where an OpenAI-compatible endpoint lives and which model to use.
///
/// Held on this side of the line rather than in the page's storage: `base_url` is
/// harmless, but `api_key` is a credential, and anything in `localStorage` is
/// readable by whatever script ends up running in the webview. It is also the one
/// piece of configuration that has to survive a restart — retyping a key just to
/// list models would make the feature something nobody uses twice.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
// camelCase because that is what every other field on this wire already is —
// the bridge frames and the Tauri commands alike — and a struct that quietly
// answers in a different case is one that silently parses to nothing.
#[serde(default, rename_all = "camelCase")]
pub struct LlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// The config file, under the app's own config directory.
///
/// Kept beside the rest of Tauri-managed state so a reinstall or an OS cleanup
/// finds it, rather than somewhere the app would have to create on first run.
pub fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager as _;
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("llm.json"))
        .map_err(|e| format!("no config directory: {e}"))
}

/// Reads the stored config.
///
/// A missing or unreadable file is an empty config rather than an error: not
/// having pointed the app at a model yet is the normal state on first launch, and
/// refusing to start would be a strange way to say so.
pub fn read_config(app: &tauri::AppHandle) -> LlmConfig {
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
pub fn write_config(app: &tauri::AppHandle, config: &LlmConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Clears the stored key and model, leaving nothing behind.
pub fn clear_config(app: &tauri::AppHandle) -> Result<(), String> {
    write_config(app, &LlmConfig::default())
}

/// Raised when the endpoint answered, but not with something usable.
///
/// Kept distinct from a transport failure because the two mean different things to
/// whoever typed the URL in: one is a typo, the other is a server that is down.
/// One type for both jobs because the split is the same either way — the only
/// thing that differs between listing models and asking one a question is how
/// long it is reasonable to wait.
#[derive(Debug)]
pub enum EndpointError {
    /// The request never completed — wrong host, no route, refused, or timed out.
    Unreachable(String),
    /// It answered, and not with what was asked for.
    Refused(String),
}

/// One turn of a conversation, in the shape the endpoint wants.
///
/// A struct rather than a pair of strings because the field names are the wire's,
/// and a tuple would leave every construction site spelling them out by hand.
/// Serialize only: a turn is written out and never read back.
#[derive(Debug, Clone, Serialize)]
pub struct Turn {
    pub role: String,
    pub content: String,
}

impl Turn {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".into(),
            content: content.into(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: content.into(),
        }
    }
}

/// Whether a URL is one this app is willing to hand to the OS.
///
/// The frontend builds this string, but the frontend is not trusted with it: an
/// opener that will take any string is an opener that will launch whatever a
/// compromised page asks for. Checked here instead, where the rule cannot be
/// edited from the page.
pub fn is_watchable(url: &str) -> bool {
    let rest = match url.strip_prefix("https://") {
        Some(rest) => rest,
        None => return false,
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    // `www.` included because that is the form the UI produces, and the check is
    // on the whole host rather than a suffix so `eviltiktok.com` cannot pass.
    host.eq_ignore_ascii_case("tiktok.com") || host.eq_ignore_ascii_case("www.tiktok.com")
}

/// Joins a base URL and a path without doubling or dropping the slash.
///
/// Written out rather than pulled in as a dependency because the whole of what is
/// needed here is: providers disagree about the trailing slash, and `Url::join`
/// silently throws the last segment away when the base has no trailing slash.
pub fn endpoint(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

/// The model ids from an OpenAI-compatible `/models` response.
///
/// Defensive on purpose. The endpoint this was written against returns entries
/// with nothing but an `id`, alongside entries carrying a dozen optional fields,
/// so anything read with `as_str()` and unwrapped would take the whole list down
/// over one odd row. Entries without an id are skipped rather than guessed at.
pub fn model_ids(body: &Value) -> Vec<String> {
    let Some(entries) = body.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut ids: Vec<String> = entries
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .filter(|id| !id.trim().is_empty())
        .map(|id| id.trim().to_string())
        .collect();

    // Sorted for a dropdown. Duplicates dropped: several proxies publish the same
    // model under more than one name, and offering it twice reads as a bug.
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Fetches the available models.
///
/// A 401 is reported with whatever the server said, because "API key required" is
/// the single most likely thing to go wrong here and it is worth passing on
/// verbatim rather than flattening into "failed".
pub async fn list_models(base: &str, api_key: &str) -> Result<Vec<String>, EndpointError> {
    let url = endpoint(base, "models");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| EndpointError::Unreachable(e.to_string()))?;

    let response = client
        .get(&url)
        // Sent even when empty: some proxies answer a keyless request from a cache
        // and the stale list is worse than an error.
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| EndpointError::Unreachable(e.to_string()))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| EndpointError::Unreachable(e.to_string()))?;

    if !status.is_success() {
        return Err(EndpointError::Refused(shorten(&text, &status.to_string())));
    }

    let body: Value = serde_json::from_str(&text)
        .map_err(|e| EndpointError::Refused(format!("not JSON: {e}")))?;

    let ids = model_ids(&body);
    if ids.is_empty() {
        return Err(EndpointError::Refused(
            "the endpoint answered, but listed no models".into(),
        ));
    }
    Ok(ids)
}

/// Asks the model something, and returns the text it answered with.
///
/// The long timeout is the whole difference from listing models: a listing is a
/// read, but a completion is a generation, and cutting one off at fifteen seconds
/// would fail exactly the questions that were worth asking. Two minutes is long
/// enough for a slow reasoner and short enough that a wedged provider does not
/// leave the panel waiting for ever.
pub async fn chat(
    base: &str,
    api_key: &str,
    model: &str,
    messages: &[Turn],
) -> Result<String, EndpointError> {
    let url = endpoint(base, "chat/completions");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| EndpointError::Unreachable(e.to_string()))?;

    let response = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&json!({ "model": model, "messages": messages, "stream": false }))
        .send()
        .await
        .map_err(|e| EndpointError::Unreachable(e.to_string()))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| EndpointError::Unreachable(e.to_string()))?;

    if !status.is_success() {
        return Err(EndpointError::Refused(shorten(&text, &status.to_string())));
    }

    let body: Value = serde_json::from_str(&text)
        .map_err(|e| EndpointError::Refused(format!("not JSON: {e}")))?;

    // A refusal and an empty answer are the same thing to whoever asked: the
    // model chose to say nothing, and there is no answer to show either way.
    let answer = completion_text(&body)
        .filter(|answer| !answer.trim().is_empty())
        .ok_or_else(|| EndpointError::Refused("the model answered with no text".into()))?;
    Ok(answer)
}

/// The answer out of a `/chat/completions` response.
///
/// Reads `choices[0].message.content`, falling back to `choices[0].text`, which is
/// where the older completion-shaped endpoints put the same answer. Everything
/// else in the envelope — ids, usage, finish reasons — is somebody else's
/// bookkeeping and is not read here.
pub fn completion_text(body: &Value) -> Option<String> {
    let choice = body.get("choices")?.as_array()?.first()?;
    choice
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .or_else(|| choice.get("text").and_then(Value::as_str))
        .map(str::to_string)
}

/// Keeps an error message to one readable line.
///
/// The server's body can be a whole HTML error page, and a toast-sized string is
/// the only place this is ever shown.
fn shorten(text: &str, fallback: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    if trimmed.len() <= 200 {
        return trimmed.to_string();
    }
    // Walked by character rather than sliced at 200, because 200 is a byte count
    // and the body is not necessarily ASCII. Slicing there panics the first time a
    // multi-byte character straddles the cut, and with `panic = "abort"` that is
    // the whole app dying on exactly the path that was already going wrong.
    let cut = trimmed
        .char_indices()
        .nth(200)
        .map(|(index, _)| index)
        .unwrap_or(trimmed.len());
    format!("{}…", &trimmed[..cut])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn joins_without_doubling_or_dropping() {
        assert_eq!(endpoint("http://h/v1", "models"), "http://h/v1/models");
        assert_eq!(endpoint("http://h/v1/", "models"), "http://h/v1/models");
        assert_eq!(endpoint("http://h/v1///", "/models"), "http://h/v1/models");
        // The case `Url::join` gets wrong: no trailing slash on the base.
        assert_eq!(endpoint("http://h/v1", "/models"), "http://h/v1/models");
    }

    #[test]
    fn reads_ids_and_ignores_everything_else() {
        let body = json!({
            "object": "list",
            "data": [
                { "id": "b", "object": "model", "owned_by": "cx" },
                { "id": "a", "object": "model", "capabilities": { "vision": true } }
            ]
        });
        assert_eq!(model_ids(&body), vec!["a", "b"]);
    }

    #[test]
    fn survives_entries_that_carry_nothing() {
        // The endpoint this was written against returns these beside full entries.
        let body = json!({ "data": [{ "id": "faray" }, { "object": "model" }, { "id": "" }, { "id": 7 }] });
        assert_eq!(model_ids(&body), vec!["faray"]);
    }

    #[test]
    fn an_unexpected_shape_is_empty_rather_than_a_panic() {
        assert!(model_ids(&json!({})).is_empty());
        assert!(model_ids(&json!({ "data": "nope" })).is_empty());
        assert!(model_ids(&json!([1, 2, 3])).is_empty());
    }

    #[test]
    fn drops_duplicate_names() {
        let body = json!({ "data": [{ "id": "a" }, { "id": "a" }, { "id": "b" }] });
        assert_eq!(model_ids(&body), vec!["a", "b"]);
    }

    #[test]
    fn reads_the_answer_out_of_a_completion() {
        let body = json!({
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "model": "cx/gpt-5.6-sol",
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": { "role": "assistant", "content": "They are talking about the new GPU." }
            }],
            "usage": { "prompt_tokens": 812, "completion_tokens": 24 }
        });
        assert_eq!(
            completion_text(&body).as_deref(),
            Some("They are talking about the new GPU.")
        );
    }

    #[test]
    fn falls_back_to_the_completion_shaped_answer() {
        // Older endpoints answer the same request under `text` rather than
        // `message.content`, and there is no way to ask which one is coming.
        let body = json!({ "choices": [{ "text": "Mostly about cats." }] });
        assert_eq!(completion_text(&body).as_deref(), Some("Mostly about cats."));
    }

    #[test]
    fn an_unexpected_completion_is_none_rather_than_a_panic() {
        assert!(completion_text(&json!({})).is_none());
        assert!(completion_text(&json!({ "choices": [] })).is_none());
        assert!(completion_text(&json!({ "choices": "nope" })).is_none());
        assert!(completion_text(&json!({ "choices": [{}] })).is_none());
        // A refusal comes back with the reason in its place of content, and
        // reading it as a number must not take the panel down.
        assert!(completion_text(&json!({ "choices": [{ "message": { "content": 7 } }] })).is_none());
    }

    #[test]
    fn opens_only_tiktok() {
        assert!(is_watchable("https://www.tiktok.com/@foo/live"));
        assert!(is_watchable("https://tiktok.com/@foo/live"));
        // Not just a suffix check: a host that merely ends in the right text is
        // somebody else's domain, and an opener is exactly the wrong place to
        // discover that.
        assert!(!is_watchable("https://eviltiktok.com/@foo/live"));
        assert!(!is_watchable("https://tiktok.com.evil.test/@foo"));
        assert!(!is_watchable("http://www.tiktok.com/@foo/live"));
        assert!(!is_watchable("file:///C:/Windows/System32/cmd.exe"));
        assert!(!is_watchable("javascript:alert(1)"));
        assert!(!is_watchable(""));
    }

    #[test]
    fn a_multibyte_error_body_is_cut_without_panicking() {
        // The byte-slice version of this function panicked the first time a
        // multi-byte character straddled the 200-byte cut, and with
        // `panic = "abort"` that killed the process. This is the regression.
        let body = format!("{}é", "a".repeat(199));
        let cut = shorten(&body, "fallback");
        assert!(cut.ends_with('…'));
        // Back to bytes on purpose: a char-safe cut is still under the budget.
        assert!(cut.len() <= 204, "{}", cut.len());
        // And it must not have lost the tail of a character into invalid UTF-8.
        assert!(cut.chars().all(|c| c == 'a' || c == 'é' || c == '…'));
    }

    #[test]
    fn a_short_error_body_is_left_alone() {
        assert_eq!(shorten("{\"detail\":\"nope\"}", "fallback"), "{\"detail\":\"nope\"}");
        assert_eq!(shorten("   ", "fallback"), "fallback");
    }
}