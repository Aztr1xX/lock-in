//! The "This can wait" page that blocked sites show, over HTTPS too.
//!
//! A browser only shows a page for an HTTPS site if the page comes with a certificate it trusts.
//! So for each round the Guard makes a fresh certificate authority that:
//!   - only exists in memory (its private key is never written anywhere),
//!   - can only vouch for the sites blocked in that round (name constraints), and
//!   - is added to Windows' trusted list when the round starts and removed when it ends.
//! Blocked names already point at the Guard through the hosts file, so the Guard answers with a
//! certificate for that site and serves the page.

use crate::log;
use rcgen::{BasicConstraints, CertificateParams, DnType, GeneralSubtree, IsCa, Issuer, KeyPair, KeyUsagePurpose, NameConstraints};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex, OnceLock};
use time::{Duration as TimeDuration, OffsetDateTime};

/// Common name of every round's authority, so leftovers can always be found and removed.
pub const CA_NAME: &str = "Lock In focus round";

struct Round {
    issuer: Issuer<'static, KeyPair>,
    ca_der: CertificateDer<'static>,
    sites: Vec<String>,
    leaves: HashMap<String, Arc<CertifiedKey>>,
}

fn round() -> &'static Mutex<Option<Round>> {
    static R: OnceLock<Mutex<Option<Round>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Makes this round's authority for `sites` and returns its certificate (public part only).
fn new_authority(sites: &[String]) -> Result<Round, rcgen::Error> {
    let key = KeyPair::generate()?;
    let mut p = CertificateParams::new(Vec::<String>::new())?;
    p.distinguished_name.push(DnType::CommonName, CA_NAME);
    p.distinguished_name.push(DnType::OrganizationName, "Lock In");
    p.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    p.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    p.name_constraints = Some(NameConstraints {
        permitted_subtrees: sites.iter().map(|s| GeneralSubtree::DnsName(s.clone())).collect(),
        excluded_subtrees: vec![],
    });
    let now = OffsetDateTime::now_utc();
    p.not_before = now - TimeDuration::hours(1);
    p.not_after = now + TimeDuration::hours(6);
    let cert = p.self_signed(&key)?;
    Ok(Round { issuer: Issuer::new(p, key), ca_der: cert.der().clone(), sites: sites.to_vec(), leaves: HashMap::new() })
}

fn leaf(r: &mut Round, host: &str) -> Option<Arc<CertifiedKey>> {
    if let Some(k) = r.leaves.get(host) {
        return Some(k.clone());
    }
    if !crate::divert::matches(host, &r.sites) {
        return None; // never vouch for anything that isn't blocked
    }
    let key = KeyPair::generate().ok()?;
    let mut p = CertificateParams::new(vec![host.to_string()]).ok()?;
    p.distinguished_name.push(DnType::CommonName, host);
    let now = OffsetDateTime::now_utc();
    p.not_before = now - TimeDuration::hours(1);
    p.not_after = now + TimeDuration::hours(6);
    let cert = p.signed_by(&key, &r.issuer).ok()?;
    let der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der()));
    let signer = provider().key_provider.load_private_key(der).ok()?;
    let ck = Arc::new(CertifiedKey::new(vec![cert.der().clone(), r.ca_der.clone()], signer));
    r.leaves.insert(host.to_string(), ck.clone());
    Some(ck)
}

#[derive(Debug)]
struct Resolver;

impl ResolvesServerCert for Resolver {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let host = hello.server_name()?.to_ascii_lowercase();
        let mut g = round().lock().unwrap();
        leaf(g.as_mut()?, &host)
    }
}

fn config() -> Arc<rustls::ServerConfig> {
    static C: OnceLock<Arc<rustls::ServerConfig>> = OnceLock::new();
    C.get_or_init(|| {
        let mut c = rustls::ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .expect("tls versions")
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(Resolver));
        c.alpn_protocols = vec![b"http/1.1".to_vec()];
        Arc::new(c)
    })
    .clone()
}

/// Starts a round's page: new authority, trusted by Windows until `end`.
pub fn start(sites: &[String]) -> bool {
    end();
    let r = match new_authority(sites) {
        Ok(r) => r,
        Err(e) => {
            log(&format!("page: could not make the round certificate: {e}"));
            return false;
        }
    };
    let ok = trust::add(&r.ca_der);
    *round().lock().unwrap() = Some(r);
    if !ok {
        log("page: could not add the round certificate to Windows; blocked sites show an error instead");
    }
    ok
}

/// Ends the round: the authority is forgotten and removed from Windows.
pub fn end() {
    *round().lock().unwrap() = None;
    trust::remove_all();
}

/// Serves the page to a browser that connected to the sinkhole over HTTPS.
pub fn serve_tls(stream: TcpStream, host: &str, seconds_left: u64) {
    if round().lock().unwrap().is_none() {
        return;
    }
    let conn = match rustls::ServerConnection::new(config()) {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut tls = rustls::StreamOwned::new(conn, stream);
    let mut buf = [0u8; 4096];
    // Read the request (the handshake happens inside this read), then answer whatever was asked.
    if tls.read(&mut buf).unwrap_or(0) == 0 {
        return;
    }
    let _ = tls.write_all(&response(host, seconds_left));
    let _ = tls.flush();
    tls.conn.send_close_notify();
    let _ = tls.flush();
}

/// The HTTP response carrying the page.
pub fn response(host: &str, seconds_left: u64) -> Vec<u8> {
    let body = html(host, seconds_left);
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    )
    .into_bytes()
}

fn site_label(host: &str) -> String {
    let h = host.strip_prefix("www.").or_else(|| host.strip_prefix("m.")).unwrap_or(host);
    h.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-').collect()
}

/// Warm paper, ink type, one clear message. The countdown is real: it's the round's time left.
pub fn html(host: &str, seconds_left: u64) -> String {
    let site = site_label(host);
    let mins = seconds_left.div_ceil(60);
    let when = if seconds_left == 0 {
        "Your round is ending now.".to_string()
    } else if mins == 1 {
        "Back in under a minute.".to_string()
    } else {
        format!("Back in {mins} minutes.")
    };
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>This can wait · Lock In</title>
<style>
:root{{--paper:#f3ead8;--ink:#2c3a2a;--muted:#6b705f;--moss:#4f6b3a;--line:#ddd2bb;color-scheme:light}}
@media (prefers-color-scheme:dark){{:root{{--paper:#1b211a;--ink:#ece4d2;--muted:#a9a693;--moss:#9cbb7a;--line:#36402f;color-scheme:dark}}}}
*{{box-sizing:border-box}}
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:17px/1.55 "Segoe UI",system-ui,sans-serif;padding:24px}}
main{{max-width:30rem;text-align:center}}
.mark{{display:inline-block;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--moss);margin-bottom:28px}}
h1{{font:600 clamp(40px,8vw,64px)/1.05 Georgia,"Times New Roman",serif;margin:0 0 18px;letter-spacing:-.01em}}
p{{margin:0 0 8px;color:var(--muted)}}
.site{{color:var(--ink);font-weight:600}}
.when{{margin-top:28px;padding-top:18px;border-top:1px solid var(--line);color:var(--ink);font-variant-numeric:tabular-nums}}
</style></head><body><main>
<span class="mark">Lock In</span>
<h1>This can wait.</h1>
<p><span class="site">{site}</span> is off until your round ends.</p>
<p>Close this tab and pick up where you left off.</p>
<p class="when" id="when" data-left="{seconds_left}">{when}</p>
</main>
<script>
(function(){{var el=document.getElementById("when"),end=Date.now()+Number(el.dataset.left)*1000;
function tick(){{var s=Math.max(0,Math.round((end-Date.now())/1000));
el.textContent=s===0?"Your round is over. Refresh to carry on.":s<60?"Back in under a minute.":"Back in "+Math.ceil(s/60)+" minutes.";
if(s>0)setTimeout(tick,1000)}}tick()}})();
</script></body></html>"#
    )
}

// ---------- Windows trusted list ----------

#[cfg(windows)]
mod trust {
    use super::CA_NAME;
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn certutil(args: &[&str]) -> bool {
        std::process::Command::new("certutil")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    pub fn add(der: &[u8]) -> bool {
        // Only the public certificate is written, and only for as long as certutil needs it.
        let path = std::env::temp_dir().join(format!("lockin-round-{}.cer", std::process::id()));
        if std::fs::write(&path, der).is_err() {
            return false;
        }
        let ok = certutil(&["-f", "-addstore", "Root", &path.to_string_lossy()]);
        let _ = std::fs::remove_file(&path);
        ok
    }

    pub fn remove_all() {
        // Removes this round's authority and any left behind by a crash.
        for _ in 0..5 {
            if !certutil(&["-delstore", "Root", CA_NAME]) {
                break;
            }
        }
    }
}

#[cfg(not(windows))]
mod trust {
    pub fn add(_: &[u8]) -> bool {
        true
    }
    pub fn remove_all() {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn page_says_the_site_and_time() {
        let h = html("www.youtube.com", 18 * 60);
        assert!(h.contains("This can wait.") && h.contains("youtube.com") && h.contains("Back in 18 minutes."));
        assert!(!html("<script>x</script>.com", 5).contains("<script>x"));
    }

    #[test]
    fn serves_the_page_over_https_and_only_for_blocked_sites() {
        let sites = vec!["youtube.com".to_string()];
        let r = new_authority(&sites).unwrap();
        let ca = r.ca_der.clone();
        *round().lock().unwrap() = Some(r);
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            for s in l.incoming().take(2).flatten() {
                serve_tls(s, "www.youtube.com", 600);
            }
        });
        let mut roots = rustls::RootCertStore::empty();
        roots.add(ca).unwrap();
        let client = Arc::new(
            rustls::ClientConfig::builder_with_provider(provider())
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        let get = |name: &'static str| -> std::io::Result<String> {
            let conn = rustls::ClientConnection::new(client.clone(), name.try_into().unwrap()).unwrap();
            let mut s = rustls::StreamOwned::new(conn, TcpStream::connect(addr)?);
            s.write_all(format!("GET / HTTP/1.1\r\nHost: {name}\r\n\r\n").as_bytes())?;
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            Ok(out)
        };
        let page = get("www.youtube.com").unwrap();
        assert!(page.contains("This can wait."), "got: {page}");
        // A site that isn't blocked gets no certificate at all.
        assert!(!get("en.wikipedia.org").unwrap_or_default().contains("This can wait."));
    }
}
