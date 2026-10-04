//! Desktop helper for Prusa Link.
//!
//! The webview's `fetch` is blocked when the printer does not send CORS headers.
//! This speaks HTTP/1.1 to the host stored on the printer profile. It only calls
//! `GET /api/version`, `GET /api/v1/status`, and `PUT /api/v1/files/local/<name>`.
//! `https://` stays on the page `fetch` path: printer certificates are not in this helper.
//! CI does not open a socket. The tests below only check request text and response parsing.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use url::Url;

const MAX_BODY: usize = 32 * 1024 * 1024;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(45);

#[derive(serde::Serialize)]
pub struct PrusaHttpReply {
    pub status: u16,
    pub text: String,
}

#[tauri::command]
pub async fn prusa_link_http(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<PrusaHttpReply, String> {
    let joined = tauri::async_runtime::spawn_blocking(move || {
        exchange(&url, &method, &headers, body.as_deref())
    })
    .await
    .map_err(|_| {
        "Could not reach Prusa Link. The printer may be off or not on this network.".to_string()
    })?;
    let (status, text) = joined?;
    Ok(PrusaHttpReply { status, text })
}

fn exchange(
    raw_url: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: Option<&str>,
) -> Result<(u16, String), String> {
    let url = Url::parse(raw_url).map_err(|_| bad_host())?;
    if url.scheme() != "http" {
        return Err("This desktop helper sends Prusa Link over http. Use an http:// host.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad_host());
    }
    let path = path_and_query(&url);
    if !allowed(&method.to_ascii_uppercase(), &path) {
        return Err("Prusa Link refused that request.".into());
    }
    if body.map(str::len).unwrap_or(0) > MAX_BODY {
        return Err("Prusa Link refused that G-code because it is too large to send.".into());
    }
    let host = url
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(bad_host)?;
    let port = url.port_or_known_default().unwrap_or(80);
    let request = request_bytes(&method.to_ascii_uppercase(), &url, &path, headers, body)?;
    let mut stream = TcpStream::connect((host, port)).map_err(|_| network_error(&url))?;
    stream
        .set_read_timeout(Some(TIMEOUT))
        .map_err(|_| network_error(&url))?;
    stream
        .set_write_timeout(Some(TIMEOUT))
        .map_err(|_| network_error(&url))?;
    stream
        .write_all(&request)
        .map_err(|_| network_error(&url))?;
    let bytes = read_message(&mut stream, &network_error(&url))?;
    parse_response(&bytes)
}

fn allowed(method: &str, path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    if path.contains("..") || path.contains('\\') {
        return false;
    }
    match method {
        "GET" => path == "/api/version" || path == "/api/v1/status",
        "PUT" => {
            let prefix = "/api/v1/files/local/";
            path.starts_with(prefix) && path.len() > prefix.len()
        }
        _ => false,
    }
}

fn request_bytes(
    method: &str,
    url: &Url,
    path: &str,
    headers: &HashMap<String, String>,
    body: Option<&str>,
) -> Result<Vec<u8>, String> {
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n",
        host_header(url)
    );
    for (name, value) in headers {
        if !allowed_header(name) {
            continue;
        }
        if name
            .bytes()
            .any(|byte| byte == b'\r' || byte == b'\n' || byte == b':')
            || value.bytes().any(|byte| byte == b'\r' || byte == b'\n')
        {
            return Err("Prusa Link refused that request.".into());
        }
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    let payload = if method == "PUT" {
        body.unwrap_or("")
    } else {
        ""
    };
    if method == "PUT" {
        head.push_str(&format!("Content-Length: {}\r\n", payload.len()));
    }
    head.push_str("\r\n");
    let mut bytes = head.into_bytes();
    bytes.extend_from_slice(payload.as_bytes());
    Ok(bytes)
}

fn allowed_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "x-api-key" | "content-type" | "overwrite" | "print-after-upload"
    )
}

fn host_header(url: &Url) -> String {
    let host = match url.host() {
        Some(url::Host::Ipv6(ip)) => format!("[{ip}]"),
        _ => url.host_str().unwrap_or("").to_string(),
    };
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    }
}

fn path_and_query(url: &Url) -> String {
    match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    }
}

fn read_message(stream: &mut TcpStream, network: &str) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.len() > MAX_RESPONSE + 65_536 {
                    return Err("Prusa Link sent a response that was too large.".into());
                }
                if message_complete(&buf) {
                    break;
                }
            }
            Err(err)
                if err.kind() == ErrorKind::TimedOut || err.kind() == ErrorKind::WouldBlock =>
            {
                if message_complete(&buf) {
                    break;
                }
                return Err(network.to_string());
            }
            Err(_) => return Err(network.to_string()),
        }
    }
    if buf.is_empty() {
        return Err(network.to_string());
    }
    Ok(buf)
}

fn message_complete(buf: &[u8]) -> bool {
    let Some(header_end) = find_double_crlf(buf) else {
        return false;
    };
    let header = String::from_utf8_lossy(&buf[..header_end]);
    let body = &buf[header_end + 4..];
    let mut chunked = false;
    let mut length = None;
    for line in header.split("\r\n").skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
        {
            chunked = true;
        }
        if name.eq_ignore_ascii_case("content-length") {
            length = value.trim().parse().ok();
        }
    }
    if chunked {
        return decode_chunked(body).is_ok();
    }
    length.is_some_and(|len| body.len() >= len)
}

fn parse_response(bytes: &[u8]) -> Result<(u16, String), String> {
    let header_end = find_double_crlf(bytes)
        .ok_or_else(|| "Prusa Link did not return a complete response.".to_string())?;
    let header = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| "Prusa Link did not return a complete response.".to_string())?;
    let mut lines = header.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| "Prusa Link did not return a complete response.".to_string())?;
    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value.trim().parse().ok();
        }
        if name.eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
        {
            chunked = true;
        }
    }
    let body = &bytes[header_end + 4..];
    let raw = if chunked {
        decode_chunked(body)?
    } else if let Some(len) = content_length {
        if body.len() < len {
            return Err("Prusa Link did not return a complete response.".into());
        }
        body[..len].to_vec()
    } else {
        body.to_vec()
    };
    if raw.len() > MAX_RESPONSE {
        return Err("Prusa Link sent a response that was too large.".into());
    }
    Ok((status, String::from_utf8_lossy(&raw).into_owned()))
}

fn decode_chunked(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut rest = input;
    loop {
        let line_end = find_crlf(rest)
            .ok_or_else(|| "Prusa Link did not return a complete response.".to_string())?;
        let line = std::str::from_utf8(&rest[..line_end])
            .map_err(|_| "Prusa Link did not return a complete response.".to_string())?;
        let size_hex = line
            .split_once(';')
            .map(|(size, _rest)| size)
            .unwrap_or(line)
            .trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|_| "Prusa Link did not return a complete response.".to_string())?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if rest.len() < size + 2 || &rest[size..size + 2] != b"\r\n" {
            return Err("Prusa Link did not return a complete response.".into());
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
        if out.len() > MAX_RESPONSE {
            return Err("Prusa Link sent a response that was too large.".into());
        }
    }
}

fn find_crlf(bytes: &[u8]) -> Option<usize> {
    bytes.windows(2).position(|pair| pair == b"\r\n")
}

fn find_double_crlf(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn bad_host() -> String {
    "That host is not a Prusa Link URL. Use http:// or https:// and a host name.".into()
}

fn network_error(url: &Url) -> String {
    format!(
        "Could not reach Prusa Link at {}. The printer may be off or not on this network.",
        url.origin().ascii_serialization()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn upload_request_targets_the_files_route() {
        let url = Url::parse("http://printer.local/api/v1/files/local/part.gcode").unwrap();
        let bytes = request_bytes(
            "PUT",
            &url,
            "/api/v1/files/local/part.gcode",
            &headers(&[
                ("X-Api-Key", "secret"),
                ("Content-Type", "text/x.gcode"),
                ("Overwrite", "?1"),
                ("Print-After-Upload", "?1"),
                ("Host", "evil"),
            ]),
            Some("G1 X1\n"),
        )
        .unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with("PUT /api/v1/files/local/part.gcode HTTP/1.1\r\n"));
        assert!(text.contains("Host: printer.local\r\n"));
        assert!(text.contains("X-Api-Key: secret\r\n"));
        assert!(text.contains("Print-After-Upload: ?1\r\n"));
        assert!(text.contains("Overwrite: ?1\r\n"));
        assert!(text.contains("Content-Length: 6\r\n"));
        assert!(!text.contains("evil"));
        assert!(text.ends_with("\r\n\r\nG1 X1\n"));
    }

    #[test]
    fn a_non_api_path_and_https_are_refused_before_a_connection() {
        let err = exchange("http://printer.local/admin", "GET", &HashMap::new(), None).unwrap_err();
        assert!(err.contains("Prusa Link"));
        let https = exchange(
            "https://printer.local/api/version",
            "GET",
            &HashMap::new(),
            None,
        )
        .unwrap_err();
        assert!(https.contains("http://"));
        let bare = exchange("printer.local", "GET", &HashMap::new(), None).unwrap_err();
        assert!(bare.contains("host"));
    }

    #[test]
    fn reads_a_created_response_and_chunked_json() {
        let (status, text) = parse_response(
            b"HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .unwrap();
        assert_eq!(status, 201);
        assert_eq!(text, "");
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n";
        let (status, text) = parse_response(raw).unwrap();
        assert_eq!(status, 200);
        assert_eq!(text, "hello");
    }
}
