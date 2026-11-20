//! Extra blocking layers on top of the hosts file, so a block holds in every browser.
//!
//! The hosts file alone can be slipped past in three ways, and each one has a layer here:
//!   1. Secure DNS (DNS over HTTPS) asks a resolver on the internet instead of Windows, so the
//!      hosts file is never read. The names of the common DoH resolvers go into the hosts file too,
//!      and a firewall rule blocks their addresses, so browsers fall back to normal Windows DNS.
//!      This is what covers Opera, Vivaldi and anything else built on Chromium.
//!   2. A browser keeps using connections it already has open, so a site that was open before the
//!      round keeps working. Open TCP connections to blocked sites are cut when the round starts,
//!      and QUIC (HTTP/3 over UDP 443) is blocked for the round so nothing can hide there.
//!   3. Subdomains (music.youtube.com, old.reddit.com) aren't in the hosts file. Chrome, Edge,
//!      Brave and Firefox get the block as a browser policy too, which covers every subdomain,
//!      works in Incognito, and shows the browser's own "blocked" page.
//!
//! Everything added is written down in the Guard's saved state, so it is always removed again,
//! even after a crash or a restart.

use crate::log;

/// Hosts of the common DNS over HTTPS resolvers. Browsers look these up through Windows first,
/// so pointing them at nothing turns secure DNS off for the round.
pub const DOH_HOSTS: &[&str] = &[
    "dns.google", "dns.google.com", "8888.google",
    "cloudflare-dns.com", "mozilla.cloudflare-dns.com", "chrome.cloudflare-dns.com", "one.one.one.one",
    "1dot1dot1dot1.cloudflare-dns.com", "security.cloudflare-dns.com", "family.cloudflare-dns.com",
    "dns.quad9.net", "dns9.quad9.net", "dns10.quad9.net", "dns11.quad9.net",
    "doh.opendns.com", "doh.familyshield.opendns.com", "dns.nextdns.io", "doh.cleanbrowsing.org",
    "dns.adguard.com", "dns.adguard-dns.com", "doh.dns.sb", "dns.sb", "doh.mullvad.net", "dns.mullvad.net",
    "freedns.controld.com", "dns.controld.com", "doh.opera.com", "dns.brave.com",
];

/// Addresses of the same resolvers, for the firewall rule (port 443 and 853 only, so normal
/// DNS on port 53 to the same servers keeps working).
const DOH_IPS: &str = "1.1.1.1,1.0.0.1,1.1.1.2,1.0.0.2,1.1.1.3,1.0.0.3,8.8.8.8,8.8.4.4,9.9.9.9,149.112.112.112,\
9.9.9.10,149.112.112.10,9.9.9.11,149.112.112.11,208.67.222.222,208.67.220.220,208.67.222.123,208.67.220.123,\
94.140.14.14,94.140.15.15,185.228.168.168,185.228.169.168,45.90.28.0/24,45.90.30.0/24,76.76.2.0/24,76.76.10.0/24,\
194.242.2.0/24,185.222.222.222,45.11.45.11,\
2606:4700:4700::1111,2606:4700:4700::1001,2606:4700:4700::1112,2606:4700:4700::1002,2001:4860:4860::8888,\
2001:4860:4860::8844,2620:fe::fe,2620:fe::9,2620:119:35::35,2620:119:53::53,2a10:50c0::ad1:ff,2a10:50c0::ad2:ff";

const RULE: &str = "LockInFocusRound";

/// Chromium browsers that read Windows policies, and where.
const CHROMIUM: &[(&str, &str)] = &[
    ("Chrome", r"SOFTWARE\Policies\Google\Chrome"),
    ("Edge", r"SOFTWARE\Policies\Microsoft\Edge"),
    ("Brave", r"SOFTWARE\Policies\BraveSoftware\Brave"),
    ("Chromium", r"SOFTWARE\Policies\Chromium"),
];
const FIREFOX: &str = r"SOFTWARE\Policies\Mozilla\Firefox";

/// Base site names, without the www. and m. copies the hosts file needs.
pub fn bases(names: &[String]) -> Vec<String> {
    names
        .iter()
        .filter(|n| !n.starts_with("www.") && !(n.starts_with("m.") && n.split('.').count() == 3))
        .cloned()
        .collect()
}

/// Adds every layer. Returns what was added (to be removed later) and the names of the layers that took.
pub fn apply(sites: &[String]) -> (Vec<String>, Vec<String>) {
    let mut touched = vec![];
    let mut layers = vec![];
    let bases = bases(sites);
    for (name, key) in CHROMIUM {
        let mut ok = reg::add_list(&format!(r"{key}\URLBlocklist"), &bases, &mut touched);
        // Secure DNS off as well, in case a site is reached by a name the policy doesn't cover.
        ok &= reg::set_if_absent(key, "DnsOverHttpsMode", "off", &mut touched);
        if ok {
            layers.push(name.to_string());
        }
    }
    let ff: Vec<String> = bases.iter().map(|b| format!("*://*.{b}/*")).collect();
    if reg::add_list(&format!(r"{FIREFOX}\WebsiteFilter\Block"), &ff, &mut touched)
        & reg::set_dword_if_absent(&format!(r"{FIREFOX}\DNSOverHTTPS"), "Enabled", 0, &mut touched)
    {
        layers.push("Firefox".into());
    }
    if firewall_on() {
        layers.push("Firewall".into());
    }
    let cut = net::cut_connections(&net::addresses_of(sites));
    if cut > 0 {
        log(&format!("cut {cut} open connections to blocked sites"));
    }
    (touched, layers)
}

/// Creates the browsers' (empty) policy keys once, at install. Chrome and Edge only notice policy
/// changes straight away if the key already existed when they started; an empty key changes nothing.
pub fn prepare() {
    for (_, key) in CHROMIUM {
        reg::ensure(key);
    }
    reg::ensure(FIREFOX);
}

/// Keys kept even when empty, so browsers keep watching them.
fn kept(key: &str) -> bool {
    CHROMIUM.iter().any(|(_, k)| *k == key) || key == FIREFOX
}

/// Removes everything `apply` added.
pub fn clear(touched: &[String]) {
    reg::remove(touched);
    firewall_off();
}

// ---------- firewall ----------

fn netsh(args: &[&str]) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut full = vec!["advfirewall", "firewall"];
        full.extend_from_slice(args);
        return std::process::Command::new("netsh")
            .args(&full)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    }
    #[cfg(not(windows))]
    {
        let _ = args;
        false
    }
}

fn firewall_on() -> bool {
    firewall_off();
    let name = format!("name={RULE}");
    let ips = format!("remoteip={DOH_IPS}");
    let a = netsh(&["add", "rule", &name, "dir=out", "action=block", "protocol=TCP", "remoteport=443,853", &ips]);
    // QUIC: browsers fall straight back to normal HTTPS, which the other layers can see and stop.
    let b = netsh(&["add", "rule", &name, "dir=out", "action=block", "protocol=UDP", "remoteport=443,853"]);
    if !(a && b) {
        log("firewall rule could not be added");
    }
    a && b
}

fn firewall_off() {
    netsh(&["delete", "rule", &format!("name={RULE}")]);
}

// ---------- registry ----------

#[cfg(windows)]
mod reg {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_ALL_ACCESS};
    use winreg::RegKey;

    fn hklm() -> RegKey {
        RegKey::predef(HKEY_LOCAL_MACHINE)
    }

    /// Adds `items` to a policy list, numbered after anything already there.
    pub fn add_list(key: &str, items: &[String], touched: &mut Vec<String>) -> bool {
        let Ok((k, _)) = hklm().create_subkey(key) else { return false };
        let mut next = k
            .enum_values()
            .flatten()
            .filter_map(|(n, _)| n.parse::<u32>().ok())
            .max()
            .unwrap_or(0)
            + 1;
        for item in items {
            let name = next.to_string();
            if k.set_value(&name, item).is_err() {
                return false;
            }
            touched.push(format!("{key}|{name}"));
            next += 1;
        }
        true
    }

    /// Sets a string policy only if nobody else has, so a person's own setting is never overwritten.
    pub fn set_if_absent(key: &str, name: &str, value: &str, touched: &mut Vec<String>) -> bool {
        let Ok((k, _)) = hklm().create_subkey(key) else { return false };
        if k.get_raw_value(name).is_ok() {
            return true;
        }
        let ok = k.set_value(name, &value).is_ok();
        if ok {
            touched.push(format!("{key}|{name}"));
        }
        ok
    }

    pub fn set_dword_if_absent(key: &str, name: &str, value: u32, touched: &mut Vec<String>) -> bool {
        let Ok((k, _)) = hklm().create_subkey(key) else { return false };
        if k.get_raw_value(name).is_ok() {
            return true;
        }
        let ok = k.set_value(name, &value).is_ok();
        if ok {
            touched.push(format!("{key}|{name}"));
        }
        ok
    }

    pub fn ensure(key: &str) {
        let _ = hklm().create_subkey(key);
    }

    /// Deletes the values we added, then any key left completely empty, deepest first.
    pub fn remove(touched: &[String]) {
        let mut keys: Vec<&str> = vec![];
        for t in touched {
            let Some((key, name)) = t.split_once('|') else { continue };
            if let Ok(k) = hklm().open_subkey_with_flags(key, KEY_ALL_ACCESS) {
                let _ = k.delete_value(name);
            }
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
        // Walk each key up towards SOFTWARE\Policies, removing the ones that are now empty.
        let mut all: Vec<String> = vec![];
        for key in keys {
            let mut k = key.to_string();
            while k.len() > r"SOFTWARE\Policies".len() && k.starts_with(r"SOFTWARE\Policies\") && !super::kept(&k) {
                if !all.contains(&k) {
                    all.push(k.clone());
                }
                match k.rfind('\\') {
                    Some(i) => k.truncate(i),
                    None => break,
                }
            }
        }
        all.sort_by_key(|k| std::cmp::Reverse(k.len()));
        for key in all {
            let empty = hklm()
                .open_subkey(&key)
                .map(|k| k.enum_values().next().is_none() && k.enum_keys().next().is_none())
                .unwrap_or(false);
            if empty {
                let _ = hklm().delete_subkey(&key);
            }
        }
    }
}

#[cfg(not(windows))]
mod reg {
    pub fn add_list(_: &str, _: &[String], _: &mut Vec<String>) -> bool {
        false
    }
    pub fn set_if_absent(_: &str, _: &str, _: &str, _: &mut Vec<String>) -> bool {
        false
    }
    pub fn set_dword_if_absent(_: &str, _: &str, _: u32, _: &mut Vec<String>) -> bool {
        false
    }
    pub fn remove(_: &[String]) {}
    pub fn ensure(_: &str) {}
}

// ---------- open connections ----------

mod net {
    use std::net::{Ipv4Addr, ToSocketAddrs};

    /// Where the blocked sites live right now, looked up before the hosts file changes.
    pub fn addresses_of(names: &[String]) -> Vec<Ipv4Addr> {
        let mut out = vec![];
        for n in names {
            if let Ok(addrs) = (n.as_str(), 443).to_socket_addrs() {
                for a in addrs {
                    if let std::net::IpAddr::V4(ip) = a.ip() {
                        if !ip.is_loopback() && !out.contains(&ip) {
                            out.push(ip);
                        }
                    }
                }
            }
        }
        out
    }

    /// Resets open TCP connections to those addresses, so a page that was already open stops loading.
    /// Only IPv4 can be cut this way; IPv6 connections end on their own once the browser reconnects.
    #[cfg(windows)]
    pub fn cut_connections(ips: &[Ipv4Addr]) -> usize {
        use windows_sys::Win32::NetworkManagement::IpHelper::{
            GetTcpTable, SetTcpEntry, MIB_TCPROW_LH, MIB_TCPTABLE, MIB_TCP_STATE_DELETE_TCB, MIB_TCP_STATE_ESTAB,
        };
        if ips.is_empty() {
            return 0;
        }
        let mut size = 0u32;
        unsafe {
            GetTcpTable(std::ptr::null_mut(), &mut size, 0);
            if size == 0 {
                return 0;
            }
            // u32 buffer keeps the table aligned.
            let mut buf = vec![0u32; (size as usize).div_ceil(4) + 16];
            size = (buf.len() * 4) as u32;
            let table = buf.as_mut_ptr() as *mut MIB_TCPTABLE;
            if GetTcpTable(table, &mut size, 0) != 0 {
                return 0;
            }
            let n = (*table).dwNumEntries as usize;
            let rows = std::slice::from_raw_parts((*table).table.as_ptr(), n);
            let mut cut = 0;
            for r in rows {
                // Addresses are in network byte order: the first octet is the lowest byte.
                let remote = Ipv4Addr::from(u32::from_be(r.dwRemoteAddr));
                if r.Anonymous.dwState as i32 != MIB_TCP_STATE_ESTAB || !ips.contains(&remote) {
                    continue;
                }
                let mut row: MIB_TCPROW_LH = *r;
                row.Anonymous.dwState = MIB_TCP_STATE_DELETE_TCB as u32;
                if SetTcpEntry(&row) == 0 {
                    cut += 1;
                }
            }
            cut
        }
    }

    #[cfg(not(windows))]
    pub fn cut_connections(_: &[Ipv4Addr]) -> usize {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bases_drop_copies() {
        let got = bases(&["reddit.com".into(), "www.reddit.com".into(), "m.reddit.com".into(), "music.youtube.com".into()]);
        assert_eq!(got, vec!["reddit.com", "music.youtube.com"]);
    }
}
