// OpenSpades Helper: a WebSocket-to-UDP relay on the player's own computer. GPL-3.0-or-later.
//
// Browsers cannot send UDP, so the web client normally reaches game servers through a relay in a
// data centre, and some servers (e.g. aloha.pk) ban data-centre addresses. With this helper running,
// the page sends each ENet datagram as one binary WebSocket message to
// ws://127.0.0.1:32880/relay?host=<ip or name>&port=<port> and the game traffic leaves from the
// player's own connection, like the desktop game. Same protocol as browser/relay.mjs.
//
//   GET /health   {"helper":"openspades","version":1} with CORS for the allowed origins (page detection)
//   GET /relay    WebSocket; one binary message = one UDP datagram, both ways
//
// Only pages from the allowed origins may use it (any web page can reach 127.0.0.1): the origins
// built in through OSHELPER_ORIGINS at compile time (comma-separated) plus local test pages on
// http://127.0.0.1 and http://localhost. Only public IPv4 addresses are relayed.
use std::collections::HashMap;
use std::io::{self, BufRead, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const PORT: u16 = 32880;
const VERSION: u32 = 1;
const IDLE: Duration = Duration::from_secs(60);
const MAX_CONNECTIONS: usize = 64;
const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

static ACTIVE: AtomicUsize = AtomicUsize::new(0);

fn main() {
    println!("OpenSpades Helper {VERSION}");
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, PORT)) {
        Ok(l) => l,
        Err(e) => {
            if health_check() {
                println!("The helper is already running. You can close this window.");
            } else {
                println!("Could not listen on 127.0.0.1:{PORT}: {e}");
            }
            pause();
            return;
        }
    };
    if cfg!(windows) {
        println!("Running. Keep this window open while you play, then close it when you are done.");
    } else {
        println!("Running. Keep this window open while you play, then press Ctrl+C or close it when you are done.");
    }
    println!("Allowed pages: {}", allowed_list().join(", "));
    for stream in listener.incoming().flatten() {
        if ACTIVE.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
            continue;
        }
        thread::spawn(move || {
            ACTIVE.fetch_add(1, Ordering::SeqCst);
            let _ = handle(stream);
            ACTIVE.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

fn pause() {
    println!("Press Enter to close.");
    let _ = io::stdin().lock().read_line(&mut String::new());
}

fn health_check() -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, PORT)), Duration::from_secs(1)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = s.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out.contains("\"helper\":\"openspades\"")
}

fn allowed_list() -> Vec<String> {
    let mut list: Vec<String> = option_env!("OSHELPER_ORIGINS").unwrap_or("")
        .split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    list.push("http://127.0.0.1:*".into());
    list.push("http://localhost:*".into());
    list
}

fn origin_allowed(origin: &str) -> bool {
    if allowed_list().iter().any(|o| o == origin) {
        return true;
    }
    for local in ["http://127.0.0.1", "http://localhost"] {
        if let Some(rest) = origin.strip_prefix(local) {
            if rest.is_empty() || (rest.starts_with(':') && rest[1..].chars().all(|c| c.is_ascii_digit())) {
                return true;
            }
        }
    }
    false
}

struct Request {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
}

fn read_request(stream: &mut TcpStream) -> io::Result<Request> {
    let mut data = Vec::new();
    let mut byte = [0u8; 1];
    while !data.ends_with(b"\r\n\r\n") {
        if data.len() > 8192 || stream.read(&mut byte)? == 0 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        data.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&data);
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let method = first.next().unwrap_or("").to_string();
    let target = first.next().unwrap_or("");
    let (path, query_text) = target.split_once('?').unwrap_or((target, ""));
    let query = query_text.split('&').filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let headers = lines.filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    Ok(Request { method, path: path.to_string(), query, headers })
}

fn respond(stream: &mut TcpStream, status: &str, extra: &str, body: &str) -> io::Result<()> {
    write!(stream, "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}

fn handle(mut stream: TcpStream) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let req = read_request(&mut stream)?;
    let origin = req.headers.get("origin").cloned().unwrap_or_default();
    let allowed = origin_allowed(&origin);
    // CORS for the page's detection request; Chrome's local network access checks want the
    // private-network header on loopback answers to public pages.
    let cors = if allowed {
        format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\nAccess-Control-Allow-Private-Network: true\r\n\
                 Access-Control-Allow-Methods: GET\r\nCross-Origin-Resource-Policy: cross-origin\r\n")
    } else {
        String::new()
    };
    match (req.method.as_str(), req.path.as_str()) {
        ("OPTIONS", _) => respond(&mut stream, "204 No Content", &cors, ""),
        ("GET", "/health") => respond(&mut stream, "200 OK", &format!("{cors}Content-Type: application/json\r\nCache-Control: no-store\r\n"),
            &format!("{{\"helper\":\"openspades\",\"version\":{VERSION}}}")),
        ("GET", "/relay") => {
            if !allowed {
                return respond(&mut stream, "403 Forbidden", "", "");
            }
            let host = req.query.get("host").cloned().unwrap_or_default();
            let port: u16 = req.query.get("port").and_then(|p| p.parse().ok()).unwrap_or(0);
            let key = req.headers.get("sec-websocket-key").cloned().unwrap_or_default();
            let upgrade = req.headers.get("upgrade").map(|u| u.eq_ignore_ascii_case("websocket")).unwrap_or(false);
            if key.is_empty() || !upgrade || host.is_empty() || host.len() > 253 || port == 0
                || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
                return respond(&mut stream, "400 Bad Request", "", "");
            }
            let accept = base64(&sha1(format!("{key}{GUID}").as_bytes()));
            write!(stream, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n")?;
            stream.set_nodelay(true)?;
            relay(stream, &host, port)
        }
        _ => respond(&mut stream, "404 Not Found", "", ""),
    }
}

fn is_public(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(a == 0 || a == 10 || a == 127 || a >= 224 || (a == 100 && (64..128).contains(&b)) || (a == 169 && b == 254)
        || (a == 172 && (16..32).contains(&b)) || (a == 192 && b == 168) || (a == 198 && (b == 18 || b == 19)))
}

fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0x80 | opcode];
    let n = payload.len();
    if n < 126 {
        out.push(n as u8);
    } else if n < 65536 {
        out.push(126);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        out.push(127);
        out.extend_from_slice(&(n as u64).to_be_bytes());
    }
    out.extend_from_slice(payload);
    out
}

fn relay(stream: TcpStream, host: &str, port: u16) -> io::Result<()> {
    let writer = Arc::new(Mutex::new(stream.try_clone()?));
    let close = |code: u16| {
        let _ = writer.lock().unwrap().write_all(&frame(0x8, &code.to_be_bytes()));
    };
    let target = (host, port).to_socket_addrs().ok()
        .and_then(|mut a| a.find_map(|a| match a.ip() { IpAddr::V4(v4) => Some(SocketAddr::from((v4, port))), _ => None }));
    let Some(target) = target else { close(1011); return Ok(()); };
    let IpAddr::V4(ip) = target.ip() else { unreachable!() };
    if !is_public(ip) {
        close(1008);
        return Ok(());
    }
    let udp = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
    udp.connect(target)?;
    udp.set_read_timeout(Some(Duration::from_millis(500)))?;
    let closed = Arc::new(AtomicBool::new(false));
    let last = Arc::new(Mutex::new(Instant::now()));

    // UDP -> WebSocket
    let (udp_in, w, done, seen) = (udp.try_clone()?, writer.clone(), closed.clone(), last.clone());
    let receiver = thread::spawn(move || {
        let mut buf = [0u8; 65536];
        while !done.load(Ordering::SeqCst) {
            match udp_in.recv(&mut buf) {
                Ok(n) => {
                    *seen.lock().unwrap() = Instant::now();
                    if w.lock().unwrap().write_all(&frame(0x2, &buf[..n])).is_err() { break; }
                }
                Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
                    if seen.lock().unwrap().elapsed() > IDLE { break; }
                }
                Err(_) => {} // e.g. ICMP port unreachable on Windows: keep going, like UDP
            }
        }
        done.store(true, Ordering::SeqCst);
        let _ = w.lock().unwrap().shutdown(std::net::Shutdown::Both);
    });

    // WebSocket -> UDP
    let mut reader = io::BufReader::new(stream);
    reader.get_ref().set_read_timeout(Some(IDLE))?;
    let mut fragments = Vec::new();
    let result = (|| -> io::Result<()> {
        loop {
            let mut head = [0u8; 2];
            reader.read_exact(&mut head)?;
            let (fin, opcode, masked) = (head[0] & 0x80 != 0, head[0] & 0x0f, head[1] & 0x80 != 0);
            let mut len = (head[1] & 0x7f) as u64;
            if len == 126 {
                let mut b = [0u8; 2]; reader.read_exact(&mut b)?; len = u16::from_be_bytes(b) as u64;
            } else if len == 127 {
                let mut b = [0u8; 8]; reader.read_exact(&mut b)?; len = u64::from_be_bytes(b);
            }
            if !masked || len > 1 << 20 {
                close(1002);
                return Ok(());
            }
            let mut mask = [0u8; 4];
            reader.read_exact(&mut mask)?;
            let mut payload = vec![0u8; len as usize];
            reader.read_exact(&mut payload)?;
            for (i, b) in payload.iter_mut().enumerate() { *b ^= mask[i & 3]; }
            match opcode {
                0x8 => { close(1000); return Ok(()); }
                0x9 => { writer.lock().unwrap().write_all(&frame(0xA, &payload))?; continue; }
                0xA => continue,
                _ => {}
            }
            fragments.extend_from_slice(&payload);
            if !fin { continue; }
            *last.lock().unwrap() = Instant::now();
            let _ = udp.send(&fragments);
            fragments.clear();
        }
    })();
    closed.store(true, Ordering::SeqCst);
    let _ = receiver.join();
    result
}

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 { msg.push(0); }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 { w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]); }
        for i in 16..80 { w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1); }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d; d = c; c = b.rotate_left(30); b = a; a = t;
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) { *x = x.wrapping_add(y); }
    }
    let mut out = [0u8; 20];
    for (i, x) in h.iter().enumerate() { out[4 * i..4 * i + 4].copy_from_slice(&x.to_be_bytes()); }
    out
}

fn base64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn websocket_accept() {
        // RFC 6455 example
        assert_eq!(base64(&sha1(format!("dGhlIHNhbXBsZSBub25jZQ=={GUID}").as_bytes())), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }
    #[test]
    fn origins() {
        assert!(origin_allowed("http://127.0.0.1:8080"));
        assert!(!origin_allowed("http://127.0.0.1.evil.com"));
        assert!(!origin_allowed("https://example.com"));
    }
}
