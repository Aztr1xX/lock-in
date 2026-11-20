//! Study-only YouTube on the real site.
//!
//! During a round youtube.com points at the Guard like any blocked site. Instead of the "This can
//! wait" page, the Guard passes YouTube through from the real servers with the distracting parts
//! taken out:
//!   - the home feed, Shorts, trending and the suggestions beside a video are hidden;
//!   - searches that are clearly for fun get the "This can wait" page;
//!   - every video is checked before it plays (title, description, tags, category). One that
//!     doesn't teach something shows "This can wait" in the player instead of playing.
//! Search, channels, playlists and the playlist queue beside a video all work as normal.

use crate::{page, web, yt};
use serde_json::Value;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const UPSTREAM: &str = "www.youtube.com";
/// Biggest body the Guard will hold to look at (YouTube's watch pages are about 1.5 MB).
const MAX_INSPECT: usize = 12 * 1024 * 1024;

/// The names the Guard handles this way.
pub fn is_youtube(host: &str) -> bool {
    matches!(host, "youtube.com" | "www.youtube.com" | "m.youtube.com" | "youtu.be" | "www.youtu.be")
}

/// Hides the feed, Shorts and suggestions. Plain CSS, so YouTube's script rules don't get in the way.
const STYLE: &str = r#"<style id="lockin-study">
ytd-browse[page-subtype="home"] ytd-rich-grid-renderer,
ytd-browse[page-subtype="home"] ytd-feed-filter-chip-bar-renderer,
ytd-browse[page-subtype="subscriptions"] ytd-rich-grid-renderer,
ytd-browse[page-subtype="trending"] #contents,
ytd-watch-flexy #related,
ytd-watch-next-secondary-results-renderer,
ytd-reel-shelf-renderer,
ytd-rich-shelf-renderer[is-shorts],
grid-shelf-view-model,
ytm-shorts-lockup-view-model,
ytd-guide-entry-renderer:has(a[title="Shorts"]),
ytd-mini-guide-entry-renderer[aria-label="Shorts"],
ytd-guide-entry-renderer:has(a[href="/feed/trending"]),
ytd-search ytd-shelf-renderer,
ytd-search ytd-horizontal-card-list-renderer,
.ytp-endscreen-content,
.ytp-ce-element,
.ytp-suggestion-set,
.ytp-pause-overlay,
.ytp-autonav-endscreen-upnext-container,
.videowall-endscreen{display:none!important}
ytd-browse[page-subtype="home"] #primary::before{content:"Search for what you're studying.";display:block;text-align:center;padding:28vh 16px 0;font:400 22px/1.4 Roboto,Arial,sans-serif;color:var(--yt-spec-text-secondary,#606060)}
</style>"#;

/// Makes every video open as a full page load, so the Guard checks it before it plays. YouTube
/// normally swaps videos in place, which would skip the check until a refresh.
const SCRIPT: &str = r#"(function(){
document.documentElement.setAttribute('data-lockin','1');
var here=new URLSearchParams(location.search).get('v');
function vid(u){try{var x=new URL(u,location.href);if(x.origin!==location.origin)return null;if(x.pathname==='/watch')return x.searchParams.get('v');var m=x.pathname.match(/^\/shorts\/([\w-]{11})/);return m?m[1]:null}catch(e){return null}}
function load(u){location.assign(new URL(u,location.href).href)}
document.addEventListener('click',function(e){if(e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;var v=vid(a.href);if(v&&v!==here){e.preventDefault();e.stopImmediatePropagation();load(a.href)}},true);
['pushState','replaceState'].forEach(function(n){var f=history[n];history[n]=function(s,t,u){var v=u?vid(u):null;if(v&&v!==here){load(u);return}return f.apply(this,arguments)}});
document.addEventListener('yt-navigate-start',function(e){var u=e.detail&&e.detail.url;var v=u?vid(u):null;if(v&&v!==here)load(u)},true);
})();"#;

/// Replaces YouTube's service worker for the round, so pages can't come from its cache unfiltered.
const NO_WORKER: &str = "self.addEventListener('install',function(){self.skipWaiting()});self.addEventListener('activate',function(){self.registration.unregister()});";

const VIDEO_REASON: &str = "This can wait. Lock In only plays videos that teach something.";

#[derive(Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// What to do with one request.
#[derive(Debug, PartialEq)]
pub enum Route {
    /// Answer without asking YouTube.
    Reply(Vec<u8>),
    /// Ask YouTube, then look at the answer this way.
    Forward(Look),
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Look {
    Nothing,
    Page,
    WatchPage,
    Player,
}

fn query_param(path: &str, key: &str) -> Option<String> {
    let q = path.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == key).then(|| url_decode(v))
    })
}

fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 2;
                } else {
                    out.push(b'%');
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn redirect(to: &str) -> Vec<u8> {
    format!("HTTP/1.1 302 Found\r\nLocation: {to}\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n").into_bytes()
}

fn json_reply(body: &str) -> Vec<u8> {
    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes()
}

fn search_page(seconds_left: u64) -> Vec<u8> {
    page::wrap(&page::card(
        "That search can wait.",
        r#"<p>It looks like it's for fun, not for studying.</p><p><a href="/">Search for what you're working on</a></p>"#,
        seconds_left,
    ))
}

fn video_page(title: &str, seconds_left: u64) -> Vec<u8> {
    page::wrap(&page::card(
        "This video can wait.",
        &format!(
            r#"<p><span class="site">{}</span> doesn't look like it teaches something.</p><p>Lessons, lectures and explainers play as normal. <a href="/">Back to search</a></p>"#,
            page::escape(title)
        ),
        seconds_left,
    ))
}

fn feed_page(seconds_left: u64) -> Vec<u8> {
    page::wrap(&page::card(
        "This can wait.",
        r#"<p>Feeds are off until your round ends. Search still works.</p><p><a href="/">Search for what you're studying</a></p>"#,
        seconds_left,
    ))
}

/// Decides what happens to a request, before YouTube is asked.
pub fn route(host: &str, req: &Request, seconds_left: u64) -> Route {
    let path = req.path.as_str();
    let route_path = path.split('?').next().unwrap_or("");
    // Everything lives on www.youtube.com.
    if host == "youtu.be" || host == "www.youtu.be" {
        let id = route_path.trim_start_matches('/');
        return Route::Reply(redirect(&format!("https://www.youtube.com/watch?v={id}")));
    }
    if host != UPSTREAM {
        return Route::Reply(redirect(&format!("https://www.youtube.com{path}")));
    }
    if let Some(id) = route_path.strip_prefix("/shorts/") {
        return Route::Reply(redirect(&format!("/watch?v={}", id.trim_end_matches('/'))));
    }
    if route_path == "/sw.js" {
        return Route::Reply(
            format!("HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nCache-Control: no-store\r\nContent-Length: {}\r\n\r\n{NO_WORKER}", NO_WORKER.len()).into_bytes(),
        );
    }
    if matches!(route_path, "/feed/trending" | "/feed/explore" | "/gaming" | "/feed/shorts") {
        return Route::Reply(feed_page(seconds_left));
    }
    if route_path == "/results" {
        let q = query_param(path, "search_query").or_else(|| query_param(path, "q")).unwrap_or_default();
        if yt::judge_query(&q) == "fun" {
            return Route::Reply(search_page(seconds_left));
        }
    }
    if req.method == "POST" && route_path.starts_with("/youtubei/v1/") {
        let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
        match route_path {
            "/youtubei/v1/player" => return Route::Forward(Look::Player),
            "/youtubei/v1/search" => {
                let q = body.get("query").and_then(Value::as_str).unwrap_or("");
                if yt::judge_query(q) == "fun" {
                    return Route::Reply(json_reply(r#"{"responseContext":{}}"#));
                }
            }
            "/youtubei/v1/browse" => {
                let id = body.get("browseId").and_then(Value::as_str).unwrap_or("");
                if matches!(id, "FEwhat_to_watch" | "FEshorts" | "FEtrending" | "FEexplore") {
                    return Route::Reply(json_reply(r#"{"responseContext":{}}"#));
                }
            }
            _ => {}
        }
        return Route::Forward(Look::Nothing);
    }
    if req.method == "GET" && route_path == "/watch" {
        return Route::Forward(Look::WatchPage);
    }
    let dest = req.header("sec-fetch-dest").unwrap_or("");
    let wants_html = req.header("accept").is_some_and(|a| a.contains("text/html"));
    if req.method == "GET" && (dest == "document" || dest == "iframe" || (dest.is_empty() && wants_html)) {
        return Route::Forward(Look::Page);
    }
    Route::Forward(Look::Nothing)
}

fn meta(html: &str, name: &str) -> String {
    let key = format!("<meta name=\"{name}\" content=\"");
    html.find(&key)
        .map(|i| {
            let rest = &html[i + key.len()..];
            rest[..rest.find('"').unwrap_or(0)].to_string()
        })
        .unwrap_or_default()
}

/// Title and whether to play, from a watch page.
pub fn judge_watch_page(html: &str) -> Option<(String, bool)> {
    let title = meta(html, "title");
    if title.is_empty() {
        return None;
    }
    let mut description = meta(html, "description");
    // The player data carries the full description; the meta tag only has the start.
    if let Some(i) = html.find("\"shortDescription\":\"") {
        let rest = &html[i + 20..];
        let end = rest.find("\",\"").unwrap_or(rest.len().min(5000));
        description.push(' ');
        description.push_str(&rest[..end].replace("\\n", " "));
    }
    let ok = yt::is_study(&title, &description, &meta(html, "keywords"), &yt::parse_category(html));
    Some((title, ok))
}

/// Takes playback out of a player answer for a video that doesn't teach something.
/// Returns the new body, or None when the video may play (or the answer can't be read).
pub fn judge_player(body: &[u8]) -> Option<Vec<u8>> {
    let mut v: Value = serde_json::from_slice(body).ok()?;
    let d = v.get("videoDetails")?;
    let title = d.get("title").and_then(Value::as_str).unwrap_or("");
    let desc = d.get("shortDescription").and_then(Value::as_str).unwrap_or("");
    let keywords = d
        .get("keywords")
        .and_then(Value::as_array)
        .map(|k| k.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    let category = v.pointer("/microformat/playerMicroformatRenderer/category").and_then(Value::as_str).unwrap_or("");
    if yt::is_study(title, desc, &keywords, category) {
        return None;
    }
    let o = v.as_object_mut()?;
    o.remove("streamingData");
    o.remove("playerAds");
    o.remove("adPlacements");
    o.insert(
        "playabilityStatus".into(),
        serde_json::json!({ "status": "ERROR", "reason": VIDEO_REASON, "errorScreen": { "playerErrorMessageRenderer": { "reason": { "simpleText": VIDEO_REASON } } } }),
    );
    serde_json::to_vec(&v).ok()
}

/// Puts the hiding styles and the full-page-load script into a YouTube page. The script reuses
/// the page's own script nonce, which YouTube's security rules require.
pub fn add_style(html: &str) -> String {
    let nonce = html
        .find("<script nonce=\"")
        .map(|i| {
            let rest = &html[i + 15..];
            rest[..rest.find('"').unwrap_or(0)].to_string()
        })
        .filter(|n| n.chars().all(|c| c.is_ascii_alphanumeric() || "+/=_-".contains(c)))
        .unwrap_or_default();
    let attr = if nonce.is_empty() { String::new() } else { format!(" nonce=\"{nonce}\"") };
    let add = format!("{STYLE}<script id=\"lockin-study-js\"{attr}>{SCRIPT}</script>");
    match html.find("</head>") {
        Some(i) => format!("{}{add}{}", &html[..i], &html[i..]),
        None => format!("{add}{html}"),
    }
}

/// Undoes gzip, deflate or brotli, in case YouTube compresses even when asked not to.
fn decode(body: Vec<u8>, encoding: &str) -> io::Result<Vec<u8>> {
    let mut out = vec![];
    match encoding.trim().to_ascii_lowercase().as_str() {
        "" | "identity" => return Ok(body),
        "gzip" | "x-gzip" => {
            flate2::read::GzDecoder::new(&body[..]).take(MAX_INSPECT as u64 * 4).read_to_end(&mut out)?;
        }
        "deflate" => {
            flate2::read::ZlibDecoder::new(&body[..]).take(MAX_INSPECT as u64 * 4).read_to_end(&mut out)?;
        }
        "br" => {
            brotli_decompressor::Decompressor::new(&body[..], 64 * 1024).take(MAX_INSPECT as u64 * 4).read_to_end(&mut out)?;
        }
        _ => return Err(io::Error::other("unknown encoding")),
    }
    Ok(out)
}

// ---------- HTTP/1.1 plumbing ----------

fn read_head<R: BufRead>(r: &mut R) -> io::Result<Option<Vec<String>>> {
    let mut lines = vec![];
    let mut total = 0;
    loop {
        let mut line = String::new();
        let n = r.read_line(&mut line)?;
        if n == 0 {
            return if lines.is_empty() { Ok(None) } else { Err(io::ErrorKind::UnexpectedEof.into()) };
        }
        total += n;
        if total > 64 * 1024 || lines.len() > 200 {
            return Err(io::Error::other("head too big"));
        }
        let line = line.trim_end_matches(['\r', '\n']).to_string();
        if line.is_empty() {
            if lines.is_empty() {
                continue; // stray blank line between requests
            }
            return Ok(Some(lines));
        }
        lines.push(line);
    }
}

fn parse_headers(lines: &[String]) -> Vec<(String, String)> {
    lines
        .iter()
        .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
        .collect()
}

fn get<'a>(h: &'a [(String, String)], name: &str) -> Option<&'a str> {
    h.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

fn is_chunked(h: &[(String, String)]) -> bool {
    get(h, "transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"))
}

fn content_length(h: &[(String, String)]) -> Option<usize> {
    get(h, "content-length").and_then(|v| v.parse().ok())
}

/// Reads a chunked body, either decoding it into `out` or copying it unchanged to `copy`.
fn chunked<R: BufRead>(r: &mut R, mut out: Option<&mut Vec<u8>>, mut copy: Option<&mut dyn Write>, limit: usize) -> io::Result<()> {
    let mut total = 0usize;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line)? == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        if let Some(w) = copy.as_deref_mut() {
            w.write_all(line.as_bytes())?;
        }
        let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or("").trim(), 16).map_err(|_| io::Error::other("bad chunk"))?;
        if size == 0 {
            // Trailers, then the blank line that ends the body.
            loop {
                let mut t = String::new();
                if r.read_line(&mut t)? == 0 {
                    return Ok(());
                }
                if let Some(w) = copy.as_deref_mut() {
                    w.write_all(t.as_bytes())?;
                }
                if t.trim().is_empty() {
                    return Ok(());
                }
            }
        }
        total += size;
        if total > limit {
            return Err(io::Error::other("body too big"));
        }
        let mut buf = vec![0u8; size + 2];
        r.read_exact(&mut buf)?;
        if let Some(w) = copy.as_deref_mut() {
            w.write_all(&buf)?;
        }
        if let Some(o) = out.as_deref_mut() {
            o.extend_from_slice(&buf[..size]);
        }
    }
}

fn read_request<R: BufRead>(r: &mut R) -> io::Result<Option<Request>> {
    let Some(lines) = read_head(r)? else { return Ok(None) };
    let mut parts = lines[0].split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();
    let headers = parse_headers(&lines[1..]);
    let mut body = vec![];
    if is_chunked(&headers) {
        chunked(r, Some(&mut body), None, MAX_INSPECT)?;
    } else if let Some(n) = content_length(&headers) {
        if n > MAX_INSPECT {
            return Err(io::Error::other("request too big"));
        }
        body.resize(n, 0);
        r.read_exact(&mut body)?;
    }
    Ok(Some(Request { method, path, headers, body }))
}

const HOP: &[&str] = &["connection", "keep-alive", "proxy-connection", "te", "upgrade", "transfer-encoding", "content-length", "host"];

fn write_request<W: Write>(w: &mut W, req: &Request, look: Look) -> io::Result<()> {
    let mut out = format!("{} {} HTTP/1.1\r\nHost: {UPSTREAM}\r\n", req.method, req.path);
    for (k, v) in &req.headers {
        let lk = k.to_ascii_lowercase();
        if HOP.contains(&lk.as_str()) || (look != Look::Nothing && lk == "accept-encoding") {
            continue;
        }
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    if look != Look::Nothing {
        out.push_str("Accept-Encoding: identity\r\n");
    }
    if !req.body.is_empty() || matches!(req.method.as_str(), "POST" | "PUT" | "PATCH") {
        out.push_str(&format!("Content-Length: {}\r\n", req.body.len()));
    }
    out.push_str("Connection: keep-alive\r\n\r\n");
    w.write_all(out.as_bytes())?;
    w.write_all(&req.body)?;
    w.flush()
}

type Up = BufReader<web::Tls>;

/// Whether the connection to YouTube can be used again after this answer.
enum After {
    KeepUp,
    CloseUp,
    CloseBoth,
}

/// Asks YouTube and passes the answer on, looked at if needed.
fn exchange<C: Write>(client: &mut C, up: &mut Up, req: &Request, look: Look, seconds_left: u64) -> io::Result<After> {
    write_request(up.get_mut(), req, look)?;
    let lines = loop {
        let lines = read_head(up)?.ok_or(io::ErrorKind::UnexpectedEof)?;
        // Skip "100 Continue" and other in-between answers.
        if lines[0].split_whitespace().nth(1).is_some_and(|c| c.starts_with('1') && c != "101") {
            continue;
        }
        break lines;
    };
    let status: u16 = lines[0].split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(502);
    let headers = parse_headers(&lines[1..]);
    let up_closes = get(&headers, "connection").is_some_and(|v| v.eq_ignore_ascii_case("close"));
    let no_body = req.method == "HEAD" || status == 204 || status == 304 || (100..200).contains(&status);
    let framed = is_chunked(&headers) || content_length(&headers).is_some();
    let encoding = get(&headers, "content-encoding").unwrap_or("").to_string();
    let known = matches!(encoding.trim().to_ascii_lowercase().as_str(), "" | "identity" | "gzip" | "x-gzip" | "deflate" | "br");
    let ctype = get(&headers, "content-type").unwrap_or("").to_ascii_lowercase();
    let inspect = look != Look::Nothing && status == 200 && !no_body && known && (ctype.contains("html") || ctype.contains("json"));
    if look == Look::Player && !inspect {
        crate::log(&format!("study youtube: player answer not checked (status {status}, type {ctype}, encoding {encoding})"));
    }

    if inspect {
        let mut body = vec![];
        if is_chunked(&headers) {
            chunked(up, Some(&mut body), None, MAX_INSPECT)?;
        } else if let Some(n) = content_length(&headers) {
            if n > MAX_INSPECT {
                return Err(io::Error::other("answer too big"));
            }
            body.resize(n, 0);
            up.read_exact(&mut body)?;
        } else {
            up.take(MAX_INSPECT as u64).read_to_end(&mut body)?;
        }
        let body = decode(body, &encoding)?;
        let new_body: Vec<u8> = match look {
            Look::Player => match judge_player(&body) {
                Some(held) => {
                    crate::log("study youtube: held back a video in the player");
                    held
                }
                None => body,
            },
            Look::WatchPage => {
                let html = String::from_utf8_lossy(&body);
                match judge_watch_page(&html) {
                    Some((title, false)) => {
                        crate::log(&format!("study youtube: held back a video ({} chars of title)", title.len()));
                        client.write_all(&video_page(&title, seconds_left))?;
                        client.flush()?;
                        return Ok(if up_closes || !framed { After::CloseUp } else { After::KeepUp });
                    }
                    _ => add_style(&html).into_bytes(),
                }
            }
            Look::Page => add_style(&String::from_utf8_lossy(&body)).into_bytes(),
            Look::Nothing => body,
        };
        let mut head = format!("{}\r\n", lines[0].replacen("HTTP/1.0", "HTTP/1.1", 1));
        for (k, v) in &headers {
            let lk = k.to_ascii_lowercase();
            if matches!(lk.as_str(), "content-length" | "transfer-encoding" | "content-encoding" | "connection" | "keep-alive" | "alt-svc") {
                continue;
            }
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str(&format!("Content-Length: {}\r\n\r\n", new_body.len()));
        client.write_all(head.as_bytes())?;
        client.write_all(&new_body)?;
        client.flush()?;
        return Ok(if up_closes || (!framed && !no_body) { After::CloseUp } else { After::KeepUp });
    }

    // Passed on unchanged, as it arrives.
    let mut head = format!("{}\r\n", lines[0]);
    for (k, v) in &headers {
        let lk = k.to_ascii_lowercase();
        if matches!(lk.as_str(), "connection" | "keep-alive" | "alt-svc") {
            continue;
        }
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if no_body || framed {
        head.push_str("\r\n");
        client.write_all(head.as_bytes())?;
        if !no_body {
            if is_chunked(&headers) {
                chunked(up, None, Some(client as &mut dyn Write), usize::MAX)?;
            } else if let Some(n) = content_length(&headers) {
                io::copy(&mut up.take(n as u64), client)?;
            }
        }
        client.flush()?;
        Ok(if up_closes { After::CloseUp } else { After::KeepUp })
    } else {
        // No length given: the body runs until YouTube closes, so the browser's connection ends too.
        head.push_str("Connection: close\r\n\r\n");
        client.write_all(head.as_bytes())?;
        io::copy(up, client)?;
        client.flush()?;
        Ok(After::CloseBoth)
    }
}

fn open_up() -> io::Result<Up> {
    web::open(UPSTREAM).map(BufReader::new).map_err(io::Error::other)
}

/// Serves one browser connection for as long as the browser keeps it open.
pub fn serve(stream: TcpStream, host: &str, seconds_left: impl Fn() -> u64) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(120)));
    let Some(tls) = page::accept(stream) else { return };
    let mut client = BufReader::new(tls);
    let mut up: Option<Up> = None;
    loop {
        let req = match read_request(&mut client) {
            Ok(Some(r)) => r,
            _ => return,
        };
        let left = seconds_left();
        let look = match route(host, &req, left) {
            Route::Reply(bytes) => {
                if client.get_mut().write_all(&bytes).and_then(|_| client.get_mut().flush()).is_err() {
                    return;
                }
                continue;
            }
            Route::Forward(look) => look,
        };
        // A kept connection may have been closed by YouTube in the meantime: try once more on a fresh one.
        let mut tries = 0;
        let after = loop {
            tries += 1;
            if up.is_none() {
                match open_up() {
                    Ok(u) => up = Some(u),
                    Err(e) => {
                        crate::log(&format!("study youtube: couldn't reach YouTube: {e}"));
                        let msg = "Lock In couldn't reach YouTube just now. Refresh to try again.";
                        let _ = client.get_mut().write_all(
                            format!("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{msg}", msg.len()).as_bytes(),
                        );
                        return;
                    }
                }
            }
            let u = up.as_mut().expect("just opened");
            match exchange(client.get_mut(), u, &req, look, left) {
                Ok(a) => break Some(a),
                Err(_) if tries < 2 => up = None,
                Err(_) => break None,
            }
        };
        match after {
            Some(After::KeepUp) => {}
            Some(After::CloseUp) => up = None,
            Some(After::CloseBoth) | None => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Request {
        Request {
            method: method.into(),
            path: path.into(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn routes() {
        let r = |host: &str, q: Request| route(host, &q, 600);
        assert!(matches!(r("youtu.be", req("GET", "/abcdefghijk", &[], "")), Route::Reply(b) if String::from_utf8_lossy(&b).contains("Location: https://www.youtube.com/watch?v=abcdefghijk")));
        assert!(matches!(r("m.youtube.com", req("GET", "/watch?v=x", &[], "")), Route::Reply(b) if String::from_utf8_lossy(&b).contains("Location: https://www.youtube.com/watch?v=x")));
        assert!(matches!(r(UPSTREAM, req("GET", "/shorts/abcdefghijk", &[], "")), Route::Reply(b) if String::from_utf8_lossy(&b).contains("Location: /watch?v=abcdefghijk")));
        assert!(matches!(r(UPSTREAM, req("GET", "/results?search_query=minecraft+hardcore", &[], "")), Route::Reply(b) if String::from_utf8_lossy(&b).contains("That search can wait.")));
        assert_eq!(r(UPSTREAM, req("GET", "/results?search_query=integration+by+parts", &[("Sec-Fetch-Dest", "document")], "")), Route::Forward(Look::Page));
        assert_eq!(r(UPSTREAM, req("GET", "/watch?v=abc", &[], "")), Route::Forward(Look::WatchPage));
        assert_eq!(r(UPSTREAM, req("POST", "/youtubei/v1/player?prettyPrint=false", &[], "{}")), Route::Forward(Look::Player));
        assert!(matches!(r(UPSTREAM, req("POST", "/youtubei/v1/browse", &[], r#"{"browseId":"FEwhat_to_watch"}"#)), Route::Reply(_)));
        assert_eq!(r(UPSTREAM, req("POST", "/youtubei/v1/browse", &[], r#"{"browseId":"UC123"}"#)), Route::Forward(Look::Nothing));
        assert!(matches!(r(UPSTREAM, req("POST", "/youtubei/v1/search", &[], r#"{"query":"fortnite"}"#)), Route::Reply(_)));
        assert_eq!(r(UPSTREAM, req("GET", "/s/player/base.js", &[("Sec-Fetch-Dest", "script")], "")), Route::Forward(Look::Nothing));
        assert_eq!(r(UPSTREAM, req("GET", "/@khanacademy/videos", &[("Sec-Fetch-Dest", "document")], "")), Route::Forward(Look::Page));
    }

    #[test]
    fn judges_watch_pages_and_player_answers() {
        let fun = r#"<html><head><meta name="title" content="Rick Astley - Never Gonna Give You Up (Official Video)"><meta name="description" content="The official video"></head>"#;
        assert_eq!(judge_watch_page(fun), Some(("Rick Astley - Never Gonna Give You Up (Official Video)".into(), false)));
        let study = r#"<meta name="title" content="Integration by parts"><meta name="description" content="A worked example"><script>{"shortDescription":"We explain the method step by step.","category":"Education"}</script>"#;
        assert_eq!(judge_watch_page(study).map(|x| x.1), Some(true));
        let player_fun = br#"{"playabilityStatus":{"status":"OK"},"streamingData":{"x":1},"videoDetails":{"title":"Fortnite funny moments","shortDescription":"lol"}}"#;
        let out = String::from_utf8(judge_player(player_fun).unwrap()).unwrap();
        assert!(out.contains("This can wait") && !out.contains("streamingData"));
        let player_ok = br#"{"videoDetails":{"title":"Limits explained"},"microformat":{"playerMicroformatRenderer":{"category":"Education"}}}"#;
        assert!(judge_player(player_ok).is_none());
        assert!(add_style("<html><head></head>").contains("lockin-study"));
        let page = add_style(r#"<html><head><script nonce="abc123">x</script></head>"#);
        assert!(page.contains(r#"<script id="lockin-study-js" nonce="abc123">"#));
        let mut gz = flate2::write::GzEncoder::new(vec![], flate2::Compression::default());
        std::io::Write::write_all(&mut gz, b"hello").unwrap();
        assert_eq!(decode(gz.finish().unwrap(), "gzip").unwrap(), b"hello");
    }

    #[test]
    fn copies_chunked_bodies() {
        let mut r = BufReader::new(&b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\nNEXT"[..]);
        let mut out = vec![];
        chunked(&mut r, Some(&mut out), None, 100).unwrap();
        assert_eq!(out, b"Wikipedia");
        let mut rest = String::new();
        r.read_to_string(&mut rest).unwrap();
        assert_eq!(rest, "NEXT");
        assert_eq!(url_decode("a+b%2Bc%"), "a b+c%");
        assert_eq!(query_param("/results?x=1&search_query=hi+there", "search_query").as_deref(), Some("hi there"));
    }
}
