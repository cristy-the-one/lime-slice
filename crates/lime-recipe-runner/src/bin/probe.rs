//! A stand-in recipe for the runner's tests (tests/runner.rs). The first argument picks what it does:
//!
//! - `echo`: answers each stdin line with `{"echo": <line>}`, then exits 0 at the end of input;
//! - `sleep`: reads nothing and sleeps for a minute;
//! - `alloc <MB>`: touches that much memory, 8 MB at a time, then sleeps;
//! - `long <bytes>`: writes one line of that many bytes;
//! - `lines <n>`: writes `n` note lines;
//! - `calls <n>`: writes `n` call lines without waiting for replies;
//! - `env`: writes how many environment variables it got.

use std::io::{BufRead, Write};
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let n = |i: usize| args.get(i).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
    let mut out = std::io::stdout().lock();
    match args.first().map(String::as_str) {
        Some("echo") => {
            for line in std::io::stdin().lock().lines() {
                let line = line.unwrap_or_default();
                writeln!(out, "{}", serde_json::json!({ "echo": line })).unwrap();
                out.flush().unwrap();
            }
        }
        Some("sleep") => std::thread::sleep(Duration::from_secs(60)),
        Some("alloc") => {
            let mut kept: Vec<Vec<u8>> = Vec::new();
            for _ in 0..n(1).div_ceil(8) {
                kept.push(vec![1u8; 8 << 20]);
                std::thread::sleep(Duration::from_millis(5));
            }
            std::thread::sleep(Duration::from_secs(60));
            drop(kept);
        }
        Some("long") => {
            writeln!(out, "{}", "x".repeat(n(1))).unwrap();
            out.flush().unwrap();
            std::thread::sleep(Duration::from_secs(60));
        }
        Some("lines") => {
            for i in 0..n(1) {
                writeln!(out, "{}", serde_json::json!({ "note": format!("line {i}") })).unwrap();
            }
            out.flush().unwrap();
            std::thread::sleep(Duration::from_secs(60));
        }
        Some("calls") => {
            for i in 0..n(1) {
                writeln!(out, "{}", serde_json::json!({ "id": i + 1, "call": "model_describe", "args": {} })).unwrap();
            }
            out.flush().unwrap();
            std::thread::sleep(Duration::from_secs(60));
        }
        Some("env") => {
            writeln!(out, "{}", serde_json::json!({ "note": std::env::vars_os().count().to_string() })).unwrap();
        }
        _ => std::process::exit(2),
    }
}
