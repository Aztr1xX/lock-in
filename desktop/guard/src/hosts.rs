//! Reads and writes the Lock In section of the hosts file.
//! Everything Lock In adds sits between two marker lines, so it can always be removed cleanly
//! and nothing else in the file is ever touched.

use std::path::PathBuf;

const START: &str = "# >>> Lock In (added during a focus round, removed automatically)";
const END: &str = "# <<< Lock In";

fn path() -> PathBuf {
    if let Some(p) = std::env::var_os("LOCKIN_HOSTS") {
        return PathBuf::from(p);
    }
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    root.join("System32").join("drivers").join("etc").join("hosts")
}

/// Turns what a person typed ("https://www.reddit.com/r/x", "Reddit.com") into clean host names,
/// adding the www. and m. versions so the obvious ways in are all covered.
pub fn expand(input: &[String]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for raw in input {
        let mut h = raw.trim().to_lowercase();
        for p in ["https://", "http://"] {
            if let Some(rest) = h.strip_prefix(p) {
                h = rest.to_string();
            }
        }
        h = h.split(['/', '?', '#', ':']).next().unwrap_or("").trim_end_matches('.').to_string();
        let base = h.strip_prefix("www.").unwrap_or(&h).to_string();
        let ok = base.len() <= 253
            && base.contains('.')
            && !base.starts_with('.')
            && base.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
            && base != "localhost";
        if !ok {
            continue;
        }
        let mut names = vec![base.clone(), format!("www.{base}")];
        if base.split('.').count() == 2 {
            names.push(format!("m.{base}"));
        }
        for n in names {
            if !out.contains(&n) {
                out.push(n);
            }
        }
    }
    out
}

fn without_block(text: &str) -> Vec<String> {
    let mut keep = vec![];
    let mut inside = false;
    for line in text.lines() {
        let t = line.trim();
        if t == START {
            inside = true;
            continue;
        }
        if inside && t == END {
            inside = false;
            continue;
        }
        if !inside {
            keep.push(line.trim_end_matches('\r').to_string());
        }
    }
    while keep.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        keep.pop();
    }
    keep
}

fn write(lines: &[String]) -> Result<(), String> {
    let nl = if cfg!(windows) { "\r\n" } else { "\n" };
    let text = lines.join(nl) + nl;
    let p = path();
    let mut last = String::new();
    // Antivirus sometimes holds the file for a moment, so try a few times.
    for _ in 0..5 {
        match std::fs::write(&p, &text) {
            Ok(()) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    Err(format!("writing {}: {last}", p.display()))
}

fn read() -> Result<String, String> {
    match std::fs::read(path()) {
        Ok(b) => Ok(String::from_utf8_lossy(&b).to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn write_block(names: &[String]) -> Result<(), String> {
    let mut lines = without_block(&read()?);
    lines.push(String::new());
    lines.push(START.into());
    for n in names {
        lines.push(format!("127.0.0.1 {n}"));
        lines.push(format!("::1 {n}"));
    }
    lines.push(END.into());
    write(&lines)
}

/// True if the Lock In section is still in the hosts file.
pub fn has_block() -> bool {
    read().map(|t| t.contains(START)).unwrap_or(false)
}

pub fn clear_block() -> Result<(), String> {
    let text = read()?;
    if !text.contains(START) {
        return Ok(());
    }
    write(&without_block(&text))
}

pub fn flush_dns() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("ipconfig").arg("/flushdns").creation_flags(CREATE_NO_WINDOW).status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_and_cleans() {
        let got = expand(&["https://www.Reddit.com/r/x".into(), "bad name".into(), "news.ycombinator.com".into()]);
        assert_eq!(got, vec!["reddit.com", "www.reddit.com", "m.reddit.com", "news.ycombinator.com", "www.news.ycombinator.com"]);
    }

    #[test]
    fn block_round_trip_keeps_other_lines() {
        let dir = std::env::temp_dir().join(format!("lockin-hosts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("hosts");
        std::fs::write(&f, "# my hosts\n10.0.0.1 nas.local\n").unwrap();
        std::env::set_var("LOCKIN_HOSTS", &f);
        write_block(&["reddit.com".into()]).unwrap();
        write_block(&["x.com".into()]).unwrap(); // a second block replaces the first
        let t = std::fs::read_to_string(&f).unwrap();
        assert!(t.contains("127.0.0.1 x.com") && !t.contains("reddit"));
        assert_eq!(t.matches(START).count(), 1);
        clear_block().unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap().replace("\r\n", "\n"), "# my hosts\n10.0.0.1 nas.local\n");
    }
}
