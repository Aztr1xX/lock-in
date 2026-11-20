//! Works out which site a blocked connection was for, so the app can say "Reddit is blocked".
//! HTTPS: the site name sits in plain text in the first TLS message (the SNI field).
//! HTTP: it's the Host header.

pub fn server_name(d: &[u8]) -> Option<String> {
    // TLS record: type 22 (handshake), then a ClientHello (type 1).
    if d.len() < 43 || d[0] != 0x16 || d[5] != 0x01 {
        return None;
    }
    let mut i = 5 + 4 + 2 + 32; // handshake header, client version, random
    let sid = *d.get(i)? as usize;
    i += 1 + sid;
    let suites = u16::from_be_bytes([*d.get(i)?, *d.get(i + 1)?]) as usize;
    i += 2 + suites;
    let comp = *d.get(i)? as usize;
    i += 1 + comp;
    let ext_len = u16::from_be_bytes([*d.get(i)?, *d.get(i + 1)?]) as usize;
    i += 2;
    let end = (i + ext_len).min(d.len());
    while i + 4 <= end {
        let ty = u16::from_be_bytes([d[i], d[i + 1]]);
        let len = u16::from_be_bytes([d[i + 2], d[i + 3]]) as usize;
        i += 4;
        if ty == 0 {
            // server_name list: list length (2), name type (1) = 0, name length (2), name
            let name_len = u16::from_be_bytes([*d.get(i + 3)?, *d.get(i + 4)?]) as usize;
            let name = d.get(i + 5..i + 5 + name_len)?;
            return clean(std::str::from_utf8(name).ok()?);
        }
        i += len;
    }
    None
}

pub fn http_host(d: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(d).ok()?;
    text.lines()
        .find_map(|l| l.strip_prefix("Host:").or_else(|| l.strip_prefix("host:")))
        .and_then(|h| clean(h.trim().split(':').next()?))
}

fn clean(h: &str) -> Option<String> {
    let h = h.trim().trim_end_matches('.').to_lowercase();
    (!h.is_empty() && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')).then_some(h)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello(name: &str) -> Vec<u8> {
        let n = name.as_bytes();
        let mut sni = vec![0, 0]; // ext type
        let list_len = (n.len() + 3) as u16;
        sni.extend(((list_len + 2) as u16).to_be_bytes());
        sni.extend(list_len.to_be_bytes());
        sni.push(0);
        sni.extend((n.len() as u16).to_be_bytes());
        sni.extend(n);
        let mut body = vec![3, 3];
        body.extend([7u8; 32]);
        body.push(0); // session id
        body.extend([0, 2, 0x13, 0x01]); // one cipher suite
        body.extend([1, 0]); // compression
        body.extend((sni.len() as u16).to_be_bytes());
        body.extend(sni);
        let mut hs = vec![1, 0];
        hs.extend((body.len() as u16).to_be_bytes());
        hs.extend(body);
        let mut rec = vec![0x16, 3, 1];
        rec.extend((hs.len() as u16).to_be_bytes());
        rec.extend(hs);
        rec
    }

    #[test]
    fn reads_sni() {
        assert_eq!(server_name(&hello("www.Reddit.com")).as_deref(), Some("www.reddit.com"));
        assert_eq!(server_name(b"GET / HTTP/1.1"), None);
    }

    #[test]
    fn reads_host() {
        assert_eq!(http_host(b"GET / HTTP/1.1\r\nHost: x.com:80\r\n\r\n").as_deref(), Some("x.com"));
    }
}
