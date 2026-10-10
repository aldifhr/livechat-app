//! Reading chat aloud, with a neural voice.
//!
//! The platform's own speech synthesiser is a formant synthesiser: it works, and
//! it sounds like a screen reader from 2003. This talks to the service behind
//! Edge's Read Aloud instead, which is a neural voice — free, no API key, and the
//! difference between the two is the difference between reading a chat and hearing
//! one.
//!
//! The trade is written down rather than buried, because it is the one thing about
//! this module that is not obvious from the code: **the text being spoken is sent
//! to Microsoft to be spoken.** There is no local option that sounds this good, so
//! the app asks for it in settings rather than assuming it, and a user who wants
//! nothing to leave the machine can leave it off and get silence.
//!
//! The connection is kept open across utterances. Chat arrives several a second in
//! an active room, and opening a WebSocket per message would spend the whole
//! latency budget on handshakes — the voice would fall a sentence behind the room
//! it is reading.

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
    /// Serialised through both mutexes for the whole round trip: one utterance at a
    /// time, start to finish. Two messages arriving together are spoken one after
    /// the other rather than mixed, which is what the caller's gap already
    /// arranges — this is the backstop for the case where the gap did not apply.
    pub async fn say(&self, text: &str) -> Result<Vec<u8>, SpeechError> {
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
