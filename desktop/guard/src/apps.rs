//! Finds the apps installed on this PC and sorts out which ones are distractions (games, game
//! launchers, chat, streaming), so the app can offer them as a list to close during a round.
//!
//! Sources: the Windows list of installed programs (for every user), Epic's install manifests,
//! and any game folder from the big launchers.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct App {
    /// What people call it ("VALORANT", "Discord").
    pub name: String,
    /// Process names to close, like "Discord.exe".
    pub exes: Vec<String>,
    /// "game", "launcher", "chat", "media" or "other".
    pub kind: String,
}

/// Well-known apps whose installer entry doesn't point at the program people actually run.
const KNOWN: &[(&str, &str, &[&str])] = &[
    ("valorant", "game", &["VALORANT.exe", "VALORANT-Win64-Shipping.exe"]),
    ("league of legends", "game", &["LeagueClient.exe", "LeagueClientUx.exe", "League of Legends.exe"]),
    ("fortnite", "game", &["FortniteClient-Win64-Shipping.exe", "FortniteLauncher.exe"]),
    ("roblox", "game", &["RobloxPlayerBeta.exe"]),
    ("minecraft", "game", &["Minecraft.exe", "MinecraftLauncher.exe", "Minecraft.Windows.exe"]),
    ("counter-strike", "game", &["cs2.exe"]),
    ("rocket league", "game", &["RocketLeague.exe"]),
    ("overwatch", "game", &["Overwatch.exe"]),
    ("genshin impact", "game", &["GenshinImpact.exe"]),
    ("steam", "launcher", &["steam.exe"]),
    ("epic games launcher", "launcher", &["EpicGamesLauncher.exe"]),
    ("riot client", "launcher", &["RiotClientServices.exe", "RiotClientUx.exe"]),
    ("battle.net", "launcher", &["Battle.net.exe"]),
    ("ea app", "launcher", &["EADesktop.exe"]),
    ("ubisoft connect", "launcher", &["upc.exe", "UbisoftConnect.exe"]),
    ("gog galaxy", "launcher", &["GalaxyClient.exe"]),
    ("discord", "chat", &["Discord.exe"]),
    ("whatsapp", "chat", &["WhatsApp.exe"]),
    ("telegram", "chat", &["Telegram.exe"]),
    ("messenger", "chat", &["Messenger.exe"]),
    ("spotify", "media", &["Spotify.exe"]),
    ("netflix", "media", &["Netflix.exe"]),
    ("tiktok", "media", &["TikTok.exe"]),
    ("vlc media player", "media", &["vlc.exe"]),
];

/// Folders the big launchers install games into.
pub const GAME_DIRS: &[&str] = &[
    "\\steamapps\\common\\",
    "\\epic games\\",
    "\\riot games\\",
    "\\battle.net\\",
    "\\ea games\\",
    "\\ubisoft game launcher\\games\\",
    "\\xboxgames\\",
    "\\gog galaxy\\games\\",
];

/// Things in game folders that are tools, not the game.
const SKIP_EXE: &[&str] = &["unins", "uninstall", "crash", "report", "setup", "redist", "vc_redist", "dxsetup", "helper", "update", "launcherpatcher", "easyanticheat", "be_service", "vanguard"];

fn known(name: &str) -> Option<(&'static str, Vec<String>)> {
    let low = name.to_lowercase();
    KNOWN
        .iter()
        .find(|(k, _, _)| low == *k || low.starts_with(&format!("{k} ")) || low.contains(k) && k.len() > 6)
        .map(|(_, kind, exes)| (*kind, exes.iter().map(|e| e.to_string()).collect()))
}

/// Sorts one installed program. `exe` is the program file its installer points at, if any.
pub fn classify(name: &str, location: &str, exe: Option<String>) -> Option<App> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let low = name.to_lowercase();
    // Updates, runtimes and drivers aren't apps anyone opens.
    if ["update for", "security update", "hotfix", "redistributable", "runtime", "driver", "sdk", "(kb"].iter().any(|w| low.contains(w)) {
        return None;
    }
    if let Some((kind, exes)) = known(name) {
        return Some(App { name: name.to_string(), exes, kind: kind.into() });
    }
    let in_game_dir = GAME_DIRS.iter().any(|d| format!("{}\\", location.to_lowercase()).contains(d));
    let exes: Vec<String> = exe
        .filter(|e| e.to_lowercase().ends_with(".exe"))
        .map(|e| e.rsplit(['\\', '/']).next().unwrap_or(&e).to_string())
        .filter(|e| !SKIP_EXE.iter().any(|s| e.to_lowercase().contains(s)))
        .into_iter()
        .collect();
    let kind = if in_game_dir { "game" } else { "other" };
    Some(App { name: name.to_string(), exes, kind: kind.into() })
}

/// Picks the likely main program in a game folder: the biggest .exe near the top that isn't a tool.
#[cfg(windows)]
fn main_exe(dir: &str) -> Option<String> {
    let mut best: Option<(u64, String)> = None;
    let mut visit = |path: &std::path::Path| {
        for e in std::fs::read_dir(path).into_iter().flatten().flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let low = name.to_lowercase();
            if low.ends_with(".exe") && !SKIP_EXE.iter().any(|s| low.contains(s)) {
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                if best.as_ref().is_none_or(|(b, _)| size > *b) {
                    best = Some((size, name));
                }
            }
            let _ = p;
        }
    };
    let root = std::path::Path::new(dir);
    visit(root);
    // Many games keep the real program one level down (bin, Binaries\Win64, game).
    for sub in ["bin", "Bin", "Binaries\\Win64", "game", "Game", "x64", "bin\\win64"] {
        visit(&root.join(sub));
    }
    best.map(|(_, n)| n)
}

#[cfg(windows)]
pub fn installed() -> Vec<App> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, HKEY_USERS, KEY_READ};
    use winreg::RegKey;
    const UNINSTALL: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
    let mut roots: Vec<RegKey> = vec![];
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    for p in [UNINSTALL.to_string(), "Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall".to_string()] {
        if let Ok(k) = hklm.open_subkey_with_flags(&p, KEY_READ) {
            roots.push(k);
        }
    }
    // Every signed-in user's own installs (Discord, Spotify and Roblox install per user).
    let hku = RegKey::predef(HKEY_USERS);
    for sid in hku.enum_keys().flatten() {
        if sid.ends_with("_Classes") {
            continue;
        }
        if let Ok(k) = hku.open_subkey_with_flags(format!("{sid}\\{UNINSTALL}"), KEY_READ) {
            roots.push(k);
        }
    }
    let mut out: Vec<App> = vec![];
    for root in roots {
        for key in root.enum_keys().flatten() {
            let Ok(k) = root.open_subkey_with_flags(&key, KEY_READ) else { continue };
            let get = |n: &str| k.get_value::<String, _>(n).unwrap_or_default();
            if k.get_value::<u32, _>("SystemComponent").unwrap_or(0) == 1 || !get("ParentKeyName").is_empty() {
                continue;
            }
            let location = get("InstallLocation").trim_matches('"').to_string();
            let icon = get("DisplayIcon");
            let exe = icon.split(',').next().map(|s| s.trim().trim_matches('"').to_string()).filter(|s| s.to_lowercase().ends_with(".exe"));
            let in_game_dir = GAME_DIRS.iter().any(|d| format!("{}\\", location.to_lowercase()).contains(d));
            let exe = if exe.is_none() && in_game_dir && !location.is_empty() { main_exe(&location) } else { exe };
            if let Some(app) = classify(&get("DisplayName"), &location, exe) {
                push(&mut out, app);
            }
        }
    }
    // Epic doesn't use the Windows list for its games.
    let manifests = std::path::Path::new("C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests");
    for e in std::fs::read_dir(manifests).into_iter().flatten().flatten() {
        let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let s = |n: &str| v.get(n).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let exe = s("LaunchExecutable");
        let mut app = classify(&s("DisplayName"), &s("InstallLocation"), Some(exe)).unwrap_or(App { name: s("DisplayName"), exes: vec![], kind: "game".into() });
        app.kind = if app.kind == "other" { "game".into() } else { app.kind };
        push(&mut out, app);
    }
    out.retain(|a| !a.exes.is_empty());
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[cfg(not(windows))]
pub fn installed() -> Vec<App> {
    vec![]
}

/// Adds an app, merging it with one of the same name (the same program is often listed twice).
fn push(out: &mut Vec<App>, app: App) {
    if app.name.is_empty() {
        return;
    }
    if let Some(have) = out.iter_mut().find(|a| a.name.eq_ignore_ascii_case(&app.name)) {
        for e in app.exes {
            if !have.exes.iter().any(|x| x.eq_ignore_ascii_case(&e)) {
                have.exes.push(e);
            }
        }
        if have.kind == "other" {
            have.kind = app.kind;
        }
        return;
    }
    out.push(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_programs() {
        let v = classify("VALORANT", "C:\\Riot Games\\VALORANT\\live", Some("C:\\Riot Games\\Riot Client\\RiotClientServices.exe".into())).unwrap();
        assert_eq!((v.kind.as_str(), v.exes[0].as_str()), ("game", "VALORANT.exe"));
        let d = classify("Discord", "C:\\Users\\r\\AppData\\Local\\Discord", Some("C:\\Users\\r\\AppData\\Local\\Discord\\app.ico".into())).unwrap();
        assert_eq!((d.kind.as_str(), d.exes[0].as_str()), ("chat", "Discord.exe"));
        let g = classify("Hades", "D:\\SteamLibrary\\steamapps\\common\\Hades", Some("D:\\SteamLibrary\\steamapps\\common\\Hades\\x64\\Hades.exe".into())).unwrap();
        assert_eq!((g.kind.as_str(), g.exes[0].as_str()), ("game", "Hades.exe"));
        let w = classify("Microsoft Word", "C:\\Program Files\\Microsoft Office", Some("C:\\Program Files\\Microsoft Office\\WINWORD.EXE".into())).unwrap();
        assert_eq!(w.kind, "other");
        assert!(classify("Microsoft Visual C++ 2015 Redistributable (x64)", "", None).is_none());
        assert!(classify("Security Update for Windows (KB123)", "", None).is_none());
        let mut out = vec![];
        push(&mut out, App { name: "Steam".into(), exes: vec!["steam.exe".into()], kind: "launcher".into() });
        push(&mut out, App { name: "steam".into(), exes: vec!["steam.exe".into(), "x.exe".into()], kind: "other".into() });
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].exes.len(), 2);
    }
}
