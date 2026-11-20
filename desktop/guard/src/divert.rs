//! The strongest blocking layer: recognises a blocked site by name as the connection is made.
//!
//! Every HTTPS connection starts with a ClientHello that names the site in plain text (the SNI).
//! During a round, WinDivert (a signed packet filter driver, bundled next to the Guard) hands the
//! Guard each outgoing HTTPS packet. If a new connection names a blocked site, the packet is dropped
//! and the browser is told the connection was reset. That works the same in every browser,
//! whatever DNS it uses, because it never relies on name lookups at all.
//!
//! QUIC (HTTP/3) is blocked by the firewall layer for the round, so browsers always use TCP here.
//! Nothing is loaded outside a round, and if the driver is missing the other layers still work.

use crate::log;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Sites being blocked (base names, subdomains included) and whether the layer is running.
struct Shared {
    sites: Vec<String>,
    /// Also stopped, but not shown as attempts: secure DNS servers and Opera's built-in VPN.
    extra: Vec<String>,
    handle: isize,
}

fn shared() -> &'static Mutex<Shared> {
    static S: OnceLock<Mutex<Shared>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Shared { sites: vec![], extra: vec![], handle: 0 }))
}

/// True if `host` is a blocked site or any part of one.
pub fn matches(host: &str, sites: &[String]) -> bool {
    sites.iter().any(|s| host == s || (host.len() > s.len() && host.ends_with(s.as_str()) && host.as_bytes()[host.len() - s.len() - 1] == b'.'))
}

/// Opera's built-in VPN connects through these; stopping them during a round stops it routing around the block.
const VPN_HOSTS: &[&str] = &["sec-tunnel.com", "opera-proxy.net"];

// ---------- packets ----------

#[derive(Hash, PartialEq, Eq, Clone, Copy)]
struct Flow {
    src: [u8; 16],
    dst: [u8; 16],
    sport: u16,
    dport: u16,
}

struct Tcp<'a> {
    v6: bool,
    src: &'a [u8],
    dst: &'a [u8],
    sport: u16,
    dport: u16,
    seq: u32,
    ack: u32,
    payload: &'a [u8],
}

fn parse(p: &[u8]) -> Option<Tcp<'_>> {
    let (v6, ip_len, src, dst) = match p.first()? >> 4 {
        4 => {
            let ihl = ((p[0] & 0x0f) as usize) * 4;
            if p.len() < ihl + 20 || p[9] != 6 {
                return None;
            }
            let total = (u16::from_be_bytes([p[2], p[3]]) as usize).min(p.len());
            (false, (ihl, total), &p[12..16], &p[16..20])
        }
        6 => {
            if p.len() < 60 || p[6] != 6 {
                return None; // extension headers are rare on outgoing HTTPS; let those pass
            }
            let total = (40 + u16::from_be_bytes([p[4], p[5]]) as usize).min(p.len());
            (true, (40, total), &p[8..24], &p[24..40])
        }
        _ => return None,
    };
    let (o, total) = ip_len;
    let t = &p[o..total];
    let off = ((t[12] >> 4) as usize) * 4;
    if t.len() < off {
        return None;
    }
    Some(Tcp {
        v6,
        src,
        dst,
        sport: u16::from_be_bytes([t[0], t[1]]),
        dport: u16::from_be_bytes([t[2], t[3]]),
        seq: u32::from_be_bytes([t[4], t[5], t[6], t[7]]),
        ack: u32::from_be_bytes([t[8], t[9], t[10], t[11]]),
        payload: &t[off..],
    })
}

fn flow(t: &Tcp) -> Flow {
    let mut src = [0u8; 16];
    let mut dst = [0u8; 16];
    src[..t.src.len()].copy_from_slice(t.src);
    dst[..t.dst.len()].copy_from_slice(t.dst);
    Flow { src, dst, sport: t.sport, dport: t.dport }
}

/// A reset sent back to the browser, so it gives up straight away instead of waiting.
fn reset_for(t: &Tcp) -> Vec<u8> {
    let mut tcp = [0u8; 20];
    tcp[0..2].copy_from_slice(&t.dport.to_be_bytes());
    tcp[2..4].copy_from_slice(&t.sport.to_be_bytes());
    tcp[4..8].copy_from_slice(&t.ack.to_be_bytes());
    tcp[8..12].copy_from_slice(&t.seq.wrapping_add(t.payload.len() as u32).to_be_bytes());
    tcp[12] = 0x50;
    tcp[13] = 0x14; // RST + ACK
    let mut p = vec![];
    if t.v6 {
        p.extend_from_slice(&[0x60, 0, 0, 0, 0, 20, 6, 64]);
        p.extend_from_slice(t.dst);
        p.extend_from_slice(t.src);
    } else {
        p.extend_from_slice(&[0x45, 0, 0, 40, 0, 0, 0x40, 0, 64, 6, 0, 0]);
        p.extend_from_slice(t.dst);
        p.extend_from_slice(t.src);
    }
    p.extend_from_slice(&tcp);
    p
}

/// What to do with one outgoing packet.
enum Verdict {
    Pass,
    Block(String),
}

/// Remembers the start of connections whose ClientHello is split over two packets (common now
/// that browsers send large post-quantum keys), and connections already judged.
struct Judge {
    partial: HashMap<Flow, Vec<u8>>,
    done: HashMap<Flow, bool>,
    /// For the first two minutes of a round, connections that were already open when it started
    /// are reset. Browsers keep reusing an open connection (even on refresh), so without this a
    /// site that was open before the round keeps working. They reconnect straight away and the
    /// new connection is judged by name like any other.
    reset_open_until: std::time::Instant,
}

impl Default for Judge {
    fn default() -> Self {
        Judge {
            partial: HashMap::new(),
            done: HashMap::new(),
            reset_open_until: std::time::Instant::now() + std::time::Duration::from_secs(120),
        }
    }
}

impl Judge {
    fn verdict(&mut self, t: &Tcp, sites: &[String]) -> Verdict {
        let f = flow(t);
        if let Some(&blocked) = self.done.get(&f) {
            return if blocked { Verdict::Block(String::new()) } else { Verdict::Pass };
        }
        if self.done.len() > 50_000 {
            // Forgetting judged connections is only safe once old ones are no longer being reset.
            self.done.clear();
            self.reset_open_until = std::time::Instant::now();
        }
        let data: Vec<u8> = match self.partial.remove(&f) {
            Some(mut start) => {
                start.extend_from_slice(t.payload);
                start
            }
            None => {
                if t.payload.len() < 6 || t.payload[0] != 0x16 || t.payload[5] != 0x01 {
                    // Not the start of a connection: one that was open before the round.
                    let reset = std::time::Instant::now() < self.reset_open_until;
                    self.done.insert(f, reset);
                    return if reset { Verdict::Block(String::new()) } else { Verdict::Pass };
                }
                t.payload.to_vec()
            }
        };
        match crate::sni::server_name(&data) {
            Some(host) => {
                let blocked = matches(&host, sites);
                self.done.insert(f, blocked);
                if blocked {
                    Verdict::Block(host)
                } else {
                    Verdict::Pass
                }
            }
            None => {
                let want = 5 + u16::from_be_bytes([data[3], data[4]]) as usize;
                if data.len() < want && data.len() < 16 * 1024 {
                    if self.partial.len() > 2_000 {
                        self.partial.clear();
                    }
                    self.partial.insert(f, data);
                } else {
                    self.done.insert(f, false);
                }
                Verdict::Pass
            }
        }
    }
}

// ---------- WinDivert ----------

#[cfg(windows)]
mod ffi {
    use std::ffi::c_void;
    use windows_sys::core::PCSTR;
    use windows_sys::Win32::Foundation::{HANDLE, HMODULE};
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH};

    pub type Open = unsafe extern "C" fn(PCSTR, i32, i16, u64) -> HANDLE;
    pub type Recv = unsafe extern "C" fn(HANDLE, *mut c_void, u32, *mut u32, *mut c_void) -> i32;
    pub type Send = unsafe extern "C" fn(HANDLE, *const c_void, u32, *mut u32, *const c_void) -> i32;
    pub type Shutdown = unsafe extern "C" fn(HANDLE, i32) -> i32;
    pub type Close = unsafe extern "C" fn(HANDLE) -> i32;
    pub type Checksums = unsafe extern "C" fn(*mut c_void, u32, *mut c_void, u64) -> i32;

    pub struct Api {
        pub open: Open,
        pub recv: Recv,
        pub send: Send,
        pub shutdown: Shutdown,
        pub close: Close,
        pub checksums: Checksums,
    }

    /// Loads WinDivert.dll from the Guard's own folder (never from anywhere else).
    pub fn load() -> Option<&'static Api> {
        static API: std::sync::OnceLock<Option<Api>> = std::sync::OnceLock::new();
        API.get_or_init(|| unsafe {
            let dll = std::env::current_exe().ok()?.with_file_name("WinDivert.dll");
            if !dll.exists() {
                return None;
            }
            let wide: Vec<u16> = dll.as_os_str().encode_wide_null();
            let m: HMODULE = LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), LOAD_WITH_ALTERED_SEARCH_PATH);
            if m.is_null() {
                return None;
            }
            let get = |name: &[u8]| GetProcAddress(m, name.as_ptr());
            Some(Api {
                open: std::mem::transmute::<_, Open>(get(b"WinDivertOpen\0")?),
                recv: std::mem::transmute::<_, Recv>(get(b"WinDivertRecv\0")?),
                send: std::mem::transmute::<_, Send>(get(b"WinDivertSend\0")?),
                shutdown: std::mem::transmute::<_, Shutdown>(get(b"WinDivertShutdown\0")?),
                close: std::mem::transmute::<_, Close>(get(b"WinDivertClose\0")?),
                checksums: std::mem::transmute::<_, Checksums>(get(b"WinDivertHelperCalcChecksums\0")?),
            })
        })
        .as_ref()
    }

    trait Wide {
        fn encode_wide_null(&self) -> Vec<u16>;
    }
    impl Wide for std::ffi::OsStr {
        fn encode_wide_null(&self) -> Vec<u16> {
            use std::os::windows::ffi::OsStrExt;
            self.encode_wide().chain(std::iter::once(0)).collect()
        }
    }
}

/// Starts (or updates) the layer for these sites. Returns false if it couldn't start.
pub fn start(sites: Vec<String>) -> bool {
    {
        let mut s = shared().lock().unwrap();
        s.sites = sites;
        s.extra = crate::browsers::DOH_HOSTS.iter().chain(VPN_HOSTS).map(|h| h.to_string()).collect();
        if s.handle != 0 {
            return true;
        }
    }
    #[cfg(windows)]
    {
        let Some(api) = ffi::load() else {
            log("WinDivert not found next to the Guard; name layer off");
            return false;
        };
        // Only outgoing HTTPS packets that carry data, and never our own loopback sinkhole.
        let filter = b"outbound and !loopback and tcp.DstPort == 443 and tcp.PayloadLength > 0\0";
        let h = unsafe { (api.open)(filter.as_ptr(), 0, 0, 0) };
        if h.is_null() || h as isize == -1 {
            log(&format!("WinDivert could not start (error {})", std::io::Error::last_os_error()));
            return false;
        }
        let h = h as isize;
        shared().lock().unwrap().handle = h;
        std::thread::spawn(move || run(api, h));
        log("name layer started");
        true
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Stops the layer; every packet flows normally again.
pub fn stop() {
    let h = std::mem::take(&mut shared().lock().unwrap().handle);
    #[cfg(windows)]
    if h != 0 {
        if let Some(api) = ffi::load() {
            // Shutdown wakes the worker, which then closes the handle itself.
            unsafe { (api.shutdown)(h as _, 3) };
        }
    }
    #[cfg(not(windows))]
    let _ = h;
}

#[cfg(windows)]
fn run(api: &'static ffi::Api, h: isize) {
    use std::ffi::c_void;
    let mut judge = Judge::default();
    let mut buf = vec![0u8; 65_535];
    let mut addr = [0u8; 80];
    loop {
        let mut len = 0u32;
        let ok = unsafe { (api.recv)(h as _, buf.as_mut_ptr() as *mut c_void, buf.len() as u32, &mut len, addr.as_mut_ptr() as *mut c_void) };
        if ok == 0 {
            break; // shut down at the end of the round
        }
        let packet = &buf[..len as usize];
        let (sites, all) = {
            let s = shared().lock().unwrap();
            (s.sites.clone(), s.sites.iter().chain(&s.extra).cloned().collect::<Vec<_>>())
        };
        let verdict = match parse(packet) {
            Some(t) => match judge.verdict(&t, &all) {
                Verdict::Pass => None,
                Verdict::Block(host) => Some((reset_for(&t), host)),
            },
            None => None,
        };
        match verdict {
            None => unsafe {
                (api.send)(h as _, packet.as_ptr() as *const c_void, len, std::ptr::null_mut(), addr.as_ptr() as *const c_void);
            },
            Some((mut rst, host)) => {
                if matches(&host, &sites) {
                    crate::record_attempt(host);
                }
                // Same interface, but travelling inwards to the browser.
                let mut a = addr;
                let mut bits = u32::from_le_bytes([a[8], a[9], a[10], a[11]]);
                bits &= !(1 << 17); // not outbound
                a[8..12].copy_from_slice(&bits.to_le_bytes());
                unsafe {
                    (api.checksums)(rst.as_mut_ptr() as *mut c_void, rst.len() as u32, a.as_mut_ptr() as *mut c_void, 0);
                    (api.send)(h as _, rst.as_ptr() as *const c_void, rst.len() as u32, std::ptr::null_mut(), a.as_ptr() as *const c_void);
                }
            }
        }
    }
    unsafe { (api.close)(h as _) };
    log("name layer stopped");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subdomains_match_but_lookalikes_dont() {
        let sites = vec!["youtube.com".to_string()];
        assert!(matches("youtube.com", &sites));
        assert!(matches("music.youtube.com", &sites));
        assert!(!matches("notyoutube.com", &sites));
        assert!(!matches("youtube.com.evil.net", &sites));
    }

    fn packet_v4(payload: &[u8]) -> Vec<u8> {
        let mut p = vec![0x45, 0, 0, 0, 0, 0, 0x40, 0, 64, 6, 0, 0, 10, 0, 0, 2, 142, 250, 1, 1];
        let total = (20 + 20 + payload.len()) as u16;
        p[2..4].copy_from_slice(&total.to_be_bytes());
        p.extend_from_slice(&[0xc3, 0x50, 0x01, 0xbb, 0, 0, 0, 100, 0, 0, 0, 200, 0x50, 0x18, 0xff, 0xff, 0, 0, 0, 0]);
        p.extend_from_slice(payload);
        p
    }

    fn hello(host: &str, pad: usize) -> Vec<u8> {
        // A minimal ClientHello with a padding extension first, then the SNI (like a shuffled Chrome hello).
        let mut ext = vec![0x00, 0x15];
        ext.extend_from_slice(&(pad as u16).to_be_bytes());
        ext.extend(std::iter::repeat_n(0u8, pad));
        let name = host.as_bytes();
        let mut sni = vec![];
        sni.extend_from_slice(&((name.len() + 3) as u16).to_be_bytes());
        sni.push(0);
        sni.extend_from_slice(&(name.len() as u16).to_be_bytes());
        sni.extend_from_slice(name);
        ext.extend_from_slice(&[0, 0]);
        ext.extend_from_slice(&(sni.len() as u16).to_be_bytes());
        ext.extend_from_slice(&sni);
        let mut body = vec![3, 3];
        body.extend_from_slice(&[0u8; 32]);
        body.push(0); // session id
        body.extend_from_slice(&[0, 2, 0x13, 0x01]); // one suite
        body.extend_from_slice(&[1, 0]); // compression
        body.extend_from_slice(&(ext.len() as u16).to_be_bytes());
        body.extend_from_slice(&ext);
        let mut hs = vec![1, 0];
        hs.extend_from_slice(&(body.len() as u16).to_be_bytes());
        hs.extend_from_slice(&body);
        let mut rec = vec![0x16, 3, 1];
        rec.extend_from_slice(&(hs.len() as u16).to_be_bytes());
        rec.extend_from_slice(&hs);
        rec
    }

    #[test]
    fn blocks_a_hello_split_over_two_packets() {
        let sites = vec!["youtube.com".to_string()];
        let h = hello("www.youtube.com", 1500);
        let (a, b) = h.split_at(1400);
        let mut j = Judge::default();
        let p1 = packet_v4(a);
        assert!(matches!(j.verdict(&parse(&p1).unwrap(), &sites), Verdict::Pass));
        let p2 = packet_v4(b);
        assert!(matches!(j.verdict(&parse(&p2).unwrap(), &sites), Verdict::Block(ref h) if h == "www.youtube.com"));
    }

    #[test]
    fn resets_connections_open_before_the_round() {
        let sites = vec!["youtube.com".to_string()];
        let mut j = Judge::default();
        let mid = packet_v4(&[0x17, 3, 3, 0, 10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        assert!(matches!(j.verdict(&parse(&mid).unwrap(), &sites), Verdict::Block(ref h) if h.is_empty()));
        let mut later = Judge { reset_open_until: std::time::Instant::now(), ..Judge::default() };
        assert!(matches!(later.verdict(&parse(&mid).unwrap(), &sites), Verdict::Pass));
    }

    #[test]
    fn lets_other_sites_through() {
        let sites = vec!["youtube.com".to_string()];
        let p = packet_v4(&hello("en.wikipedia.org", 10));
        let mut j = Judge::default();
        assert!(matches!(j.verdict(&parse(&p).unwrap(), &sites), Verdict::Pass));
        let rst = reset_for(&parse(&p).unwrap());
        assert_eq!(rst.len(), 40);
        assert_eq!(&rst[12..16], &[142, 250, 1, 1]);
    }
}
