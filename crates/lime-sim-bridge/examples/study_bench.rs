//! Time one sliced study and report its peak memory.
//!
//! `cargo run -p lime-sim-bridge --release --example study_bench -- body.json [key=value ...]`
//!
//! The body is the JSON [`lime_sim_bridge::study_json`] reads, as the MCP
//! sends it. Each `key=value` replaces that key of the study, as JSON, e.g.
//! `checkResolution=false` or `memoryMb=8192`. Run one study per process:
//! the peak is the process's own.

use std::time::Instant;

use lime_sim_bridge::{sliced, study_value};
use lime_slice_core::{Job, SliceRequest, Watch};
use serde_json::{json, Value};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("a study body file");
    let mut body: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("the body reads"))
            .expect("the body is JSON");
    for pair in args {
        let (key, value) = pair.split_once('=').expect("key=value");
        let value: Value = serde_json::from_str(value).unwrap_or(Value::String(value.into()));
        body["study"][key] = value;
    }
    let text = body.to_string();

    let request: SliceRequest =
        serde_json::from_value(body["request"].clone()).expect("the request reads");
    let start = Instant::now();
    sliced(&request, Job::default(), &Watch::idle()).expect("the part slices");
    let slice_s = start.elapsed().as_secs_f64();

    let start = Instant::now();
    let reply = study_value(&text, Job::default(), &Watch::idle());
    let total_s = start.elapsed().as_secs_f64();
    let out = match reply {
        Ok(reply) => {
            let report = &reply["report"];
            json!({
                "ok": true,
                "sliceS": round(slice_s),
                "studyS": round(total_s - slice_s),
                "totalS": round(total_s),
                "peakMb": peak_mb().map(round),
                "trust": report["trust"],
                "resolutions": report["resolutions"],
                "margins": report["margins"].as_array().map(|m| m.iter().map(|m| json!([m["kind"], m["value"]])).collect::<Vec<_>>()),
                "notes": report["notes"],
            })
        }
        Err(reason) => json!({
            "ok": false,
            "reason": reason,
            "totalS": round(total_s),
            "peakMb": peak_mb().map(round),
        }),
    };
    println!("{out}");
}

fn round(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[cfg(windows)]
fn peak_mb() -> Option<f64> {
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(process: isize, counters: *mut Counters, cb: u32) -> i32;
    }
    let mut c = Counters {
        cb: std::mem::size_of::<Counters>() as u32,
        ..Default::default()
    };
    // SAFETY: the pseudo handle needs no closing, and `c` is the size it says.
    let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
    (ok != 0).then(|| c.peak_working_set_size as f64 / (1024.0 * 1024.0))
}

#[cfg(not(windows))]
fn peak_mb() -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    let kb: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb / 1024.0)
}
