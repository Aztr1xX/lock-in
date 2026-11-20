//! Study YouTube: search YouTube and judge which results are for studying.
//!
//! The app shows results and plays the allowed ones in its own player, with no feed, comments or
//! recommendations. A search that's clearly for fun is refused. Each video is judged by the
//! category its uploader filed it under (Education, Science & Technology), unless the person has
//! chosen to allow its channel.

use serde::Serialize;
use serde_json::Value;

const ALLOWED: &[&str] = &["Education", "Science & Technology"];
/// How many results get their category checked (each needs one page load).
const CHECK: usize = 10;

const STUDY: &[&str] = &[
    "lecture", "lectures", "lesson", "lessons", "tutorial", "tutorials", "explained", "explanation", "how to",
    "revision", "revise", "exam", "exams", "gcse", "a level", "a levels", "alevel", "ib", "sat", "hsc", "vce",
    "atar", "matric", "nsc", "ieb", "past paper", "past papers", "worked example", "worked examples",
    "practice questions", "course", "crash course", "khan", "physics", "chemistry", "biology", "math", "maths",
    "mathematics", "calculus", "algebra", "geometry", "trig", "trigonometry", "statistics", "equation",
    "equations", "derivative", "derivatives", "integral", "integrals", "integration", "differentiation",
    "history", "geography", "economics", "accounting", "psychology", "english", "essay", "essays", "grammar",
    "literature", "shakespeare", "poetry", "afrikaans", "spanish", "french", "german", "japanese", "chinese",
    "programming", "coding", "python", "javascript", "java", "computer science", "study", "notes", "summary",
    "science", "cell", "cells", "atom", "atoms", "molecule", "molecules", "organic", "vector", "vectors",
    "matrix", "matrices", "probability", "thermodynamics", "quantum", "electricity", "circuit", "circuits",
    "genetics", "dna", "evolution", "photosynthesis", "mitosis", "meiosis", "enzyme", "enzymes", "anatomy",
    "physiology", "study with me", "pomodoro", "proof", "theorem", "formula", "definition",
];
const FUN: &[&str] = &[
    "minecraft", "valorant", "fortnite", "roblox", "gta", "call of duty", "cod", "warzone", "csgo", "cs2",
    "counter strike", "league of legends", "apex", "overwatch", "rocket league", "fifa", "ea fc",
    "clash royale", "clash of clans", "brawl stars", "among us", "gameplay", "lets play", "let's play",
    "speedrun", "stream", "twitch", "funny", "prank", "meme", "memes", "compilation", "fails", "react",
    "reacts", "reaction", "vlog", "vlogs", "mrbeast", "tiktok", "shorts", "asmr", "music video",
    "official video", "lyrics", "song", "songs", "playlist", "album", "movie", "movies", "trailer", "episode",
    "anime", "highlights", "nba", "nfl", "ufc", "wwe", "f1", "unboxing", "try not to laugh", "drama", "edit",
    "edits", "brawlhalla",
];

fn has_any(q: &str, words: &[&str]) -> bool {
    let padded = format!(
        " {} ",
        q.to_lowercase().chars().map(|c| if c.is_alphanumeric() || c == '\'' { c } else { ' ' }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
    );
    words.iter().any(|w| padded.contains(&format!(" {w} ")))
}

/// "study", "fun", or "unsure" from the words of the search alone.
pub fn judge_query(q: &str) -> &'static str {
    if has_any(q, STUDY) {
        "study"
    } else if has_any(q, FUN) {
        "fun"
    } else {
        "unsure"
    }
}

#[derive(Serialize, Clone, Default)]
pub struct Video {
    pub id: String,
    pub title: String,
    pub channel: String,
    #[serde(rename = "channelId")]
    pub channel_id: String,
    pub length: String,
    /// The bit of description YouTube shows under the title in search results.
    #[serde(skip)]
    pub snippet: String,
    pub category: String,
    /// What the verdict rests on: "category", "channel" or "title".
    pub basis: String,
    pub allowed: bool,
    /// Why the category couldn't be read, if it couldn't.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub problem: String,
}

fn text(v: &Value) -> String {
    if let Some(s) = v.get("simpleText").and_then(Value::as_str) {
        return s.to_string();
    }
    v.get("runs")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(|x| x.get("text").and_then(Value::as_str)).collect::<String>())
        .unwrap_or_default()
}

fn collect(v: &Value, out: &mut Vec<Video>) {
    match v {
        Value::Object(m) => {
            if let Some(r) = m.get("videoRenderer") {
                let id = r.get("videoId").and_then(Value::as_str).unwrap_or("");
                if id.len() == 11 && !out.iter().any(|x| x.id == id) {
                    let owner = r.get("ownerText").unwrap_or(&Value::Null);
                    out.push(Video {
                        id: id.to_string(),
                        title: text(r.get("title").unwrap_or(&Value::Null)),
                        channel: text(owner),
                        channel_id: owner
                            .pointer("/runs/0/navigationEndpoint/browseEndpoint/browseId")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        length: text(r.get("lengthText").unwrap_or(&Value::Null)),
                        snippet: r
                            .pointer("/detailedMetadataSnippets/0/snippetText")
                            .or_else(|| r.pointer("/descriptionSnippet"))
                            .map(text)
                            .unwrap_or_default(),
                        ..Default::default()
                    });
                }
                return;
            }
            for x in m.values() {
                collect(x, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect(x, out)),
        _ => {}
    }
}

/// Pulls the results out of a YouTube search page.
pub fn parse_results(html: &str) -> Vec<Video> {
    let Some(start) = html.find("var ytInitialData = ").map(|i| i + "var ytInitialData = ".len()) else { return vec![] };
    let rest = &html[start..];
    let end = rest.find(";</script>").unwrap_or(rest.len());
    let Ok(data) = serde_json::from_str::<Value>(&rest[..end]) else { return vec![] };
    let mut out = vec![];
    collect(&data, &mut out);
    out.retain(|v| !v.length.is_empty()); // live streams and upcoming premieres have no length
    out
}

/// YouTube's own category names; the watch page has other "category" keys that aren't these.
const CATEGORIES: &[&str] = &[
    "Film & Animation", "Autos & Vehicles", "Music", "Pets & Animals", "Sports", "Travel & Events", "Gaming",
    "People & Blogs", "Comedy", "Entertainment", "News & Politics", "Howto & Style", "Education",
    "Science & Technology", "Nonprofits & Activism",
];

pub fn parse_category(html: &str) -> String {
    // The player data has "category":"Education"; the page head has
    // <meta itemprop="genre" content="Education">. Either is fine.
    for key in ["\"category\":\"", "itemprop=\"genre\" content=\"", "\"genre\":\""] {
        let mut from = 0;
        while let Some(i) = html[from..].find(key) {
            let start = from + i + key.len();
            let rest = &html[start..];
            let value = rest[..rest.find('"').unwrap_or(0)].replace("\\u0026", "&").replace("&amp;", "&");
            if CATEGORIES.contains(&value.as_str()) {
                return value;
            }
            from = start;
        }
    }
    String::new()
}

/// The category from the watch page, or failing that from YouTube's player API.
fn category_of(id: &str) -> (String, String) {
    let mut problems = vec![];
    match crate::web::get("www.youtube.com", &format!("/watch?v={id}")) {
        Ok(h) => {
            let c = parse_category(&h);
            if !c.is_empty() {
                return (c, String::new());
            }
            problems.push(format!("watch page has no category ({} bytes)", h.len()));
        }
        Err(e) => problems.push(format!("watch page: {e}")),
    }
    let body = format!(
        r#"{{"videoId":"{id}","context":{{"client":{{"clientName":"WEB","clientVersion":"2.20251119.01.00","hl":"en","gl":"US"}}}}}}"#
    );
    match crate::web::post_json("www.youtube.com", "/youtubei/v1/player?prettyPrint=false", &body) {
        Ok(j) => {
            let c = parse_category(&j);
            if !c.is_empty() {
                return (c, String::new());
            }
            let status = serde_json::from_str::<Value>(&j)
                .ok()
                .and_then(|v| v.pointer("/playabilityStatus/status").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_default();
            problems.push(format!("player API has no category ({} bytes, {status})", j.len()));
        }
        Err(e) => problems.push(format!("player API: {e}")),
    }
    (String::new(), problems.join("; "))
}

/// Decides whether a video plays. The uploader's category decides when it's known. When it
/// isn't, the title and description have to read as study and not as entertainment.
pub fn judge_video(v: &mut Video, allow_channels: &[String]) {
    if !v.channel_id.is_empty() && allow_channels.contains(&v.channel_id) {
        v.allowed = true;
        v.basis = "channel".into();
    } else if !v.category.is_empty() {
        v.allowed = ALLOWED.contains(&v.category.as_str());
        v.basis = "category".into();
    } else {
        let words = format!("{} {}", v.title, v.snippet);
        v.allowed = has_any(&words, STUDY) && !has_any(&v.title, FUN);
        v.basis = "title".into();
    }
}

fn encode(q: &str) -> String {
    q.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".into(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Runs a search. Returns the verdict on the search and the judged results.
pub fn search(q: &str, allow_channels: &[String]) -> Result<(String, Vec<Video>), String> {
    let q = q.trim();
    if q.is_empty() {
        return Ok(("unsure".into(), vec![]));
    }
    let verdict = judge_query(q);
    if verdict == "fun" {
        return Ok(("fun".into(), vec![]));
    }
    // sp=EgIQAQ%3D%3D limits results to videos (no channels, playlists or Shorts shelves).
    let html = crate::web::get("www.youtube.com", &format!("/results?search_query={}&sp=EgIQAQ%3D%3D", encode(q)))?;
    let mut videos = parse_results(&html);
    videos.truncate(CHECK);
    let handles: Vec<_> = videos.iter().map(|v| {
        let id = v.id.clone();
        std::thread::spawn(move || category_of(&id))
    }).collect();
    for (v, h) in videos.iter_mut().zip(handles) {
        (v.category, v.problem) = h.join().unwrap_or_default();
        judge_video(v, allow_channels);
    }
    Ok((verdict.into(), videos))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn judges_searches() {
        assert_eq!(judge_query("organic chemistry alkenes"), "study");
        assert_eq!(judge_query("Minecraft hardcore"), "fun");
        assert_eq!(judge_query("taylor swift"), "unsure");
        assert_eq!(judge_query("calculus funny"), "study"); // study words win
        assert_eq!(judge_query("codex"), "unsure"); // whole words only
    }

    #[test]
    fn reads_results_and_category() {
        let html = r#"<script>var ytInitialData = {"contents":{"x":[{"videoRenderer":{"videoId":"abcdefghijk","title":{"runs":[{"text":"Limits explained"}]},"ownerText":{"runs":[{"text":"Prof","navigationEndpoint":{"browseEndpoint":{"browseId":"UC123"}}}]},"lengthText":{"simpleText":"12:01"}}},{"videoRenderer":{"videoId":"livelivelive","title":{"runs":[{"text":"Live"}]}}}]}};</script>"#;
        let v = parse_results(html);
        assert_eq!(v.len(), 1);
        assert_eq!((v[0].id.as_str(), v[0].title.as_str(), v[0].channel_id.as_str(), v[0].length.as_str()), ("abcdefghijk", "Limits explained", "UC123", "12:01"));
        assert_eq!(parse_category(r#"..."category":"Science & Technology",..."#), "Science & Technology");
        assert_eq!(parse_category(r#"<meta itemprop="genre" content="Science &amp; Technology">"#), "Science & Technology");
        assert_eq!(parse_category(r#""category":"VIDEO","category":"Education""#), "Education");
        assert_eq!(encode("a+b c"), "a%2Bb+c");
    }

    #[test]
    fn judges_videos_without_a_category() {
        let mut v = Video { title: "Alkene Addition Reactions: Crash Course Organic Chemistry #16".into(), channel_id: "UCx".into(), ..Default::default() };
        judge_video(&mut v, &[]);
        assert!(v.allowed);
        let mut v = Video { title: "Minecraft but chemistry is real".into(), ..Default::default() };
        judge_video(&mut v, &[]);
        assert!(!v.allowed); // fun word in the title wins
        let mut v = Video { title: "Chemistry lesson".into(), category: "Gaming".into(), ..Default::default() };
        judge_video(&mut v, &[]);
        assert!(!v.allowed); // a known category decides
        let mut v = Video { title: "My day".into(), channel_id: "UCok".into(), ..Default::default() };
        judge_video(&mut v, &["UCok".into()]);
        assert!(v.allowed);
    }
}
