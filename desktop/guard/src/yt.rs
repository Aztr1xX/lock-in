//! Study-only YouTube: decides which searches and videos are for learning.
//!
//! Searches are judged by their words. A video is judged by the category its uploader filed it
//! under when YouTube says (Education, Science & Technology), and otherwise by its title,
//! description and tags: it has to read like it teaches something and not like entertainment.

const ALLOWED: &[&str] = &["Education", "Science & Technology"];
/// Categories that are almost never study unless the title says so.
const LEISURE: &[&str] = &["Gaming", "Music", "Comedy", "Sports", "Entertainment", "Film & Animation"];

const STUDY: &[&str] = &[
    "lecture", "lectures", "lesson", "lessons", "tutorial", "tutorials", "explained", "explanation", "how to",
    "revision", "revise", "exam", "exams", "gcse", "a level", "a levels", "alevel", "ib", "sat", "hsc", "vce",
    "atar", "matric", "nsc", "ieb", "past paper", "past papers", "worked example", "worked examples",
    "practice questions", "crash course", "online course", "khan", "physics", "chemistry", "biology", "math", "maths",
    "mathematics", "calculus", "algebra", "geometry", "trig", "trigonometry", "statistics", "equation",
    "equations", "derivative", "derivatives", "integral", "integrals", "integration", "differentiation",
    "history", "geography", "economics", "accounting", "psychology", "english", "essay", "essays", "grammar",
    "literature", "shakespeare", "poetry", "afrikaans", "spanish", "french", "german", "japanese", "chinese",
    "programming", "coding", "python", "javascript", "java", "computer science", "study", "notes", "summary",
    "science", "cell", "cells", "atom", "atoms", "molecule", "molecules", "organic", "vector", "vectors",
    "matrix", "matrices", "probability", "thermodynamics", "quantum", "electricity", "circuit", "circuits",
    "genetics", "dna", "evolution", "photosynthesis", "mitosis", "meiosis", "enzyme", "enzymes", "anatomy",
    "physiology", "study with me", "pomodoro", "proof", "theorem", "formula", "definition", "learn",
    "learning", "explain", "explains", "understand", "understanding", "introduction", "intro to", "basics",
    "fundamentals", "beginner", "beginners", "concept", "concepts", "theory", "solve", "solving",
    "examples", "university", "professor", "teacher", "teach", "teaching", "education", "educational",
    "step by step", "alkene", "alkenes", "alkane", "alkanes", "reaction", "reactions", "stoichiometry",
    "titration", "kinematics", "momentum", "electrons", "lesson plan", "syllabus", "grade 12", "grade 11",
    "grade 10", "matric", "olympiad", "linear algebra", "differential equations", "economics",
];
const FUN: &[&str] = &[
    "minecraft", "valorant", "fortnite", "roblox", "gta", "call of duty", "cod", "warzone", "csgo", "cs2",
    "counter strike", "league of legends", "apex", "overwatch", "rocket league", "fifa", "ea fc",
    "clash royale", "clash of clans", "brawl stars", "among us", "gameplay", "lets play", "let's play",
    "speedrun", "stream", "twitch", "funny", "prank", "meme", "memes", "compilation", "fails", "react",
    "reacts", "reaction", "vlog", "vlogs", "mrbeast", "tiktok", "shorts", "asmr", "music video",
    "official video", "lyrics", "song", "songs", "playlist", "album", "movie", "movies", "trailer", "episode",
    "anime", "highlights", "nba", "nfl", "ufc", "wwe", "f1", "unboxing", "try not to laugh", "drama", "edit",
    "edits", "brawlhalla", "official music video", "official audio", "remix", "challenge", "funniest",
    "mukbang", "haul", "tier list", "gaming",
];

fn words_of(q: &str) -> String {
    format!(
        " {} ",
        q.to_lowercase().chars().map(|c| if c.is_alphanumeric() || c == '\'' { c } else { ' ' }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
    )
}

fn has_any(q: &str, words: &[&str]) -> bool {
    hits(q, words) > 0
}

/// How many different words from `words` appear in `q` (whole words only).
fn hits(q: &str, words: &[&str]) -> usize {
    let padded = words_of(q);
    words.iter().filter(|w| padded.contains(&format!(" {w} "))).count()
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

/// Whether a video teaches something, from what YouTube says about it.
pub fn is_study(title: &str, description: &str, keywords: &str, category: &str) -> bool {
    if ALLOWED.contains(&category) {
        return true;
    }
    if has_any(title, FUN) {
        return false;
    }
    let in_title = hits(title, STUDY);
    if LEISURE.contains(&category) && in_title == 0 {
        return false;
    }
    in_title * 2 + hits(&format!("{description} {keywords}"), STUDY) >= 2
}

/// YouTube's own category names; pages have other "category" keys that aren't these.
const CATEGORIES: &[&str] = &[
    "Film & Animation", "Autos & Vehicles", "Music", "Pets & Animals", "Sports", "Travel & Events", "Gaming",
    "People & Blogs", "Comedy", "Entertainment", "News & Politics", "Howto & Style", "Education",
    "Science & Technology", "Nonprofits & Activism",
];

pub fn parse_category(html: &str) -> String {
    for key in ["\"category\":\"", "itemprop=\"genre\" content=\""] {
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
    fn judges_videos() {
        assert!(is_study("Alkene Addition Reactions: Crash Course Organic Chemistry #16", "", "", ""));
        assert!(is_study("Lecture 3", "", "", "Education"));
        assert!(is_study("The Map of Mathematics", "An animated tour that explains how the fields of maths fit together.", "", "Science & Technology"));
        assert!(is_study("Why do cells divide?", "We explain mitosis step by step.", "", "People & Blogs"));
        assert!(!is_study("Rick Astley - Never Gonna Give You Up (Official Video)", "The official video", "", "Music"));
        assert!(!is_study("Minecraft but chemistry is real", "", "", "Gaming"));
        assert!(!is_study("My week in Cape Town", "Of course I had to try the food", "vlog", "People & Blogs"));
        assert!(!is_study("Top 10 goals", "learn more on our site", "", "Sports"));
        assert_eq!(parse_category(r#"..."category":"VIDEO","category":"Science \u0026 Technology",..."#), "Science & Technology");
    }
}
