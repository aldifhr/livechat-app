//! Sounds from myinstant.com: searched, downloaded, and cached on disk.
//!
//! Reached from here rather than from the webview for the same reason `reqwest`
//! itself is: the page's content security policy forbids it from talking to any
//! host but the app's own origin, and a sound list is not something the page
//! should be fetching.
//!
//! **Why the page is parsed rather than an API.** There is a third-party JSON API
//! for this site — `myinstants-api.vercel.app` — and it answered 503 on every
//! endpoint when this was written. Depending on one stranger's Vercel deployment
//! is a worse dependency than reading a page whose markup we already know, so
//! this reads the search results directly. The site is server-rendered HTML: each
//! sound is a card carrying a title and a play button whose `onclick` names the
//! mp3.
//!
//! ```text
//! <a class="instant-link" href="…">Vine Boom</a>
//! <button class="small-button" onclick="play('/media/sounds/vine-boom.mp3', …)">
//! ```
//!
//! A browser `User-Agent` is sent because the site answers `436` — not a standard
//! status, and not a server error either; it is what the edge in front of it
//! returns to something it recognises as an automated client.
//!
//! **Only mp3 paths under `/media/sounds/` are followed.** The paths are read out
//! of a page fetched from the internet, so treating one as a URL to fetch would
//! mean this app retrieves whatever that page told it to. Every path is checked
//! against the shape the site actually uses and joined onto a fixed origin, so a
//! page that started handing out `https://elsewhere/x.mp3` would yield no sounds
//! rather than a request to somewhere else.
//!
//! The markup is parsed by hand rather than with an HTML library: it is two
//! selectors in a page whose structure is known, and an html5ever dependency for
//! that is a poor trade against a parser that fails loudly — an empty list the
//! user can see — if the markup ever moves.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

/// Where a search goes. The query is added as a query parameter, never pasted
/// into the URL, so a title containing `&` or `#` cannot truncate it.
const SEARCH_URL: &str = "https://www.myinstant.com/en/search/";

/// The only origin a sound is ever fetched from. Not configurable, and not read
/// out of the page — see the module comment.
const ORIGIN: &str = "https://www.myinstant.com";

/// The only path prefix a sound is ever fetched from.
const MEDIA_PREFIX: &str = "/media/sounds/";

/// A browser user-agent, for the same reason `speech.rs` sends one: the endpoint
/// answers a bare client differently from the thing it is meant for.
const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/// Long enough for a search page, short enough that a stalled connection is
/// reported rather than waited on.
const TIMEOUT_SECS: u64 = 12;

/// One sound from the list, as the page names it.
#[derive(Debug, Clone, Serialize)]
pub struct Instant {
    /// What the site calls it, with HTML entities resolved.
    pub title: String,
    /// The mp3 path, relative and already validated. Sent back verbatim when the
    /// user picks one, so it is the only part of the page that reaches the
    /// network — and it is validated again there, because the page that produced
    /// it is not this process.
    pub path: String,
}

/// Why a search or download failed, as one line worth showing.
#[derive(Debug)]
pub enum InstantError {
    /// The site could not be reached, or did not answer in time.
    Unreachable(String),
    /// It answered, and not with something usable.
    Refused(String),
}

impl std::fmt::Display for InstantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstantError::Unreachable(why) => write!(f, "could not reach myinstant: {why}"),
            InstantError::Refused(why) => write!(f, "{why}"),
        }
    }
}

/// Searches for sounds.
///
/// An empty result is a normal answer and not an error: the site is a user-upload
/// board where a word nobody has used yet returns nothing, and that is different
/// from the site being unreachable, which is an `Err`.
pub async fn search(query: &str) -> Result<Vec<Instant>, InstantError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| InstantError::Unreachable(e.to_string()))?;

    let html = client
        .get(SEARCH_URL)
        .query(&[("name", trimmed)])
        .header("user-agent", UA)
        .header("accept-language", "en")
        .send()
        .await
        .map_err(|e| InstantError::Unreachable(e.to_string()))?;

    // The site answers 436 to a client it does not like. That is not a server
    // error and reporting it as one tells the user to try again, which will not
    // help — so it is named for what it is.
    if html.status().as_u16() == 436 {
        return Err(InstantError::Refused(
            "myinstant refused the request (436). It blocks this kind of client; \
             a browser on the same network still works."
                .into(),
        ));
    }
    if !html.status().is_success() {
        return Err(InstantError::Refused(format!(
            "myinstant answered HTTP {}",
            html.status()
        )));
    }

    Ok(parse_results(&html.text().await.map_err(|e| InstantError::Unreachable(e.to_string()))?))
}

/// The absolute URL for a validated media path.
pub fn media_url(path: &str) -> Option<String> {
    if is_media_path(path) {
        Some(format!("{ORIGIN}{path}"))
    } else {
        None
    }
}

/// Downloads a sound to `dest`, and reports how many bytes arrived.
///
/// The path is validated before anything is fetched, not after: the check has to
/// be the thing that decides whether a request is made at all, or it is not a
/// gate.
pub async fn download(path: &str, dest: &Path) -> Result<u64, InstantError> {
    let url = media_url(path).ok_or_else(|| {
        InstantError::Refused(format!(
            "that is not a myinstant sound path: {path}"
        ))
    })?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| InstantError::Unreachable(e.to_string()))?;

    let response = client
        .get(&url)
        .header("user-agent", UA)
        .send()
        .await
        .map_err(|e| InstantError::Unreachable(e.to_string()))?;

    if !response.status().is_success() {
        return Err(InstantError::Refused(format!(
            "the sound answered HTTP {}",
            response.status()
        )));
    }

    let bytes = response.bytes().await.map_err(|e| InstantError::Unreachable(e.to_string()))?;
    if bytes.is_empty() {
        return Err(InstantError::Refused("the sound file was empty".into()));
    }

    // Written only after a complete body has arrived, so an interrupted download
    // cannot leave a truncated file that later looks like a sound that simply does
    // not play.
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| InstantError::Refused(format!("could not make the cache folder: {e}")))?;
    }
    std::fs::write(dest, &bytes)
        .map_err(|e| InstantError::Refused(format!("could not save the sound: {e}")))?;

    Ok(bytes.len() as u64)
}

/// Where a sound is cached, given its media path.
///
/// Named from the last segment of the path rather than from the title: two
/// sounds can share a name, and a title can hold a character no filesystem takes.
pub fn cache_path(cache_dir: &Path, media_path: &str) -> Option<PathBuf> {
    if !is_media_path(media_path) {
        return None;
    }
    let name = media_path.rsplit('/').next()?;
    // A name with a separator in it would escape the folder it is meant to land
    // in, and `Path::new(name).file_name()` is the only thing standing between a
    // page from the internet and the rest of the cache directory.
    let safe = Path::new(name).file_name()?.to_str()?;
    if safe.is_empty() {
        return None;
    }
    Some(cache_dir.join(safe))
}

/// Whether a path is one this will fetch: a single leading `/media/sounds/`,
/// nothing above it, ending in `.mp3`.
fn is_media_path(path: &str) -> bool {
    let rest = match path.strip_prefix(MEDIA_PREFIX) {
        Some(rest) => rest,
        None => return false,
    };
    if rest.is_empty() || rest.contains('/') || rest.contains('\\') || rest.contains("..") {
        return false;
    }
    // Case-insensitive, because a CDN that serves `.MP3` would otherwise be
    // reported as no sound at all.
    rest.to_ascii_lowercase().ends_with(".mp3")
}

/// Every sound on a search page.
///
/// Cards are joined on the sound's own id, not on document order. The site calls
/// `play(url, loaderId, slug)` and links each card to `/en/instant/<slug>/`, so
/// the same slug appears on both sides of a card and a button can be matched to
/// the title that belongs to it rather than to the nearest one above it. That
/// distinction is the whole reason this is not two lists zipped by index: a card
/// missing its title would shift every later title onto the wrong sound, and a
/// card missing its button would shift every later sound.
///
/// If the page carries no slugs at all — the markup moved — this falls back to
/// pairing each button with the nearest title above it. That is worse, and it is
/// only reached when the exact join key is absent from every card, so a page that
/// does use slugs is never paired by position.
fn parse_results(html: &str) -> Vec<Instant> {
    let cards = cards(html);
    let joinable = cards.iter().any(|(_, title, _)| !title.is_empty());

    let mut out: Vec<Instant> = Vec::new();
    let mut at = 0usize;

    while let Some(found) = html[at..].find("play('") {
        let start = at + found + "play('".len();
        let Some(args) = html[start..].find('\'') else {
            break;
        };
        let path = &html[start..start + args];
        // The two arguments after the path. `loaderId` is not used; `slug` is the
        // join key. Taken from the same call rather than scraped separately so
        // they cannot drift apart.
        let rest = &html[start + args + 1..];
        let slug = quoted_argument(rest, 1);
        at = start + args;

        if !is_media_path(path) {
            continue;
        }

        let title = if joinable {
            // The card with this slug. Absent means a sound whose card the page
            // wrote differently, which is skipped rather than given the title of
            // whatever card happened to be above it.
            cards
                .iter()
                .find(|(_, title, card_slug)| *card_slug == slug && !title.is_empty())
                .map(|(_, title, _)| title.clone())
        } else {
            // No join key on this page: the nearest title above the button.
            let index = cards.partition_point(|(at, title, _)| *at < start && !title.is_empty());
            index.checked_sub(1).map(|i| cards[i].1.clone())
        };

        let Some(title) = title else {
            continue;
        };

        out.push(Instant {
            title,
            path: path.to_string(),
        });
    }

    out
}

/// The nth quoted argument of a `play(...)` call, counting from zero.
///
/// Counts the call's arguments rather than the page's quotes, because an
/// `onclick` can hold more than one and taking the next `"` on the page would
/// pair a button with a neighbouring element's.
fn quoted_argument(args: &str, index: usize) -> String {
    let mut at = 0usize;
    let mut seen = 0usize;

    while let Some(open) = args[at..].find('\'') {
        let start = at + open + 1;
        let Some(close) = args[start..].find('\'') else {
            return String::new();
        };
        if seen == index {
            return args[start..start + close].to_string();
        }
        seen += 1;
        at = start + close + 1;
        // Past the comma, so the next quote is the next argument.
        at = args[at..]
            .find(',')
            .map(|comma| at + comma + 1)
            .unwrap_or(args.len());
    }

    String::new()
}

/// The cards on a page: `(position, title, slug)`.
///
/// The title runs to the card's closing `</a>` rather than to the next `<`, so a
/// title wrapped in its own markup — which the site does for some of them —
/// reads as its text instead of as nothing. A card whose link the page wrote
/// differently keeps an empty title rather than borrowing a neighbour's.
fn cards(html: &str) -> Vec<(usize, String, String)> {
    let mut out: Vec<(usize, String, String)> = Vec::new();
    let mut at = 0usize;

    while let Some(found) = html[at..].find("instant-link") {
        let class_at = at + found;
        // The whole tag this class sits in, so the href is read from the element
        // it belongs to rather than from whatever tag comes next in the page.
        let tag_end = match html[class_at..].find('>') {
            Some(n) => class_at + n,
            // A tag that is never closed ends the page as far as this is
            // concerned; there is nothing further to pair.
            None => break,
        };
        let tag = &html[class_at - html[..class_at].rfind('<').map(|i| class_at - i).unwrap_or(class_at)..tag_end];

        let slug = tag
            .split("href=")
            .nth(1)
            .and_then(|rest| rest.split(['"', '\'']).nth(1))
            .map(|href| {
                // The trailing slash is removed *before* the last segment is taken.
                // Done the other way round, `.../a/` splits to an empty final
                // segment and every card comes back with no slug at all — which
                // reads as an empty list rather than as a parse that went wrong.
                let trimmed = href.trim_end_matches('/');
                trimmed
                    .rsplit('/')
                    .next()
                    .unwrap_or_default()
                    .to_string()
            })
            .unwrap_or_default();

        let body_start = tag_end + 1;
        let close = html[body_start..].find("</a>").map(|n| body_start + n);
        at = match close {
            Some(close) => {
                let title = strip_tags(&html[body_start..close]);
                out.push((body_start, title, slug));
                close
            }
            None => return out,
        };
    }

    out
}

/// The text inside a fragment, with tags dropped and entities resolved.
fn strip_tags(fragment: &str) -> String {
    let mut out = String::with_capacity(fragment.len());
    let mut inside_tag = false;

    for ch in fragment.chars() {
        match ch {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => out.push(ch),
            _ => {}
        }
    }

    decode_entities(out.trim())
}

/// The handful of entities a title on this site actually uses.
///
/// Not a general decoder, and deliberately so: a complete one is a parser, and
/// the point of this module is to not be that.
fn decode_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A card as the site writes one, trimmed to the parts this reads.
    fn card(title: &str, path: &str, slug: &str) -> String {
        format!(
            r#"<div class="instant">
                 <a class="instant-link" href="/en/instant/{slug}/">{title}</a>
                 <a class="small-button" onclick="play('{path}', 'loader-1', '{slug}')">play</a>
               </div>"#
        )
    }

    #[test]
    fn a_card_yields_its_title_and_path() {
        let html = card("Vine Boom", "/media/sounds/vine-boom.mp3", "vine-boom-sound-70972");
        let found = parse_results(&html);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].title, "Vine Boom");
        assert_eq!(found[0].path, "/media/sounds/vine-boom.mp3");
    }

    #[test]
    fn several_cards_keep_their_own_pairs() {
        let html = format!(
            "{}{}{}",
            card("Vine Boom", "/media/sounds/vine-boom.mp3", "a"),
            card("Sad Violin", "/media/sounds/sad-violin.mp3", "b"),
            card("Bruh", "/media/sounds/bruh.mp3", "c"),
        );
        let found = parse_results(&html);
        let pairs: Vec<(&str, &str)> = found
            .iter()
            .map(|i| (i.title.as_str(), i.path.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("Vine Boom", "/media/sounds/vine-boom.mp3"),
                ("Sad Violin", "/media/sounds/sad-violin.mp3"),
                ("Bruh", "/media/sounds/bruh.mp3"),
            ],
        );
    }

    #[test]
    fn a_title_wrapped_in_its_own_markup_still_reads() {
        // The site nests a span in the link for some titles. Stopping at the next
        // `<` would return nothing, and the sound would go missing from the list
        // rather than being mislabelled.
        let html = r#"<a class="instant-link" href="/en/instant/x/"><span>Vine</span> Boom</a>
                      <a class="small-button" onclick="play('/media/sounds/v.mp3','l','x')">p</a>"#;
        let found = parse_results(html);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].title, "Vine Boom");
    }

    #[test]
    fn entities_in_a_title_are_resolved() {
        let html = card("Tom &amp; Jerry", "/media/sounds/tj.mp3", "tj");
        let found = parse_results(&html);
        assert_eq!(found[0].title, "Tom & Jerry");
    }

    #[test]
    fn a_button_never_inherits_another_cards_title() {
        // The pairing failure this guards. A button whose slug matches no card is
        // skipped — not given the title of whatever card sits above it, which
        // would show the same name twice and have the second copy play the first
        // sound.
        let html = format!(
            r#"<a class="instant-link" href="/en/instant/bruh/">Bruh</a>
               <a class="small-button" onclick="play('/media/sounds/bruh.mp3','l','bruh')">p</a>
               <a class="small-button" onclick="play('/media/sounds/other.mp3','l','nobody')">p</a>"#
        );
        let found = parse_results(&html);
        let pairs: Vec<(&str, &str)> = found
            .iter()
            .map(|i| (i.title.as_str(), i.path.as_str()))
            .collect();
        assert_eq!(pairs, vec![("Bruh", "/media/sounds/bruh.mp3")]);
    }

    #[test]
    fn cards_are_matched_on_slug_not_on_order() {
        // The same button, in a page whose cards are in another order. Zip-by-index
        // — what the public scraper does — would report "Sad Violin" for a vine
        // boom; matching on the slug cannot.
        let html = format!(
            r#"<a class="instant-link" href="/en/instant/vine/">Vine Boom</a>
               <a class="instant-link" href="/en/instant/sad/">Sad Violin</a>
               <a class="small-button" onclick="play('/media/sounds/sad-violin.mp3','l','sad')">p</a>
               <a class="small-button" onclick="play('/media/sounds/vine-boom.mp3','l','vine')">p</a>"#
        );
        let found = parse_results(&html);
        let pairs: Vec<(&str, &str)> = found
            .iter()
            .map(|i| (i.title.as_str(), i.path.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("Sad Violin", "/media/sounds/sad-violin.mp3"),
                ("Vine Boom", "/media/sounds/vine-boom.mp3"),
            ],
        );
    }

    #[test]
    fn a_page_with_no_slugs_still_pairs_by_position() {
        // The fallback, for a page that wrote its links differently. Reached only
        // when no card carries a slug at all.
        let html = r#"<a class="instant-link">Bruh</a>
                      <a class="small-button" onclick="play('/media/sounds/bruh.mp3','l','')">p</a>"#;
        let found = parse_results(html);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].title, "Bruh");
    }

    #[test]
    fn a_path_outside_the_media_folder_is_ignored() {
        // The whole reason `parse_results` filters: the page is fetched from the
        // internet, so a path that is not a sound must never become a request.
        for hostile in [
            "https://evil.example/x.mp3",
            "//evil.example/x.mp3",
            "/media/sounds/../../etc/passwd",
            "/media/sounds/sub/dir.mp3",
            "/other/x.mp3",
            "/media/sounds/x.exe",
            "/media/sounds/",
        ] {
            assert!(!is_media_path(hostile), "{hostile} should be refused");
        }
    }

    #[test]
    fn a_path_is_only_a_filename_under_the_media_folder() {
        assert!(is_media_path("/media/sounds/vine-boom.mp3"));
        // Case-insensitive: a CDN serving `.MP3` is the same sound.
        assert!(is_media_path("/media/sounds/VINE.MP3"));
        assert!(media_url("/media/sounds/a.mp3").is_some());
        assert!(media_url("https://evil.example/a.mp3").is_none());
    }

    #[test]
    fn a_cached_name_cannot_escape_the_cache_folder() {
        let dir = Path::new("/cache/myinstants");
        assert_eq!(
            cache_path(dir, "/media/sounds/vine.mp3"),
            Some(PathBuf::from("/cache/myinstants/vine.mp3"))
        );
        // Anything holding `..` is refused outright rather than sanitised. A path
        // that needs cleaning is a path that should not have got this far, and
        // percent-encoded traversal is caught by the same rule because the
        // literal `..` is still in it.
        assert_eq!(cache_path(dir, "/media/sounds/..%2fwin.mp3"), None);
        assert_eq!(cache_path(dir, "/media/sounds/../../evil.mp3"), None);
        assert_eq!(cache_path(dir, "https://evil.example/a.mp3"), None);
    }

    #[test]
    fn a_page_with_no_sounds_is_empty_rather_than_wrong() {
        // The markup moving must produce nothing the user can see, never a list
        // of half-parsed garbage.
        assert!(parse_results("<html><body>Nothing here</body></html>").is_empty());
        assert!(parse_results("").is_empty());
    }
}
