//! Opt-in slice jobs. `POST /api/slice` stays synchronous. A job is the same
//! request, run on its own thread, with a watch the poll and event routes read.

use std::io::{self, Read};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use lime_slice_core::{slice_payload_watched, Job, PayloadError, Progress, Status, Watch};
use serde_json::json;
use tiny_http::{Header, Response, StatusCode};

use crate::{cors_origin, err_json, park_gcode, SLICE_CACHE};

/// What `GET /api/jobs/{id}/result` answers. A reply can be tens of MB, so
/// only the newest finished body is held, and only until it is read.
enum Outcome {
    Running,
    Ready(String),
    Read,
    /// A newer job's body replaced this one.
    Released,
    Failed(PayloadError),
}

impl Outcome {
    /// Hands a body over once. Later reads get `410`.
    fn take(&mut self) -> (u16, String) {
        match self {
            Outcome::Running => (409, err_json("running")),
            Outcome::Ready(body) => {
                let body = std::mem::take(body);
                *self = Outcome::Read;
                (200, body)
            }
            Outcome::Read => (410, err_json("result already read")),
            Outcome::Released => (410, err_json("result released")),
            Outcome::Failed(err) => (err.status(), err.json()),
        }
    }
}

struct Entry {
    id: String,
    watch: Watch,
    outcome: Outcome,
}

/// Newest first. Past eight, the oldest entry is dropped. The slice it named
/// keeps running until it stops.
static JOBS: Mutex<Vec<Entry>> = Mutex::new(Vec::new());

const KEPT: usize = 8;

fn jobs() -> MutexGuard<'static, Vec<Entry>> {
    JOBS.lock().unwrap_or_else(PoisonError::into_inner)
}

fn watch_of(id: &str) -> Option<Watch> {
    jobs()
        .iter()
        .find(|entry| entry.id == id)
        .map(|entry| entry.watch.clone())
}

/// Stores how job `id` ended. A body releases every other body still held.
fn settle(id: &str, result: Result<String, PayloadError>) {
    let mut jobs = jobs();
    let Some(index) = jobs.iter().position(|entry| entry.id == id) else {
        return;
    };
    jobs[index].outcome = match result {
        Ok(body) => {
            for entry in jobs.iter_mut() {
                if matches!(entry.outcome, Outcome::Ready(_)) {
                    entry.outcome = Outcome::Released;
                }
            }
            Outcome::Ready(body)
        }
        Err(err) => Outcome::Failed(err),
    };
}

#[cfg(test)]
pub fn held_bodies() -> usize {
    jobs()
        .iter()
        .filter(|entry| matches!(entry.outcome, Outcome::Ready(_)))
        .count()
}

fn progress_body(id: &str, progress: &Progress) -> String {
    json!({
        "id": id,
        "stage": progress.stage,
        "done": progress.done,
        "total": progress.total,
        "fraction": progress.fraction,
        "status": progress.status.as_str(),
    })
    .to_string()
}

pub enum JobReply {
    Json(u16, String),
    Events { id: String, watch: Watch },
}

fn json_reply(status: u16, body: String) -> JobReply {
    JobReply::Json(status, body)
}

pub fn route(method: &str, path: &str, body: &str) -> Option<JobReply> {
    if method == "POST" && path == "/api/jobs" {
        let (status, body) = start(body);
        return Some(json_reply(status, body));
    }
    let rest = path.strip_prefix("/api/jobs/")?;
    let (id, tail) = rest.split_once('/').unwrap_or((rest, ""));
    if id.is_empty() {
        return Some(json_reply(404, err_json("not found")));
    }
    let reply = if method == "GET" && tail.is_empty() {
        poll(id)
    } else if method == "GET" && tail == "events" {
        return Some(events(id));
    } else if method == "GET" && tail == "result" {
        result(id)
    } else if method == "POST" && tail == "cancel" {
        cancel(id)
    } else {
        (404, err_json("not found"))
    };
    Some(json_reply(reply.0, reply.1))
}

fn start(body: &str) -> (u16, String) {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed).to_string();
    let watch = Watch::new();
    {
        let mut jobs = jobs();
        jobs.insert(
            0,
            Entry {
                id: id.clone(),
                watch: watch.clone(),
                outcome: Outcome::Running,
            },
        );
        jobs.truncate(KEPT);
    }
    let body = body.to_string();
    let running = watch.clone();
    let job_id = id.clone();
    let spawned = std::thread::Builder::new()
        .name("slice-job".into())
        .spawn(move || {
            let result =
                slice_payload_watched(&body, SLICE_CACHE.get(), Job::start(), &running, park_gcode);
            let status = Status::of(&result);
            settle(&job_id, result);
            running.finish(status);
        });
    if spawned.is_err() {
        settle(&id, Err(PayloadError::Failed("could not start".into())));
        watch.finish(Status::Error);
    }
    (202, json!({ "id": id }).to_string())
}

fn poll(id: &str) -> (u16, String) {
    let Some(watch) = watch_of(id) else {
        return (404, err_json("not found"));
    };
    (200, progress_body(id, &watch.snapshot()))
}

fn result(id: &str) -> (u16, String) {
    let mut jobs = jobs();
    let Some(entry) = jobs.iter_mut().find(|entry| entry.id == id) else {
        return (404, err_json("not found"));
    };
    entry.outcome.take()
}

fn cancel(id: &str) -> (u16, String) {
    let Some(watch) = watch_of(id) else {
        return (404, err_json("not found"));
    };
    watch.cancel();
    (200, r#"{"ok":true}"#.into())
}

fn events(id: &str) -> JobReply {
    let Some(watch) = watch_of(id) else {
        return json_reply(404, err_json("not found"));
    };
    JobReply::Events {
        id: id.to_string(),
        watch,
    }
}

struct EventStream {
    id: String,
    watch: Watch,
    seq: u64,
    buf: Vec<u8>,
    pos: usize,
    finished: bool,
}

impl EventStream {
    fn new(id: String, watch: Watch) -> Self {
        Self {
            id,
            watch,
            seq: 0,
            buf: Vec::new(),
            pos: 0,
            finished: false,
        }
    }
}

impl Read for EventStream {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        if self.pos >= self.buf.len() {
            if self.finished {
                return Ok(0);
            }
            let (seq, progress) = self.watch.latest_after(self.seq, Instant::now());
            self.seq = seq;
            self.buf = format!("data: {}\n\n", progress_body(&self.id, &progress)).into_bytes();
            self.pos = 0;
            if progress.status != Status::Running {
                self.finished = true;
            }
        }
        let n = (self.buf.len() - self.pos).min(out.len());
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

pub fn respond_events(
    request: tiny_http::Request,
    id: String,
    watch: Watch,
    token_required: bool,
    origin: Option<&str>,
) {
    let _ = request.respond(events_response(id, watch, token_required, origin));
}

fn events_response(
    id: String,
    watch: Watch,
    token_required: bool,
    origin: Option<&str>,
) -> Response<EventStream> {
    let allow_origin = cors_origin(token_required, origin);
    let allow_headers = if token_required {
        "Content-Type, Authorization"
    } else {
        "Content-Type"
    };
    let mut headers = vec![
        header("Content-Type", "text/event-stream"),
        header("Cache-Control", "no-cache"),
        header("Access-Control-Allow-Origin", &allow_origin),
        header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        header("Access-Control-Allow-Headers", allow_headers),
    ];
    if token_required && allow_origin != "*" {
        headers.push(header("Vary", "Origin"));
    }
    Response::new(
        StatusCode(200),
        headers,
        EventStream::new(id, watch),
        None,
        None,
    )
    .with_chunked_threshold(0)
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("header")
}
