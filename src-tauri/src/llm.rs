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
    chat_within(base, api_key, model, messages, 120).await
}

/// The same request, with a ceiling of its own on how long to wait.
///
/// Split out because the ceiling is the only thing that differs between "a question
/// worth waiting two minutes for" and "a check that should fail fast". A wrapper
/// with a parameter would do; a second function does not put a caller in the
/// position of passing a smaller number to the wrong call.
pub async fn chat_within(
    base: &str,
    api_key: &str,
    model: &str,
    messages: &[Turn],
    timeout_secs: u64,
) -> Result<String, EndpointError> {
    let url = endpoint(base, "chat/completions");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
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

/// One message the model decided is worth acting on.
///
/// `index` is a position in the batch, counted from zero. It travels as a number
/// rather than as a message id because the ids live in the page and only positions
/// are shared: the page numbers what it sends, this side sends it, and the page
/// maps the answer back onto its own rows. The prompt numbers them from one and
/// the conversion happens in `parse_verdicts`, so nothing downstream has to know
/// that.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub index: usize,
    /// A short category, shown on the row. Never empty.
    pub label: String,
    /// Why it was flagged, in a sentence. Shown as the badge's tooltip.
    pub reason: String,
}

/// The first complete JSON value in a model's answer.
///
/// Models wrap JSON in prose and in code fences even when told not to, and the
/// two features below are both unusable if the answer is discarded over a stray
/// "Sure!" in front of it. So the answer is scanned for a `{…}` or `[…]` that
/// actually parses rather than parsed whole.
///
/// Every opener is tried in turn rather than only the first. A preamble that
/// mentions a brace without closing it — "the message is {clearly rude, in my
/// view" — swallows everything after it under any single-candidate scan, and
/// swallowing a valid answer is the one outcome worse than not parsing at all.
pub fn json_value(answer: &str) -> Option<Value> {
    let trimmed = answer.trim();
    if trimmed.is_empty() {
        return None;
    }

    // The whole answer, in the common case where the model obeyed the prompt.
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if value.is_object() || value.is_array() {
            return Some(value);
        }
    }

    let bytes = trimmed.as_bytes();
    for at in 0..bytes.len() {
        if bytes[at] != b'{' && bytes[at] != b'[' {
            continue;
        }
        let Some(end) = closing_bracket(bytes, at) else {
            continue;
        };
        if let Ok(value) = serde_json::from_str::<Value>(&trimmed[at..=end]) {
            if value.is_object() || value.is_array() {
                return Some(value);
            }
        }
    }
    None
}

/// The bracket that closes the one at `start`, or `None` if it is never closed.
///
/// Counts brackets outside strings only: a reason containing `he said "{` would
/// otherwise close an object that never opened, and the text after that point
/// would be discarded along with it.
fn closing_bracket(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;

    for at in start..bytes.len() {
        let byte = bytes[at];
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
            continue;
        }
        match byte {
            b'"' => quoted = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                // `saturating_sub` because the walk starts on an opener, so the
                // first bracket it meets is always a closer at depth one or more —
                // but a `]` closing a `[` it did not see is not worth wrapping on.
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(at);
                }
            }
            _ => {}
        }
    }
    None
}

/// The flagged messages out of a moderation answer.
///
/// `count` is how many messages were sent, and an index outside it is dropped
/// rather than clamped: a model that answers `{"index": 99}` for a batch of three
/// must not have the app remove some arbitrary row of the user's chat on its say.
///
/// A duplicate index keeps the first verdict, so the count of what was flagged is
/// a count of rows rather than of lines the model happened to emit.
pub fn parse_verdicts(answer: &str, count: usize) -> Vec<Verdict> {
    let Some(body) = json_value(answer) else {
        return Vec::new();
    };

    // Both shapes are accepted: the array under `flagged` the prompt asks for, and
    // a bare array, which is what a model that read the prompt and skipped the
    // wrapper produces. One retry is worth more than a feature that silently
    // moderates nothing.
    let entries = match &body {
        Value::Array(entries) => entries.clone(),
        Value::Object(map) => match map.get("flagged") {
            Some(Value::Array(entries)) => entries.clone(),
            _ => return Vec::new(),
        },
        _ => return Vec::new(),
    };

    let mut verdicts: Vec<Verdict> = Vec::new();
    let mut seen: Vec<usize> = Vec::new();
    for entry in entries {
        // Numbers from JSON, so a negative or fractional index is not a count.
        let Some(one_based) = entry.get("index").and_then(Value::as_u64) else {
            continue;
        };
        let Some(index) = one_based.checked_sub(1).map(|n| n as usize) else {
            continue;
        };
        if index >= count || seen.contains(&index) {
            continue;
        }
        seen.push(index);

        let label = entry
            .get("label")
            .and_then(Value::as_str)
            .map(|label| clip(label, LABEL_CHARS))
            .filter(|label| !label.is_empty())
            // A flag with no category is still a flag. It is shown on the row, and
            // a row reading "flagged" says less than the model knew but says
            // something, where a blank badge says nothing at all.
            .unwrap_or_else(|| DEFAULT_LABEL.to_string());
        let reason = entry
            .get("reason")
            .and_then(Value::as_str)
            .map(|reason| clip(reason, REASON_CHARS))
            .unwrap_or_default();

        verdicts.push(Verdict {
            index,
            label,
            reason,
        });
    }
    verdicts
}

/// The longest category a row's badge will hold before it is clipped.
const LABEL_CHARS: usize = 40;
/// The longest reason kept for a badge's tooltip.
const REASON_CHARS: usize = 200;
/// What a verdict with no category of its own is called.
const DEFAULT_LABEL: &str = "flagged";

/// The reply out of an auto-reply answer.
///
/// `None` is the common case and the one the prompt asks for by name: a model
/// that speaks every time it is asked is worse than no model at all. An answer
/// that is not JSON at all is also `None` rather than its own text — a model that
/// ignored the format is more likely to have written "I can't answer that" than
/// something worth posting, and that line belongs in the log, not in the feed.
pub fn parse_reply(answer: &str) -> Option<String> {
    let body = json_value(answer)?;
    let reply = body.get("reply")?;
    // Explicit null is how the prompt says "stay quiet", and it has to survive
    // being read as text: `body.get` alone would turn `null` into `None` by way
    // of `as_str` returning nothing, which is the same answer by accident rather
    // than on purpose.
    let text = reply.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(clip(text, REPLY_CHARS))
}

/// The longest reply kept. A live chat answer is a sentence or two; anything past
/// this is a model that has stopped answering the question it was given.
const REPLY_CHARS: usize = 400;

/// Keeps an error message to one readable line.
///
/// The server's body can be a whole HTML error page, and a toast-sized string is
/// the only place this is ever shown.
fn shorten(text: &str, fallback: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    clip(trimmed, 200)
}

/// Trims to at most `max` characters, with an ellipsis if anything was cut.
///
/// Walked by character rather than sliced, because `max` is a character count the
/// UI is promised and `str::len` counts bytes: slicing there panics the first time
/// a multi-byte character straddles the cut, and with `panic = "abort"` that is
/// the whole app dying on exactly the path that was already going wrong.
fn clip(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let cut = trimmed
        .char_indices()
        .nth(max)
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
        // multi-byte character straddled the cut, and with `panic = "abort"` that
        // killed the process. This is the regression.
        //
        // Two accents rather than one: the budget is counted in characters, so a
        // body of 199 ASCII plus one accent is exactly at the limit and is
        // returned whole. 201 characters puts a two-byte character astride the
        // cut, which is the case that used to panic.
        let body = format!("{}éé", "a".repeat(199));
        let cut = shorten(&body, "fallback");
        assert!(cut.ends_with('…'));
        // Back to bytes on purpose: a char-safe cut is still under the budget.
        assert!(cut.len() <= 204, "{}", cut.len());
        // And it must not have lost the tail of a character into invalid UTF-8.
        assert!(cut.chars().all(|c| c == 'a' || c == 'é' || c == '…'));
        // A body exactly at the limit is not cut at all.
        let exact = format!("{}é", "a".repeat(199));
        assert_eq!(shorten(&exact, "fallback"), exact);
    }

    #[test]
    fn a_short_error_body_is_left_alone() {
        assert_eq!(shorten("{\"detail\":\"nope\"}", "fallback"), "{\"detail\":\"nope\"}");
        assert_eq!(shorten("   ", "fallback"), "fallback");
    }

    #[test]
    fn finds_json_a_model_wrapped_in_prose_or_a_fence() {
        assert_eq!(
            json_value("```json\n{\"reply\":\"hi\"}\n```").unwrap()["reply"],
            json!("hi")
        );
        assert_eq!(
            json_value("Sure! Here you go: {\"reply\":\"hi\"} Hope that helps.").unwrap()["reply"],
            json!("hi")
        );
        assert_eq!(json_value("  {\"reply\":\"hi\"}  ").unwrap()["reply"], json!("hi"));
    }

    #[test]
    fn a_brace_inside_a_string_is_not_the_end_of_the_object() {
        // The reason field is free text and will contain braces sooner or later.
        // Counting this one would close an object that never opened and swallow
        // the whole answer, which is worse than not parsing at all.
        let answer = r#"{"reply":null,"why":"he said \"{ then left"}"#;
        assert_eq!(json_value(answer).unwrap()["reply"], Value::Null);

        // And the same quote, escaped.
        let escaped = r#"{"reply":"a \" b"}"#;
        assert_eq!(json_value(escaped).unwrap()["reply"], json!("a \" b"));
    }

    #[test]
    fn an_unbalanced_brace_in_the_preamble_does_not_hide_the_answer() {
        let answer = "Analysis: the message is {clearly rude, in my view.\n{\"flagged\":[]}";
        assert!(json_value(answer).unwrap()["flagged"].is_array());
    }

    #[test]
    fn an_answer_with_no_json_in_it_is_none() {
        assert!(json_value("").is_none());
        assert!(json_value("   ").is_none());
        assert!(json_value("I would rather not.").is_none());
        // A scalar parses fine and is not an object or an array, so it is not the
        // answer either.
        assert!(json_value("42").is_none());
        assert!(json_value("\"a string\"").is_none());
        // Braces that balance but are not JSON: the walk moves past them.
        assert!(json_value("{ this is not json }").is_none());
        // Truncated: an object that opens and never closes.
        assert!(json_value(r#"{"reply":"cut off mid-"#).is_none());
    }

    #[test]
    fn reads_flagged_messages_out_of_the_answer() {
        let answer = r#"{"flagged":[
            {"index":1,"label":"hate","reason":"slur aimed at the streamer"},
            {"index":3,"label":"spam","reason":"gift card link"}
        ]}"#;
        assert_eq!(
            parse_verdicts(answer, 5),
            vec![
                Verdict { index: 0, label: "hate".into(), reason: "slur aimed at the streamer".into() },
                Verdict { index: 2, label: "spam".into(), reason: "gift card link".into() },
            ]
        );
    }

    #[test]
    fn an_empty_verdict_list_is_the_usual_answer() {
        assert!(parse_verdicts(r#"{"flagged":[]}"#, 5).is_empty());
        assert!(parse_verdicts("[]", 5).is_empty());
        // Prose with no JSON in it. Moderating nothing is a safe failure; acting
        // on nothing is what this guards against.
        assert!(parse_verdicts("None of these are harmful.", 5).is_empty());
    }

    #[test]
    fn a_bare_array_is_accepted_too() {
        // The model read the prompt and skipped the `flagged` wrapper. Refusing
        // this answer means moderating nothing, which is the failure a user would
        // never notice and never forgive.
        let answer = r#"[{"index":2,"label":"spam","reason":"link"}]"#;
        assert_eq!(parse_verdicts(answer, 3)[0].index, 1);
    }

    #[test]
    fn an_index_outside_the_batch_is_dropped_rather_than_trusted() {
        // The single worst failure this function could have: an index past the end
        // has to remove nothing at all, not wrap, not clamp, not guess.
        let answer = r#"{"flagged":[{"index":99,"label":"spam","reason":"x"}]}"#;
        assert!(parse_verdicts(answer, 3).is_empty());
        // One past the end is past the end — the prompt numbers from one.
        let last = r#"{"flagged":[{"index":4,"label":"spam","reason":"x"}]}"#;
        assert!(parse_verdicts(last, 3).is_empty());
        // Zero is not a line number at all; `checked_sub` rejects it rather than
        // wrapping it round to the last message in the batch.
        let zero = r#"{"flagged":[{"index":0,"label":"spam","reason":"x"}]}"#;
        assert!(parse_verdicts(zero, 3).is_empty());
    }

    #[test]
    fn an_index_that_is_not_a_number_is_not_an_index() {
        let answer = r#"{"flagged":[
            {"index":"1","label":"hate","reason":"x"},
            {"index":-1,"label":"hate","reason":"x"},
            {"index":1.5,"label":"hate","reason":"x"},
            {"label":"hate","reason":"x"}
        ]}"#;
        assert!(parse_verdicts(answer, 3).is_empty());
    }

    #[test]
    fn a_repeated_index_is_counted_once() {
        // Two verdicts for one message would remove or flag the same row twice and
        // report two hits where there was one.
        let answer = r#"{"flagged":[
            {"index":1,"label":"hate","reason":"first"},
            {"index":1,"label":"spam","reason":"second"}
        ]}"#;
        let verdicts = parse_verdicts(answer, 3);
        assert_eq!(verdicts.len(), 1);
        assert_eq!(verdicts[0].reason, "first");
    }

    #[test]
    fn a_flag_with_no_category_still_reads_as_a_flag() {
        // An empty badge tells the streamer nothing and looks like a bug.
        let answer = r#"{"flagged":[{"index":1,"label":"   ","reason":"rude"}]}"#;
        assert_eq!(parse_verdicts(answer, 3)[0].label, "flagged");
        // And with nothing to show at all.
        let bare = r#"{"flagged":[{"index":1}]}"#;
        assert_eq!(parse_verdicts(bare, 3)[0].label, "flagged");
        assert_eq!(parse_verdicts(bare, 3)[0].reason, "");
    }

    #[test]
    fn a_reason_longer_than_a_badge_holds_is_clipped() {
        let long = "a".repeat(REASON_CHARS + 50);
        let answer = json!({ "flagged": [{ "index": 1, "label": "x", "reason": long }] }).to_string();
        let reason = parse_verdicts(&answer, 3)[0].reason.clone();
        assert!(reason.ends_with('…'), "{}", reason);
        assert_eq!(reason.chars().count(), REASON_CHARS + 1);
    }

    #[test]
    fn reads_a_reply_out_of_the_answer() {
        assert_eq!(
            parse_reply(r#"{"reply":"the GPU one, I think"}"#).as_deref(),
            Some("the GPU one, I think")
        );
        // The fence and the preamble are the same shapes moderation sees.
        assert_eq!(
            parse_reply("```json\n{\"reply\":\"hello\"}\n```").as_deref(),
            Some("hello")
        );
    }

    #[test]
    fn silence_is_an_answer() {
        // The case the prompt asks for by name, and the common one. It has to come
        // back as "did not reply" rather than as an empty string posted to chat.
        assert_eq!(parse_reply(r#"{"reply":null}"#), None);
        assert_eq!(parse_reply(r#"{"reply":"   "}"#), None);
        assert_eq!(parse_reply(r#"{"reply":""}"#), None);
        // No `reply` key at all is the same thing.
        assert_eq!(parse_reply(r#"{"answer":"hi"}"#), None);
    }

    #[test]
    fn an_answer_that_is_not_the_format_is_not_posted() {
        // A model that ignored the format is more likely to have written a refusal
        // than something worth putting in a live chat. That belongs in the log.
        assert_eq!(parse_reply("I'm not able to help with that."), None);
        assert_eq!(parse_reply(""), None);
        // Right key, wrong type — a reply that is an object is not a reply.
        assert_eq!(parse_reply(r#"{"reply":{"text":"hi"}}"#), None);
    }

    #[test]
    fn a_reply_longer_than_a_chat_line_holds_is_clipped() {
        let long = "b".repeat(REPLY_CHARS + 50);
        let answer = json!({ "reply": long }).to_string();
        let reply = parse_reply(&answer).unwrap();
        assert_eq!(reply.chars().count(), REPLY_CHARS + 1);
        assert!(reply.ends_with('…'));
    }

    #[test]
    fn a_multibyte_clip_does_not_panic() {
        // Every one of these lengths has to survive: the byte-slicing version
        // panicked whenever a character straddled the cut. From one rather than
        // from zero, because an empty label is a different case — it falls back
        // to "flagged", which is covered on its own above.
        for len in 1..(LABEL_CHARS + 3) {
            let text = "é".repeat(len);
            let answer = json!({ "flagged": [{ "index": 1, "label": text, "reason": "r" }] }).to_string();
            let label = parse_verdicts(&answer, 3)[0].label.clone();
            assert!(label.chars().all(|c| c == 'é' || c == '…'), "{}", label);
        }
    }
}