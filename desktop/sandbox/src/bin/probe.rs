//! Test program for the sandbox (CI only): tries what the camera worker must never be able to
//! do and prints what happened as JSON.
use std::io::Read;
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

fn main() {
    let target = std::env::args().nth(1).unwrap_or_default();
    let net = |addr: &str| {
        let a: SocketAddr = addr.parse().unwrap();
        TcpStream::connect_timeout(&a, Duration::from_secs(4)).map(|_| "connected".to_string()).unwrap_or_else(|e| e.to_string())
    };
    let read_file = |p: &str| {
        let mut s = String::new();
        std::fs::File::open(p).and_then(|mut f| f.read_to_string(&mut s)).map(|_| "read".to_string()).unwrap_or_else(|e| e.to_string())
    };
    let dns = std::net::ToSocketAddrs::to_socket_addrs(&("example.com", 443)).map(|_| "resolved".to_string()).unwrap_or_else(|e| e.to_string());
    println!(
        "{}",
        serde_json::json!({
            "internet": net("1.1.1.1:443"),
            "local": net("127.0.0.1:47822"),
            "dns": dns,
            "personal_file": read_file(&target),
            "own_folder": std::fs::read_dir(std::env::current_exe().unwrap().parent().unwrap()).map(|_| "listed".to_string()).unwrap_or_else(|e| e.to_string()),
        })
    );
}
