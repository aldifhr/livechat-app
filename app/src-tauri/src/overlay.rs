//! The rule for what counts as the app's own overlay page.
//!
//! The overlay itself is served by the backend, not by this app: `overlay_url`
//! hands out a `{backend}/overlay/…` link and OBS fetches it straight from there,
//! so the page works whether or not this app is running and on any machine. There
//! is no local server any more — a loopback copy would only ever work on the one
//! machine streaming, which is the exact thing the backend-hosted overlay
//! replaced.
//!
//! What is left is the one thing that still has to live host-side: `overlay_open`
//! receives a URL from the page and hands it to the OS to open in a browser, and
//! an opener that takes any string is an opener that will eventually launch
//! whatever a compromised page asks for. So the URL is checked here, against the
//! backend's own overlay prefix, before anything is done with it.

/// Whether a URL is this app's own overlay page, and safe to hand to the OS.
///
/// `backend_overlay_prefix` is the `{backend}/overlay/` prefix built from the
/// saved config — the same address `overlay_url` hands out. The URL must start
/// with it, and the remainder is bounded: long enough for the styling parameters
/// and a handle, short enough that a megabyte of query string never reaches the
/// OS, and free of control characters so nothing smuggles a newline into whatever
/// ends up logging or shelling out the open.
///
/// A prefix check is enough on its own: everything after the prefix is a path, a
/// query or a fragment, and none of those can send the browser to another origin.
/// A `?base=https://elsewhere` in particular is the overlay reading its own
/// configuration, not a redirect, so the query string is deliberately not
/// second-guessed.
pub fn is_own_page(url: &str, backend_overlay_prefix: &str) -> bool {
    // An empty prefix means no backend is configured, and then there is no page
    // this app will open — rather than a fallback that accepts any overlay-shaped
    // URL.
    if backend_overlay_prefix.is_empty() {
        return false
    }
    let Some(rest) = url.strip_prefix(backend_overlay_prefix) else {
        return false
    };
    rest.len() <= 1024 && !rest.chars().any(|c| c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PREFIX: &str = "https://kit-backend.aldifhr.my.id/overlay/";

    #[test]
    fn the_backend_overlay_url_is_its_own() {
        // What OBS is pointed at, so a browser source can live on any machine.
        assert!(is_own_page(PREFIX, PREFIX));
        assert!(is_own_page("https://kit-backend.aldifhr.my.id/overlay/?room=ana&size=22", PREFIX));
    }

    #[test]
    fn another_host_is_refused() {
        // The prefix is the whole rule: a URL that merely contains the overlay
        // path on a different host is not this app's overlay.
        assert!(!is_own_page("https://evil.example/overlay/?room=ana", PREFIX));
        assert!(!is_own_page("https://kit-backend.aldifhr.my.id.evil.example/overlay/", PREFIX));
    }

    #[test]
    fn a_different_path_on_the_backend_is_refused() {
        // The backend serves more than the overlay; only the overlay prefix opens,
        // not the domain root and not a lookalike path.
        assert!(!is_own_page("https://kit-backend.aldifhr.my.id/", PREFIX));
        assert!(!is_own_page("https://kit-backend.aldifhr.my.id/api/rooms", PREFIX));
        assert!(!is_own_page("https://kit-backend.aldifhr.my.id/overlay-evil/", PREFIX));
    }

    #[test]
    fn an_empty_prefix_opens_nothing() {
        // No configured backend means no page this app will open, rather than a
        // fallback that would accept any overlay-looking URL.
        assert!(!is_own_page(PREFIX, ""));
    }

    #[test]
    fn the_query_string_is_not_second_guessed() {
        // The overlay reads its own backend out of the query string, and a `//` in
        // there is that address, not a protocol-relative redirect.
        assert!(is_own_page("https://kit-backend.aldifhr.my.id/overlay/?base=https://elsewhere.test", PREFIX));
    }

    #[test]
    fn an_absurdly_long_url_is_refused() {
        let long = format!("{PREFIX}?q={}", "a".repeat(2000));
        assert!(!is_own_page(&long, PREFIX));
    }

    #[test]
    fn a_control_character_is_refused() {
        // A newline in the tail could split whatever logs or shells the open.
        assert!(!is_own_page("https://kit-backend.aldifhr.my.id/overlay/?x\ninjected", PREFIX));
    }
}
