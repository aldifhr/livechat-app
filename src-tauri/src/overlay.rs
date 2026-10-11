//! The chat overlay, as a page something else can load.
//!
//! OBS wants a URL, so an overlay is an HTTP server whether or not that is a good
//! idea. This is the smallest thing that answers one: a fixed page on the
//! loopback interface, no routes worth the name, no request body, no parameters
//! the server acts on.
//!
//! Two decisions in here are the reason it is this small.
//!
//! **The page gets its own chat, rather than being fed from here.** It talks to
//! the StreamKit backend directly — the same socket the app opens, as a different
//! client type — so the overlay keeps working when this app is closed, and so
//! there is no event plumbing to keep in step with the app's. The hub targets
//! broadcasts by room id and not by client type, which is what makes a second
//! listener on the same room free rather than a new concept the backend has to
//! know about.
//!
//! **It binds 127.0.0.1 and nothing else.** There is no token, and it does not
//! need one: a page that shows one room's public chat, reachable only from the
//! machine already streaming, is not a capability worth a credential. Binding
//! every interface would be the thing that needed one.

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// The port the overlay is served on. Fixed rather than chosen at random.
///
/// A streamer sets this up once, points OBS at it, and forgets it. A port that
/// changed every launch would turn that into something to redo, and OBS browser
/// sources are not convenient to reconfigure.
pub const PORT: u16 = 4319;

/// The event channel the overlay logs on, so a failure reaches the app's own log.
///
/// The same channel and the same shape as everything else the host emits, rather
/// than a console line: the overlay server starting is the first thing a
/// streamer needs to know about, and the log panel is where they are already
/// looking when something is not working.
pub const EVENT: &str = "sidecar-event";

/// What the page is told before anyone has configured it.
///
/// Deliberately almost nothing. Every other knob travels in the query string,
/// which means a link can be edited by hand, pasted between machines, and read
/// back to answer "what is OBS actually pointed at". A server that held the
/// styling instead would make the URL a lie the moment anything was changed in
/// the app, and the page would keep showing the old answer until it was reloaded
/// from somewhere that knew.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayDefaults {
    /// The StreamKit backend the page reads from.
    pub base_url: String,
    /// The handle to show, so the bare URL works before anything is configured.
    pub username: String,
    pub port: u16,
}

/// The one token in the page this side replaces.
///
/// A placeholder rather than a second file fetched at runtime: an OBS browser
/// source is one request for one page, and a page that needed a second request to
/// become itself is a page that shows nothing at all for the moment between.
const PLACEHOLDER: &str = "__OVERLAY_CONFIG__";

/// The page, with its defaults written in.
pub fn page(defaults: &OverlayDefaults) -> String {
    // `unwrap_or_else` on a config that is two strings and a port: the only way it
    // fails to encode is a string that is not one, and there is nothing sensible
    // to show in an overlay instead.
    let config = json_for_script(&serde_json::to_string(defaults).unwrap_or_else(|_| "{}".to_string()));
    PAGE.replace(PLACEHOLDER, &config)
}

/// JSON made safe to sit inside a `<script>` element.
///
/// `serde_json` escapes quotes and control characters, which is enough for JSON
/// read by `JSON.parse` and not enough for JSON *written into a document*: it
/// leaves `<` and `>` alone, so a handle containing `</script>` ends the element
/// early and everything after it is parsed as markup. Both fields here come from
/// somewhere a user typed — the handle is a text field, the backend URL is a
/// file — and the one page that something else loads and renders on a stream is
/// the last place to leave that open.
///
/// The substitutions are to `<`, `>`, `&` and the two line separators. The first
/// three stop a tag being reconstituted from an escape; the last two are legal
/// inside a JSON string and terminate a line in JavaScript, which is a syntax
/// error there and nothing at all here.
fn json_for_script(json: &str) -> String {
    let mut safe = String::with_capacity(json.len());
    for ch in json.chars() {
        match ch {
            '<' => safe.push_str("\\u003c"),
            '>' => safe.push_str("\\u003e"),
            '&' => safe.push_str("\\u0026"),
            '\u{2028}' => safe.push_str("\\u2028"),
            '\u{2029}' => safe.push_str("\\u2029"),
            other => safe.push(other),
        }
    }
    safe
}

/// What a request was asking for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// The overlay itself.
    Page,
    /// A liveness check, so the app can say whether the port is actually ours.
    Health,
    /// Anything else.
    NotFound,
}

/// The routing decision, separated from the socket so it can be checked without
/// one.
pub fn route_of(head: &str) -> Route {
    // Only the request line is read. Nothing here takes a body and nothing here
    // takes headers, so parsing further is parsing input that cannot change the
    // answer.
    let request_line = match head.lines().next() {
        Some(line) => line,
        None => return Route::NotFound,
    };
    let mut parts = request_line.split_whitespace();
    // Both halves are required, not just the method. A request line carrying only
    // `GET` has no target, and reading the missing one as an empty path made the
    // empty path match — so a truncated request served the overlay.
    //
    // A page is fetched with GET and nothing else. Answering a POST the same way
    // would make the endpoint look more capable than it is.
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else {
        return Route::NotFound;
    };
    // The query string is the page's own configuration and is not this side's
    // business: the page reads it, and what it does with it is not the server's
    // decision.
    let path = target.split('?').next().unwrap_or("").trim_end_matches('/');
    match path {
        "" | "/index.html" | "/overlay" | "/overlay.html" => Route::Page,
        "/health" => Route::Health,
        _ => Route::NotFound,
    }
}

/// A whole response, headers and body.
fn response(status: &str, content_type: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    )
}

/// The response a route gets.
pub fn response_for(route: Route, defaults: &OverlayDefaults) -> String {
    match route {
        Route::Page => response("200 OK", "text/html; charset=utf-8", &page(defaults)),
        Route::Health => response("200 OK", "application/json", r#"{"ok":true}"#),
        // 404 rather than the page itself: a mistyped path should look like a
        // mistyped path, and silently serving the overlay would leave whoever is
        // setting it up wondering why their typo produced a working chat.
        Route::NotFound => response("404 Not Found", "text/plain; charset=utf-8", "not found\n"),
    }
}

/// The largest request head worth reading.
///
/// A GET this server answers has a one-line request and a short header block.
/// Anything past this is not one of ours, and reading a request with no end in
/// sight would let a single connection hold a task for as long as it liked.
const MAX_HEAD_BYTES: usize = 8 * 1024;

/// Starts the server, and keeps serving until the process ends.
///
/// Returns the reason it is not running rather than panicking: a port already in
/// use is something the streamer has to know about and can fix, and it must not
/// be the thing that stops the app opening.
pub async fn serve(defaults: OverlayDefaults) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", PORT))
        .await
        .map_err(|e| format!("port {PORT} is not available: {e}"))?;
    accept_loop(listener, defaults).await;
    Ok(())
}

/// Accepts and answers until the listener goes away.
///
/// Split out from `serve` so a test can bind a listener on a port of its own
/// choosing and drive the same loop. What a streamer needs proved is that
/// something answers on the address they are told to use, and that is a claim
/// about a socket rather than about a function — routing the right path through
/// the right function proves nothing about whether the socket ever opens.
async fn accept_loop(listener: TcpListener, defaults: OverlayDefaults) {
    loop {
        let (mut socket, _) = match listener.accept().await {
            Ok(pair) => pair,
            // One refused connection is not a reason to stop serving: the port is
            // bound, so this is a client that went away between the SYN and the
            // accept, and the next one is normally fine.
            Err(_) => continue,
        };

        let defaults = defaults.clone();
        tauri::async_runtime::spawn(async move {
            handle(&mut socket, &defaults).await;
        });
    }
}

/// Reads one request and answers it.
async fn handle(socket: &mut tokio::net::TcpStream, defaults: &OverlayDefaults) {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];

    // Read until the blank line that ends the headers. Bounded twice over: by the
    // end marker, and by a ceiling for the request that never sends one — a
    // client that opens a connection and then says nothing would otherwise hold
    // this task for as long as it liked.
    loop {
        if head.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if head.len() >= MAX_HEAD_BYTES {
            break;
        }
        match socket.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => head.extend_from_slice(&chunk[..n]),
            Err(_) => return,
        }
    }

    let text = String::from_utf8_lossy(&head);
    let reply = response_for(route_of(&text), defaults);

    // A write that fails means the client hung up mid-request, which is not worth
    // reporting: there is nothing left to report it to.
    let _ = socket.write_all(reply.as_bytes()).await;
    let _ = socket.flush().await;
}

const PAGE: &str = include_str!("../overlay/index.html");

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> OverlayDefaults {
        OverlayDefaults {
            base_url: "https://kit-backend.aldifhr.my.id".into(),
            username: "someone".into(),
            port: PORT,
        }
    }

    #[test]
    fn the_bare_path_is_the_overlay() {
        assert_eq!(route_of("GET / HTTP/1.1\r\nHost: x\r\n\r\n"), Route::Page);
        // What a browser sends with nothing on it, and what OBS sends with
        // settings on it. Both have to land on the same page.
        assert_eq!(route_of("GET /?room=abc HTTP/1.1\r\n"), Route::Page);
        assert_eq!(route_of("GET /overlay HTTP/1.1\r\n"), Route::Page);
        assert_eq!(route_of("GET /index.html HTTP/1.1\r\n"), Route::Page);
        // A trailing slash on the root is the same path.
        assert_eq!(route_of("GET // HTTP/1.1\r\n"), Route::Page);
    }

    #[test]
    fn health_is_its_own_route() {
        assert_eq!(route_of("GET /health HTTP/1.1\r\n"), Route::Health);
    }

    #[test]
    fn a_mistyped_path_is_not_the_overlay() {
        // Serving the overlay for anything would make a typo look like it worked,
        // and the streamer would find out during a live.
        assert_eq!(route_of("GET /chatt HTTP/1.1\r\n"), Route::NotFound);
        assert_eq!(route_of("GET /overlay.html.bak HTTP/1.1\r\n"), Route::NotFound);
    }

    #[test]
    fn only_get_is_answered() {
        // Nothing here takes a body. Answering a POST anyway would make the
        // endpoint look more capable than it is.
        assert_eq!(route_of("POST / HTTP/1.1\r\n"), Route::NotFound);
        assert_eq!(route_of("HEAD / HTTP/1.1\r\n"), Route::NotFound);
    }

    #[test]
    fn a_rubbish_request_is_a_404_rather_than_a_panic() {
        assert_eq!(route_of(""), Route::NotFound);
        assert_eq!(route_of("\r\n\r\n"), Route::NotFound);
        assert_eq!(route_of("GET\r\n\r\n"), Route::NotFound);
        assert_eq!(route_of("\u{0}\u{1}\u{2}"), Route::NotFound);
        // A request line with a very long path must not be expensive to reject.
        assert_eq!(route_of(&format!("GET /{} HTTP/1.1\r\n", "x".repeat(9000))), Route::NotFound);
    }

    #[test]
    fn the_page_carries_its_defaults_and_no_placeholder() {
        let html = page(&defaults());
        // The one thing that must never survive into a served page: an unreplaced
        // token is a page whose chat silently does not connect, with nothing on
        // screen to say why.
        assert!(!html.contains(PLACEHOLDER), "placeholder left in the page");
        assert_eq!(html.matches(PLACEHOLDER).count(), 0);
        assert!(html.contains("kit-backend.aldifhr.my.id"), "backend missing");
        assert!(html.contains("someone"), "handle missing");
    }

    #[test]
    fn a_default_with_a_quote_in_it_does_not_break_the_page() {
        // The handle comes from a text field and the backend URL from a file
        // somebody edited. Either could contain a quote, and this is written into
        // a `<script>` — an unescaped one would end the script and run whatever
        // came next as code, in the one page that is loaded by something else.
        let html = page(&OverlayDefaults {
            base_url: "https://h/v1\"></script><script>alert(1)</script>".into(),
            username: "</script>".into(),
            port: PORT,
        });
        assert!(!html.contains("<script>alert(1)</script>"), "a handle broke out of the script");
        // Serde escapes the forward slash for us; what matters is that the tag
        // cannot be reconstituted.
        assert!(!html.contains(PLACEHOLDER));
    }

    #[test]
    fn a_response_says_what_it_is_and_how_long_it_is() {
        let reply = response_for(Route::Page, &defaults());
        assert!(reply.starts_with("HTTP/1.1 200 OK\r\n"), "{}", &reply[..40.min(reply.len())]);
        assert!(reply.contains("Content-Type: text/html; charset=utf-8\r\n"));
        assert!(reply.contains("Cache-Control: no-store\r\n"), "a cached overlay is a stale one");
        assert!(reply.contains("Connection: close\r\n"));
        // A Content-Length that disagrees with the body is a request OBS hangs on
        // forever, which looks exactly like a broken overlay.
        let body = reply.split_once("\r\n\r\n").expect("a body").1;
        let length: usize = reply
            .split_once("Content-Length: ")
            .and_then(|(_, rest)| rest.split_once("\r\n"))
            .and_then(|(n, _)| n.parse().ok())
            .expect("a length");
        assert_eq!(length, body.len(), "Content-Length disagrees with the body");
    }

    #[test]
    fn a_missing_route_is_a_404_not_the_overlay() {
        let reply = response_for(Route::NotFound, &defaults());
        assert!(reply.starts_with("HTTP/1.1 404 Not Found\r\n"));
        assert!(!reply.contains(PLACEHOLDER));
    }

    #[test]
    fn health_answers_without_the_page() {
        let reply = response_for(Route::Health, &defaults());
        assert!(reply.contains("\"ok\":true"), "{}", reply);
        // The health check is what the app polls to tell "my server" from
        // "something else has this port". Shipping the page here would make that
        // question unanswerable.
        assert!(!reply.contains(PLACEHOLDER));
        assert!(!reply.contains("Content-Type: text/html"));
    }

    #[test]
    fn the_port_is_a_loopback_port() {
        // Not a style preference. A server that reached the network would be
        // serving one room's chat to anyone who asked, from a machine that is
        // streaming, with no credential in the way.
        assert!(PORT > 1024, "a privileged port needs admin to bind");
        assert_ne!(PORT, 80);
    }

    /// One real request, over a real socket, to a real listener.
    ///
    /// Every other test here calls `response_for` and reads the string. That
    /// proves the routing and the formatting; it says nothing about whether the
    /// listener opens, whether a request head is found in what arrives, or
    /// whether the response comes back in pieces the client can assemble. Those
    /// are the three things between this module and a working overlay.
    ///
    /// Bound on port zero rather than `PORT`, so the test takes an ephemeral port
    /// and never collides with the real server or with anything else on the
    /// machine.
    #[tokio::test]
    async fn it_answers_a_real_request() {
        use tokio::io::AsyncReadExt as _;

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("a port");
        let port = listener.local_addr().expect("an address").port();
        let defaults = defaults();

        tauri::async_runtime::spawn(accept_loop(listener, defaults.clone()));

        let mut response = String::new();
        for attempt in 0..40 {
            match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
                Ok(mut socket) => {
                    socket
                        .write_all(b"GET /?room=ana HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                        .await
                        .expect("a request");
                    // Bounded: a server that accepted and then said nothing would
                    // otherwise hang the suite rather than fail it.
                    let read = tokio::time::timeout(std::time::Duration::from_secs(5), socket.read_to_string(&mut response))
                        .await;
                    assert!(read.is_ok(), "the server accepted but never answered");
                    break;
                }
                // The listener may not be listening on the first try; a few
                // attempts is a wait, not a retry of anything that failed.
                Err(_) if attempt < 39 => tokio::time::sleep(std::time::Duration::from_millis(25)).await,
                Err(e) => panic!("could not connect to the server: {e}"),
            }
        }

        assert!(response.starts_with("HTTP/1.1 200 OK"), "{}", &response[..40.min(response.len())]);
        assert!(response.contains("text/html"), "{}", &response[..80.min(response.len())]);

        let body = response.split_once("\r\n\r\n").expect("a body").1;
        assert!(!body.contains(PLACEHOLDER), "the config token reached the wire");
        assert!(body.contains("kit-backend.aldifhr.my.id"), "the defaults did not reach the page");
        // The query string does not come back in the body, and must not. The page
        // reads it from `location.search` in the browser; a server that echoed it
        // into the HTML would be answering a question the page already has the
        // answer to, and the two would be able to disagree.
        assert!(!body.contains("room=ana"), "the server echoed the query string into the page");
        assert!(body.contains("URLSearchParams"), "the page does not read its own query string");
    }

    /// A health check over a socket, because that is what the app polls.
    #[tokio::test]
    async fn health_answers_over_a_socket() {
        use tokio::io::AsyncReadExt as _;

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("a port");
        let port = listener.local_addr().expect("an address").port();
        tauri::async_runtime::spawn(accept_loop(listener, defaults()));

        let mut response = String::new();
        for attempt in 0..40 {
            match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
                Ok(mut socket) => {
                    socket.write_all(b"GET /health HTTP/1.1\r\n\r\n").await.expect("a request");
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        socket.read_to_string(&mut response),
                    )
                    .await;
                    break;
                }
                Err(_) if attempt < 39 => tokio::time::sleep(std::time::Duration::from_millis(25)).await,
                Err(e) => panic!("could not connect to the server: {e}"),
            }
        }

        assert!(response.contains("200 OK"), "{}", &response[..40.min(response.len())]);
        assert!(response.contains("\"ok\":true"), "{}", response);
        // Not the page: the health check is how the app tells "my server" from
        // "something else has this port", and shipping the overlay here would make
        // that question unanswerable.
        assert!(!response.contains(PLACEHOLDER));
    }
}