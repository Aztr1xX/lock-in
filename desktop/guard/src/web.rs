//! The Guard's own connections to real sites (study-only YouTube).
//!
//! During a round the hosts file and the name layer stop youtube.com for everything, so the
//! Guard looks names up itself (plain DNS to public resolvers) and connects from a reserved range
//! of local ports that the name layer lets through.

use rustls::pki_types::ServerName;
use std::net::{Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Local ports the Guard's own connections come from. divert.rs never touches these.
pub const OWN_PORTS: (u16, u16) = (47000, 48999);

/// Looks up an IPv4 address without going through Windows (so not through the hosts file).
/// Answers are kept for five minutes.
pub fn resolve(host: &str) -> Option<Ipv4Addr> {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Instant;
    static CACHE: OnceLock<Mutex<HashMap<String, (Ipv4Addr, Instant)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((ip, at)) = cache.lock().unwrap().get(host) {
        if at.elapsed() < Duration::from_secs(300) {
            return Some(*ip);
        }
    }
    for server in ["1.1.1.1:53", "8.8.8.8:53", "9.9.9.9:53"] {
        if let Some(ip) = query(host, server) {
            cache.lock().unwrap().insert(host.to_string(), (ip, Instant::now()));
            return Some(ip);
        }
    }
    None
}

fn query(host: &str, server: &str) -> Option<Ipv4Addr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let id: u16 = (std::process::id() as u16) ^ 0x5a5a;
    let mut q = vec![];
    q.extend_from_slice(&id.to_be_bytes());
    q.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]); // recursion desired, one question
    for label in host.split('.') {
        if label.is_empty() || label.len() > 63 {
            return None;
        }
        q.push(label.len() as u8);
        q.extend_from_slice(label.as_bytes());
    }
    q.extend_from_slice(&[0, 0, 1, 0, 1]); // type A, class IN
    sock.send_to(&q, server).ok()?;
    let mut buf = [0u8; 1500];
    let n = sock.recv(&mut buf).ok()?;
    parse_answer(&buf[..n], id)
}

fn skip_name(b: &[u8], mut i: usize) -> Option<usize> {
    loop {
        let len = *b.get(i)? as usize;
        if len == 0 {
            return Some(i + 1);
        }
        if len & 0xc0 == 0xc0 {
            return Some(i + 2);
        }
        i += 1 + len;
    }
}

fn parse_answer(b: &[u8], id: u16) -> Option<Ipv4Addr> {
    if b.len() < 12 || u16::from_be_bytes([b[0], b[1]]) != id {
        return None;
    }
    let qd = u16::from_be_bytes([b[4], b[5]]);
    let an = u16::from_be_bytes([b[6], b[7]]);
    let mut i = 12;
    for _ in 0..qd {
        i = skip_name(b, i)? + 4;
    }
    for _ in 0..an {
        i = skip_name(b, i)?;
        let ty = u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?]);
        let len = u16::from_be_bytes([*b.get(i + 8)?, *b.get(i + 9)?]) as usize;
        i += 10;
        if ty == 1 && len == 4 {
            return Some(Ipv4Addr::new(b[i], b[i + 1], b[i + 2], b[i + 3]));
        }
        i += len;
    }
    None
}

fn client_config() -> Arc<rustls::ClientConfig> {
    static C: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    C.get_or_init(|| {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        Arc::new(
            rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("tls versions")
                .with_root_certificates(roots)
                .with_no_client_auth(),
        )
    })
    .clone()
}

/// Connects to `ip:443` from one of the reserved local ports.
fn connect(ip: Ipv4Addr) -> std::io::Result<TcpStream> {
    use socket2::{Domain, Protocol, Socket, Type};
    let target: SocketAddr = (ip, 443).into();
    let mut last = std::io::Error::other("no free port");
    // Start at a different port each time so a port in TIME_WAIT is skipped quickly.
    let span = OWN_PORTS.1 - OWN_PORTS.0 + 1;
    let start = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0) % span as u32) as u16;
    for k in 0..span {
        let port = OWN_PORTS.0 + (start + k) % span;
        let s = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
        if s.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)).into()).is_err() {
            continue;
        }
        match s.connect_timeout(&target.into(), Duration::from_secs(5)) {
            Ok(()) => {
                let t: TcpStream = s.into();
                t.set_read_timeout(Some(Duration::from_secs(30)))?;
                return Ok(t);
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// A TLS connection to the real site, made the Guard's way (own DNS, reserved local port).
pub type Tls = rustls::StreamOwned<rustls::ClientConnection, TcpStream>;

pub fn open(host: &str) -> Result<Tls, String> {
    let ip = resolve(host).ok_or("couldn't look up the site")?;
    let tcp = connect(ip).map_err(|e| format!("couldn't connect: {e}"))?;
    let name = ServerName::try_from(host.to_string()).map_err(|e| e.to_string())?;
    let conn = rustls::ClientConnection::new(client_config(), name).map_err(|e| e.to_string())?;
    Ok(rustls::StreamOwned::new(conn, tcp))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_dns_answer() {
        // Answer for example.com A 93.184.216.34, name compressed.
        let mut b = vec![0x12, 0x34, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0];
        b.extend_from_slice(&[7, b'e', b'x', b'a', b'm', b'p', b'l', b'e', 3, b'c', b'o', b'm', 0, 0, 1, 0, 1]);
        b.extend_from_slice(&[0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 216, 34]);
        assert_eq!(parse_answer(&b, 0x1234), Some(Ipv4Addr::new(93, 184, 216, 34)));
    }
}
