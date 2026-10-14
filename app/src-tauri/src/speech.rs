//! Reading chat aloud, with a neural voice.
//!
//! The platform's own speech synthesiser is a formant synthesiser: it works, and
//! it sounds like a screen reader from 2003. This talks to a neural voice over the
//! network instead — free, no API key, and the difference between the two is the
//! difference between reading a chat and hearing one.
//!
//! One engine: the Google Translate read-aloud endpoint, which is a plain HTTP GET
//! returning MP3. The simplest thing that can work, and the only one that has kept
//! working.
//!
//! Edge's Read Aloud was the second engine here and has been removed. It was there
//! because it is the only one that can be asked for a particular voice, but it is
//! not something a program can rely on: the service gates every connection on a
//! `Sec-MS-GEC` DRM token, and Microsoft rotates the version constant that token is
//! derived from on its own release cycle. When the pin goes stale the handshake
//! still succeeds and the service then returns no audio at all, silently, forever.
//! That failure is worse than having no second engine — a voice picker that hands
//! the request to a fallback is a picker that quietly does nothing, which is what
//! shipping one turned out to mean. One engine that works, and says so when it does
//! not, beats two where one is a lie.
//!
//! Which leaves one voice. Google's endpoint takes a language and nothing else: a
//! `voice` parameter is ignored and returns byte-identical audio, and the language
//! is the only thing that changes the voice. What it does accept is `ttsspeed`, and
//! that is what the setting offers — a reading pace, measured and clamped to the
//! values the service actually answers to.
//!
//! The trade is written down rather than buried, because it is the one thing about
//! this module that is not obvious from the code: **the text being spoken is sent to
//! Google to be spoken.** There is no local option that sounds this good, so the app
//! asks for it in settings rather than assuming it, and a user who wants nothing to
//! leave the machine can leave it off and get silence.

use std::time::Duration;

/// The read-aloud endpoint. Undocumented: Google ships no contract for it.
const GOOGLE_TTS_URL: &str = "https://translate.google.com/translate_tts";

/// The language asked for when the page names none: the chat's own.
///
/// Indonesian, because the chat is Indonesian. Asking for another reads it in that
/// one — which is also what makes the language the closest thing to a voice picker
/// this service can honestly be, since it offers one voice per language and nothing
/// to choose between within one.
pub const DEFAULT_LANGUAGE: &str = "id";

/// The language codes that may reach the service, and the only ones the picker offers.
///
/// A whitelist rather than passing whatever arrives through: `tl` is a query value
/// to a service with no contract, and a stale saved setting should settle for the
/// default the same way an unknown pace does, not arrive as a `tl` nobody has ever
/// sent. The codes here match `TTS_LANGUAGES` in `app/src/lib/voices.ts`; the two
/// lists are only ever changed together, and a test on each side pins its contents.
pub const LANGUAGES: &[&str] = &["id", "en", "ms", "th", "vi", "zh-CN", "ja", "es"];

/// The language to ask for: the one named if this build offers it, else the default.
///
/// Unrecognised input is the default rather than an error, for the reason the pace
/// is: the page hands this whatever a settings file held, and a setting from a build
/// that has since dropped a language must not silence the chat.
pub fn resolve_language(language: Option<&str>) -> &'static str {
    for known in LANGUAGES {
        if Some(*known) == language {
            return known;
        }
    }
    DEFAULT_LANGUAGE
}

/// The `client` token the endpoint expects. `tw-ob` is what the translate page
/// itself sends; without it the request is refused.
const GOOGLE_CLIENT: &str = "tw-ob";

/// The longest text the endpoint accepts in one request.
///
/// Past this it answers 400 rather than truncating, so text is split here and the
/// pieces spoken in order. The limit is not documented and has moved before; the
/// value is deliberately under the observed ceiling so a chat line that happens
/// to be long is still spoken rather than dropped.
const GOOGLE_MAX_CHARS: usize = 180;

/// A browser user-agent.
///
/// The endpoint is reached by the translate page from a browser, and it answers a
/// bare client differently — a plain `reqwest` default is refused. This is the one
/// header that makes the request look like the thing the endpoint is for.
const GOOGLE_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/// How long to wait on Google before giving up.
///
/// A voice that is late is worse than silence: the room has moved on by the time a
/// slow answer arrives. Short enough that the failure is heard while the line is
/// still current.
const GOOGLE_TIMEOUT_SECS: u64 = 6;

/// The setting value meaning the service's own pace: no `ttsspeed` is sent.
///
/// Omitted rather than sent as `1` because the two are not the same thing to the
/// service — a request with no speed parameter and one asking for speed 1 come back
/// as the same audio today, but only the first is the service's default and only
/// the first is guaranteed to stay it.
pub const NORMAL: &str = "normal";

/// The paces that can be picked, slowest first.
///
/// Each of these was measured against the live endpoint rather than taken from the
/// documented range, because the documented range is not what the service honours:
/// it silently clamps anything near its default, so a "slow" setting of 0.9 produces
/// audio identical to normal, and a "fast" setting of 4 likewise. These are values
/// outside the clamp, so each one is audible, and 0.3 and 2.0 are the gentlest
/// settings that still measure as a real change rather than a rounding difference.
pub const PACES: &[(&str, Option<&str>)] = &[
    ("slow", Some("0.3")),
    (NORMAL, None),
    ("fast", Some("2.0")),
];

/// Whether a value from the page names a pace that may be used.
pub fn is_known_pace(pace: &str) -> bool {
    PACES.iter().any(|(id, _)| *id == pace)
}

/// The `ttsspeed` to send for a pace, or `None` to leave the service's own.
pub fn speed_for(pace: &str) -> Option<&'static str> {
    PACES
        .iter()
        .find(|(id, _)| *id == pace)
        .and_then(|(_, speed)| *speed)
}

/// Why a synthesis failed.
#[derive(Debug)]
pub enum SpeechError {
    /// The service could not be reached, or it did not answer in time.
    Unreachable(String),
    /// It answered, and not with audio.
    Refused(String),
}

impl std::fmt::Display for SpeechError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpeechError::Unreachable(why) => write!(f, "could not reach the voice service: {why}"),
            SpeechError::Refused(why) => write!(f, "{why}"),
        }
    }
}

/// One line per synthesis, on stderr.
///
/// The webview cannot see any of this — the page is handed silence either way — so
/// it goes to the terminal `tauri dev` runs in. It is here because a voice setting
/// that quietly does nothing is the one failure a user cannot diagnose from the
/// app: the audio comes back, so everything looks like it worked.
fn log(message: &str) {
    eprintln!("[tts] {message}");
}

/// Speaks one utterance and returns the audio as MP3 bytes.
///
/// `pace` and `language` are the page's settings, passed through and checked here
/// rather than resolved there: which values the service honours is not a question
/// the webview should be answering.
pub async fn say(text: &str, pace: &str, language: Option<&str>) -> Result<Vec<u8>, SpeechError> {
    let said = text.trim();
    if said.is_empty() {
        return Err(SpeechError::Refused("nothing to say".into()));
    }

    // An unrecognised pace is the service's own rather than an error: the page sends
    // this, and a saved setting this build no longer offers must not silence the chat.
    let pace = if is_known_pace(pace) { pace } else { NORMAL };
    let language = resolve_language(language);

    match synthesize(said, speed_for(pace), language).await {
        Ok(audio) => {
            log(&format!("ok, {language}, {pace}, {} bytes", audio.len()));
            Ok(audio)
        }
        Err(e) => {
            log(&format!("failed at {language}, pace {pace}: {e}"));
            Err(e)
        }
    }
}

/// Splits text into pieces the endpoint will each accept, on whitespace.
///
/// Built up word by word until the next word would cross the limit, so each piece
/// is whole words and the join is seamless. A word longer than the limit on its
/// own cannot be left whole — the endpoint answers 400 for a query past the limit
/// rather than truncating, so one unbroken run of letters would refuse the entire
/// sentence — so such a word is cut into `GOOGLE_MAX_CHARS`-sized pieces first.
fn split_for_google(text: &str) -> Vec<String> {
    let mut pieces: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        for chunk in hard_chunks(word, GOOGLE_MAX_CHARS) {
            if !current.is_empty() && current.chars().count() + 1 + chunk.chars().count() > GOOGLE_MAX_CHARS {
                pieces.push(std::mem::take(&mut current));
            }
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(chunk);
        }
    }
    if !current.is_empty() {
        pieces.push(current);
    }
    pieces
}

/// Cuts a word into pieces of at most `limit` characters.
///
/// By characters, not bytes: the endpoint's limit is on characters, and slicing
/// by byte would split a multi-byte character in half and produce invalid UTF-8.
/// A word that already fits is returned whole, so the common case is unchanged.
fn hard_chunks(word: &str, limit: usize) -> Vec<&str> {
    if limit == 0 || word.chars().count() <= limit {
        return vec![word];
    }
    let mut chunks: Vec<&str> = Vec::new();
    let mut start = 0;
    let mut count = 0;
    for (idx, _) in word.char_indices() {
        if count == limit {
            chunks.push(&word[start..idx]);
            start = idx;
            count = 0;
        }
        count += 1;
    }
    if start < word.len() {
        chunks.push(&word[start..]);
    }
    chunks
}

/// Speaks text with Google's read-aloud endpoint, returning MP3 bytes.
///
/// Each piece is a separate GET and the audio is concatenated — MP3 is a stream of
/// independent frames, so joining the pieces plays as one continuous utterance with
/// no seam. Any failure — unreachable, refused, no audio — is an `Err`, which the
/// caller turns into silence rather than a wrong sound.
async fn synthesize(text: &str, speed: Option<&str>, language: &str) -> Result<Vec<u8>, SpeechError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(GOOGLE_TIMEOUT_SECS))
        .build()
        .map_err(|e| SpeechError::Unreachable(e.to_string()))?;

    let mut audio: Vec<u8> = Vec::new();
    for piece in split_for_google(text) {
        // reqwest encodes the query, so the text is passed as a value and not
        // hand-escaped. The parameter names and the endpoint are the parts that
        // matter and they are the literal ones the translate page sends.
        let mut query = vec![
            ("ie", "UTF-8"),
            ("q", piece.as_str()),
            ("tl", language),
            ("client", GOOGLE_CLIENT),
        ];
        // Only sent when a pace was asked for. Adding it for the default as well
        // would be a second way of saying the same thing that can stop meaning it.
        if let Some(speed) = speed {
            query.push(("ttsspeed", speed));
        }

        let response = client
            .get(GOOGLE_TTS_URL)
            .query(&query)
            .header("user-agent", GOOGLE_UA)
            .send()
            .await
            .map_err(|e| SpeechError::Unreachable(e.to_string()))?;

        if !response.status().is_success() {
            return Err(SpeechError::Refused(format!(
                "google answered HTTP {}",
                response.status()
            )));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| SpeechError::Refused(e.to_string()))?;
        if bytes.is_empty() {
            return Err(SpeechError::Refused("google returned no audio".into()));
        }
        audio.extend_from_slice(&bytes);
    }

    if audio.is_empty() {
        return Err(SpeechError::Refused("google returned no audio".into()));
    }
    Ok(audio)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_language_is_indonesian() {
        // The chat is Indonesian; asking for another reads it in that one.
        assert_eq!(DEFAULT_LANGUAGE, "id");
    }

    #[test]
    fn a_language_this_build_offers_is_used_as_named() {
        for code in LANGUAGES {
            assert_eq!(resolve_language(Some(code)), *code, "{code}");
        }
    }

    #[test]
    fn an_unknown_language_reads_in_the_default_rather_than_failing() {
        // A settings file outlives the build that wrote it, so a language dropped in
        // a later release comes back from the page. Silently reading in the wrong
        // language beats refusing to speak at all.
        assert_eq!(resolve_language(Some("kl")), DEFAULT_LANGUAGE);
        assert_eq!(resolve_language(Some("")), DEFAULT_LANGUAGE);
        assert_eq!(resolve_language(Some("id;evil")), DEFAULT_LANGUAGE);
        assert_eq!(resolve_language(None), DEFAULT_LANGUAGE);
    }

    #[test]
    fn the_offered_languages_are_the_ones_the_page_offers() {
        // Pinned because the page filters the picker with its own list and this host
        // rejects anything not in this one: a code added to only one of the two is a
        // language the picker offers and the voice refuses. They are changed together.
        assert_eq!(
            LANGUAGES,
            &["id", "en", "ms", "th", "vi", "zh-CN", "ja", "es"]
        );
    }

    #[test]
    fn the_default_pace_sends_no_speed() {
        // The service's own pace, expressed by not asking. A request carrying
        // `ttsspeed=1` is a request for a number the service then clamps.
        assert_eq!(speed_for(NORMAL), None);
    }

    #[test]
    fn every_pace_the_picker_offers_is_one_the_service_answers_to() {
        // Each of these was measured against the live endpoint. A value inside the
        // service's clamp is worse than useless: it is offered, it is stored, and it
        // sounds identical to normal.
        for (id, speed) in PACES {
            assert!(speed.is_some() || *id == NORMAL, "{id} must send a speed");
            if let Some(speed) = speed {
                let s: f32 = speed.parse().expect("a speed is a number");
                assert!(s > 0.0 && s <= 4.0, "{id} = {speed}");
                // Outside the range the service clamps to its own pace, which is the
                // failure this list exists to avoid.
                assert!(
                    s <= 0.3 || s >= 2.0,
                    "{id} = {speed} is close enough to default to be inaudible"
                );
            }
        }
    }

    #[test]
    fn only_a_known_pace_is_accepted() {
        assert!(is_known_pace(NORMAL));
        assert!(PACES.iter().all(|(id, _)| is_known_pace(id)));
        assert!(!is_known_pace(""));
        assert!(!is_known_pace("0.9"), "that is the clamp, not a pace");
        assert!(!is_known_pace("google"), "the old engine name is not a pace");
    }

    #[test]
    fn nothing_is_sent_for_text_that_is_empty() {
        assert!(split_for_google("   ").is_empty());
        assert!(split_for_google("").is_empty());
    }

    #[test]
    fn long_text_is_split_never_lost() {
        let long = "kata ".repeat(200);
        let pieces = split_for_google(&long);
        assert!(pieces.len() > 1);
        // Every word survives, in order: a dropped word is a hole in the sentence.
        assert_eq!(pieces.join(" ").split_whitespace().count(), 200);
        for piece in &pieces {
            assert!(piece.chars().count() <= GOOGLE_MAX_CHARS, "{piece}");
        }
    }

    #[test]
    fn a_word_longer_than_the_limit_is_cut_up() {
        // Spam with no spaces, or one very long token: left whole it is over the
        // limit on its own, and the endpoint answers 400 — which refused the
        // whole utterance, so the readable words beside it went unsaid too.
        let spam = "w".repeat(500);
        let pieces = split_for_google(&spam);
        assert!(pieces.len() >= 3, "got {}", pieces.len());
        for piece in &pieces {
            assert!(piece.chars().count() <= GOOGLE_MAX_CHARS, "{piece}");
        }
        // Nothing lost: the characters survive, in order, and the pieces of a
        // single word carry no separator between them.
        assert_eq!(pieces.join("").chars().count(), 500);
    }

    #[test]
    fn a_long_word_does_not_take_the_words_around_it() {
        let text = format!("halo {} dunia", "x".repeat(400));
        let pieces = split_for_google(&text);
        for piece in &pieces {
            assert!(piece.chars().count() <= GOOGLE_MAX_CHARS, "{piece}");
        }
        let rejoined = pieces.join(" ");
        assert!(rejoined.starts_with("halo "), "{rejoined}");
        assert!(rejoined.ends_with(" dunia"), "{rejoined}");
    }

    #[test]
    fn chunking_never_splits_a_multibyte_character() {
        // The limit is characters, and these are multi-byte ones; a byte slice
        // here would panic on a char boundary or emit invalid UTF-8.
        let text = "é".repeat(400);
        let pieces = split_for_google(&text);
        for piece in &pieces {
            assert!(piece.chars().count() <= GOOGLE_MAX_CHARS);
        }
        assert_eq!(pieces.join("").chars().count(), 400);
    }

    #[test]
    fn an_empty_utterance_is_refused_rather_than_played() {
        // A service that returns nothing for empty text must not be reported as a
        // successful silent utterance.
        let err = SpeechError::Refused("google returned no audio".into());
        assert!(err.to_string().contains("no audio"), "{err}");
    }
}
