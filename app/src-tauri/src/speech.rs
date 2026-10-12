//! Reading chat aloud, with a neural voice.
//!
//! The platform's own speech synthesiser is a formant synthesiser: it works, and
//! it sounds like a screen reader from 2003. This talks to a neural voice over the
//! network instead — free, no API key, and the difference between the two is the
//! difference between reading a chat and hearing one.
//!
//! Two engines, Google first. The Google Translate read-aloud endpoint is a plain
//! HTTP GET that returns MP3, which is the simplest thing that can work and the
//! reason it is tried first. It is also **undocumented** — Google ships no contract
//! for it — so it can change or vanish without notice, which is exactly why Edge's
//! Read Aloud is the fallback: same quality, a service Google does not control.
//! `say` tries Google and, on any failure, falls back to Edge, so a chat is read
//! by whichever engine is up rather than going silent because one moved.
//!
//! The trade is written down rather than buried, because it is the one thing about
//! this module that is not obvious from the code: **the text being spoken is sent
//! to Google (or, on fallback, Microsoft) to be spoken.** There is no local option
//! that sounds this good, so the app asks for it in settings rather than assuming
//! it, and a user who wants nothing to leave the machine can leave it off and get
//! silence.
//!
//! The Edge connection is kept open across utterances. Chat arrives several a
//! second in an active room, and opening a WebSocket per message would spend the
//! whole latency budget on handshakes — the voice would fall a sentence behind the
//! room it is reading.

use async_tungstenite::tokio::ConnectStream;
use msedge_tts::tts::{
    SpeechConfig,
    stream::{SynthesizedResponse, tokio_runtime as stream},
};

/// One open connection, reused across utterances.
///
/// Held behind a mutex because two messages can arrive close enough together that
/// both want to speak, and the sender/receiver pair is a single duplex stream —
/// interleaving two syntheses on it produces garbled audio for both.
pub struct Speech {
    sender: tokio::sync::Mutex<stream::SenderAsync<ConnectStream>>,
    receiver: tokio::sync::Mutex<stream::ReceiverAsync<ConnectStream>>,
}

/// The Google read-aloud endpoint. Undocumented: Google ships no contract for it,
/// which is the whole reason Edge is the fallback.
const GOOGLE_TTS_URL: &str = "https://translate.google.com/translate_tts";

/// The language code Google is asked for. Indonesian, matching the Edge voice.
const GOOGLE_LANG: &str = "id";

/// The `client` token the endpoint expects. `tw-ob` is what the translate page
/// itself sends; without it the request is refused.
const GOOGLE_CLIENT: &str = "tw-ob";

/// The longest text the endpoint accepts in one request.
///
/// Past this it answers 400 rather than truncating, so text is split here and the
/// pieces spoken in order. The limit is not documented and has moved before; the
/// value is deliberately under the observed ceiling so a chat line that happens to
/// be long is still spoken rather than dropped.
const GOOGLE_MAX_CHARS: usize = 180;

/// A browser user-agent.
///
/// The endpoint is reached by the translate page from a browser, and it answers a
/// bare client differently — a plain `reqwest` default is refused. This is the one
/// header that makes the request look like the thing the endpoint is for.
const GOOGLE_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/// How long to wait on Google before giving up and falling back to Edge.
///
/// A voice that is late is worse than one that switched engines: the room has moved
/// on by the time a slow answer arrives. Short enough that the fallback still reads
/// the line while it is current.
const GOOGLE_TIMEOUT_SECS: u64 = 6;

/// Splits text into pieces the endpoint will each accept, on whitespace.
///
/// Never splits a word: a piece is built up word by word until the next word would
/// cross the limit, so each piece is whole words and the join is seamless. A word
/// longer than the limit on its own is its own piece rather than dropped.
fn split_for_google(text: &str) -> Vec<String> {
    let mut pieces: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        if !current.is_empty() && current.chars().count() + 1 + word.chars().count() > GOOGLE_MAX_CHARS {
            pieces.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        pieces.push(current);
    }
    pieces
}

/// Speaks text with Google's read-aloud endpoint, returning MP3 bytes.
///
/// Each piece is a separate GET and the audio is concatenated — MP3 is a stream of
/// independent frames, so joining the pieces plays as one continuous utterance with
/// no seam. Any failure — unreachable, refused, no audio — is an `Err`, which the
/// caller turns into a fallback rather than silence.
async fn google_say(text: &str) -> Result<Vec<u8>, SpeechError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(GOOGLE_TIMEOUT_SECS))
        .build()
        .map_err(|e| SpeechError::Unreachable(e.to_string()))?;

    let mut audio: Vec<u8> = Vec::new();
    for piece in split_for_google(text) {
        // reqwest encodes the query, so the text is passed as a value and not
        // hand-escaped. The parameter names and the endpoint are the parts that
        // matter and they are the literal ones the translate page sends.
        let response = client
            .get(GOOGLE_TTS_URL)
            .query(&[
                ("ie", "UTF-8"),
                ("q", piece.as_str()),
                ("tl", GOOGLE_LANG),
                ("client", GOOGLE_CLIENT),
            ])
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

/// The voice. Indonesian, female, neural.
///
/// One voice rather than a picker: the app reads an Indonesian chat, and a list of
/// two hundred voices is a setting nobody finishes choosing. This one is the
/// default for the language and reads Indonesian naturally.
pub const VOICE: &str = "id-ID-GadisNeural";

/// The audio format Edge is asked for.
///
/// MP3 at 24kHz: what the service suggests for this voice, small enough that a
/// sentence is a few tens of kilobytes, and what every browser decodes without a
/// second codec.
const AUDIO_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";

/// How much faster than natural pace.
///
/// Slightly quick, because the room is moving: a voice reading at natural pace
/// falls behind a chat that is still arriving, and the point is to hear what is
/// being said roughly as it is said.
const RATE: i32 = 10;

/// Why a synthesis failed.
#[derive(Debug)]
pub enum SpeechError {
    /// The service could not be reached, or the connection dropped.
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

fn config() -> SpeechConfig {
    SpeechConfig {
        voice_name: VOICE.to_string(),
        audio_format: AUDIO_FORMAT.to_string(),
        pitch: 0,
        rate: RATE,
        volume: 0,
    }
}

impl Speech {
    /// Opens a connection to the voice service.
    pub async fn connect() -> Result<Self, SpeechError> {
        let (sender, receiver) = stream::msedge_tts_split_async()
            .await
            .map_err(|e| SpeechError::Unreachable(e.to_string()))?;
        Ok(Self {
            sender: tokio::sync::Mutex::new(sender),
            receiver: tokio::sync::Mutex::new(receiver),
        })
    }

    /// Speaks one utterance and returns the audio as MP3 bytes.
    ///
    /// Google first, Edge on any failure. The two produce the same format — MP3 at
    /// 24kHz mono — so the caller cannot tell which engine answered and does not
    /// need to. A chat is read by whichever engine is up rather than going silent
    /// because the undocumented one moved, which is the whole point of the fallback.
    ///
    /// Serialised through both mutexes for the whole round trip: one utterance at a
    /// time, start to finish. Two messages arriving together are spoken one after
    /// the other rather than mixed, which is what the caller's gap already
    /// arranges — this is the backstop for the case where the gap did not apply.
    pub async fn say(&self, text: &str) -> Result<Vec<u8>, SpeechError> {
        // The Edge round trip holds the connection mutexes; Google is a plain HTTP
        // call that touches none of them, so it is tried before they are taken and
        // a fallback does not have to unwind a locked connection.
        match google_say(text).await {
            Ok(audio) => return Ok(audio),
            Err(_) => { /* fall through to Edge below */ }
        }

        let mut sender = self.sender.lock().await;
        let mut receiver = self.receiver.lock().await;

        sender
            .send(text, &config())
            .await
            .map_err(|e| SpeechError::Unreachable(e.to_string()))?;

        let mut audio = Vec::new();
        loop {
            match receiver.read().await {
                Ok(Some(SynthesizedResponse::AudioBytes(bytes))) => audio.extend_from_slice(&bytes),
                // Word boundaries and timings: the service sends them alongside the
                // audio, and nothing here reads a transcript back off them.
                Ok(Some(SynthesizedResponse::AudioMetadata(_))) => {}
                // The turn is over: everything the service had for this utterance
                // has arrived.
                Ok(None) => break,
                Err(e) => return Err(SpeechError::Refused(e.to_string())),
            }
        }

        if audio.is_empty() {
            return Err(SpeechError::Refused("the voice returned no audio".into()));
        }
        Ok(audio)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_voice_is_indonesian_and_neural() {
        // A voice name that is neither would read an Indonesian chat in the wrong
        // language or with the robotic platform voice this module exists to avoid.
        assert!(VOICE.starts_with("id-ID"), "{VOICE}");
        assert!(VOICE.ends_with("Neural"), "{VOICE}");
    }

    #[test]
    fn the_config_is_what_the_service_suggests() {
        let config = config();
        assert_eq!(config.voice_name, VOICE);
        assert_eq!(config.audio_format, AUDIO_FORMAT);
        // Quickened, but not so much it stops being listenable: the room is moving
        // and a voice at natural pace falls behind it.
        assert!(config.rate > 0 && config.rate <= 25, "{}", config.rate);
        // Pitch and volume left alone: a chat read at a shifted pitch reads as a
        // joke, and the player already owns the level.
        assert_eq!(config.pitch, 0);
        assert_eq!(config.volume, 0);
    }

    #[test]
    fn an_empty_utterance_is_refused_rather_than_played() {
        // The caller trims before asking, but a service that returns nothing for
        // empty text must not be reported as a successful silent utterance.
        let err = SpeechError::Refused("the voice returned no audio".into());
        assert!(err.to_string().contains("no audio"), "{err}");
    }
}
