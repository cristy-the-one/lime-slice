//! Opt-in live mirror from the MCP server into this window.
//!
//! Off unless `LIME_BRIDGE` is `1`, `true`, or `yes`, and `LIME_BRIDGE_TOKEN`
//! is non-empty. The listener is `127.0.0.1` only (`LIME_BRIDGE_PORT`, default
//! 43119). Every request, including health, must send `Authorization: Bearer`.
//! A matching POST body is emitted as the `lime-bridge` event after any token
//! field is removed. This module does not start a process and does not open a
//! console window.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

const DEFAULT_PORT: u16 = 43119;
const MAX_HEADER: usize = 16 * 1024;
const MAX_BODY: usize = 1024 * 1024;

pub fn start(app: AppHandle) {
    if !flag_on("LIME_BRIDGE") {
        return;
    }
    let Some(token) = std::env::var("LIME_BRIDGE_TOKEN")
        .ok()
        .filter(|token| !token.is_empty())
    else {
        eprintln!("lime-slice: the live bridge stayed off because LIME_BRIDGE_TOKEN is empty.");
        return;
    };
    let port = std::env::var("LIME_BRIDGE_PORT")
        .ok()
        .and_then(|text| text.trim().parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(DEFAULT_PORT);
    let addr = listen_addr(port);
    let listener = match TcpListener::bind(addr) {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("lime-slice: the live bridge could not listen on {addr}: {err}");
            return;
        }
    };
    std::thread::spawn(move || serve(listener, token, app));
}

fn flag_on(name: &str) -> bool {
    matches!(
        std::env::var(name).ok().as_deref().map(str::trim),
        Some("1") | Some("true") | Some("yes")
    )
}

/// The only address the bridge binds. A host variable is not read.
pub fn listen_addr(port: u16) -> SocketAddr {
    SocketAddr::from((Ipv4Addr::LOCALHOST, port))
}

fn serve(listener: TcpListener, token: String, app: AppHandle) {
    for incoming in listener.incoming() {
        let Ok(mut stream) = incoming else {
            continue;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        match read_request(&mut stream) {
            Ok(request) => {
                let (status, event) = decide(&request, &token);
                let _ = write_status(&mut stream, status);
                if let Some(mut value) = event {
                    strip_secrets(&mut value);
                    let _ = app.emit("lime-bridge", value);
                }
            }
            Err(()) => {
                let _ = write_status(&mut stream, 400);
            }
        }
    }
}

struct Incoming {
    method: String,
    path: String,
    authorization: String,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<Incoming, ()> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    let header_at = loop {
        if buf.len() > MAX_HEADER {
            return Err(());
        }
        let read = stream.read(&mut tmp).map_err(|_| ())?;
        if read == 0 {
            return Err(());
        }
        buf.extend_from_slice(&tmp[..read]);
        if let Some(at) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
            break at;
        }
    };
    let header = std::str::from_utf8(&buf[..header_at]).map_err(|_| ())?;
    let mut lines = header.split("\r\n");
    let request_line = lines.next().ok_or(())?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or(())?.to_string();
    let path = parts.next().ok_or(())?.to_string();
    let mut authorization = String::new();
    let mut length = 0usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("authorization") {
            authorization = value.trim().to_string();
        } else if name.eq_ignore_ascii_case("content-length") {
            length = value.trim().parse().map_err(|_| ())?;
        }
    }
    if length > MAX_BODY {
        return Err(());
    }
    let mut body = buf[header_at + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut tmp).map_err(|_| ())?;
        if read == 0 {
            return Err(());
        }
        body.extend_from_slice(&tmp[..read]);
    }
    body.truncate(length);
    Ok(Incoming {
        method,
        path,
        authorization,
        body,
    })
}

fn decide(request: &Incoming, token: &str) -> (u16, Option<Value>) {
    if !tokens_match(bearer(&request.authorization), token) {
        return (401, None);
    }
    let path = request.path.split('?').next().unwrap_or("");
    if path == "/health" || request.method.eq_ignore_ascii_case("GET") {
        return (200, None);
    }
    if !request.method.eq_ignore_ascii_case("POST") {
        return (405, None);
    }
    match serde_json::from_slice::<Value>(&request.body) {
        Ok(Value::Object(map)) => (204, Some(Value::Object(map))),
        _ => (400, None),
    }
}

fn bearer(header: &str) -> &str {
    let rest = header.trim();
    let prefix = "bearer ";
    if rest.len() >= prefix.len() && rest[..prefix.len()].eq_ignore_ascii_case(prefix) {
        rest[prefix.len()..].trim()
    } else {
        ""
    }
}

/// Compare without returning early, so a mismatch does not reveal the token length by timing.
fn tokens_match(given: &str, expected: &str) -> bool {
    let given = given.as_bytes();
    let expected = expected.as_bytes();
    let mut diff = given.len() ^ expected.len();
    let len = given.len().max(expected.len());
    for index in 0..len {
        let left = given.get(index).copied().unwrap_or(0);
        let right = expected.get(index).copied().unwrap_or(0);
        diff |= usize::from(left ^ right);
    }
    diff == 0
}

fn strip_secrets(value: &mut Value) {
    let Some(map) = value.as_object_mut() else {
        return;
    };
    map.remove("token");
    map.remove("authorization");
    map.remove("LIME_BRIDGE_TOKEN");
}

fn write_status(stream: &mut TcpStream, status: u16) -> std::io::Result<()> {
    let (code, body) = match status {
        200 => ("200 OK", "ok"),
        204 => ("204 No Content", ""),
        401 => ("401 Unauthorized", ""),
        405 => ("405 Method Not Allowed", ""),
        _ => ("400 Bad Request", ""),
    };
    write!(
        stream,
        "HTTP/1.1 {code}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, path: &str, token: &str, body: &str) -> Incoming {
        Incoming {
            method: method.into(),
            path: path.into(),
            authorization: format!("Bearer {token}"),
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn the_bridge_binds_loopback_only() {
        let addr = listen_addr(43119);
        assert!(addr.ip().is_loopback());
        assert_eq!(addr.port(), 43119);
    }

    #[test]
    fn a_wrong_token_is_refused_and_a_post_is_kept() {
        assert!(tokens_match("abc", "abc"));
        assert!(!tokens_match("abc", "abcd"));
        assert!(!tokens_match("abc", "abd"));
        let denied = decide(&request("POST", "/", "nope", "{}"), "secret");
        assert_eq!(denied.0, 401);
        assert!(denied.1.is_none());
        let health = decide(&request("GET", "/health", "secret", ""), "secret");
        assert_eq!(health.0, 200);
        let (status, event) = decide(
            &request(
                "POST",
                "/",
                "secret",
                r#"{"tool":"object_place","token":"secret","ok":true}"#,
            ),
            "secret",
        );
        assert_eq!(status, 204);
        let mut value = event.expect("event");
        strip_secrets(&mut value);
        assert!(value.get("token").is_none());
        assert_eq!(value["tool"], "object_place");
    }
}
