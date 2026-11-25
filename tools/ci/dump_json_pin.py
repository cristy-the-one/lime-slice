#!/usr/bin/env python3
"""Dump lime_occt_tree JSON from commit 512f6e0a into <out>/<os>/.

Temporary. The OCCT CI jobs run this once so the per-OS pins can be committed.
It is not part of the final tree: the test compares bytes, it does not generate them.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

# Full SHA. `git fetch` treats a short id as a ref name and the remote rejects it.
PIN = "512f6e0ab10146696f574ef13201be1e9358748c"

DUMP_RS = r"""//! Untracked dump of lime_occt_tree at 512f6e0a. Written by tools/ci/dump_json_pin.py.

use std::ffi::{CStr, CString};

const CALLS: &[(&str, &str)] = &[
    (
        "open",
        r#"{"call":"open","key":"json-pin","box":[10.0,8.0,6.0],"chordMm":2.0}"#,
    ),
    (
        "apply",
        r#"{"call":"apply","key":"json-pin","parent":0,"node":1,"chordMm":2.0,"op":{"kind":"fillet","edges":[0],"size":1.0}}"#,
    ),
    (
        "probe",
        r#"{"call":"probe","key":"json-pin","node":1,"preview":true,"chordMm":2.0,"op":{"kind":"hole","origin":[5.0,4.0,6.0],"axis":[0.0,0.0,-1.0],"radius":1.0,"depth":6.0,"through":true}}"#,
    ),
    (
        "goto",
        r#"{"call":"goto","key":"json-pin","node":1,"chordMm":2.0}"#,
    ),
];

fn call_tree(request: &str) -> String {
    let req = CString::new(request).unwrap();
    let answer = unsafe { lime_model_occt::lime_occt_tree(req.as_ptr()) };
    let reply = unsafe { CStr::from_ptr(answer) }.to_string_lossy().into_owned();
    unsafe { lime_model_occt::lime_occt_string_free(answer) };
    reply
}

#[test]
fn dump_pre_853_json() {
    let dir = std::env::var("LIME_JSON_PIN_DIR").expect("LIME_JSON_PIN_DIR");
    std::fs::create_dir_all(&dir).unwrap();
    for (name, request) in CALLS {
        let reply = call_tree(request);
        assert!(
            serde_json::from_str::<serde_json::Value>(&reply)
                .ok()
                .is_some_and(|v| v.get("error").is_none()),
            "{name} failed: {}",
            &reply[..reply.len().min(500)]
        );
        let path = std::path::Path::new(&dir).join(format!("{name}.json"));
        std::fs::write(&path, reply.as_bytes()).unwrap();
        println!("{name} bytes={}", reply.len());
    }
}
"""


def os_name() -> str:
    system = platform.system()
    if system == "Linux":
        return "linux"
    if system == "Darwin":
        return "macos"
    if system == "Windows":
        return "windows"
    raise SystemExit(f"no JSON pin directory name for {system}")


def run(cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <output-dir>")
    out = Path(sys.argv[1]).resolve() / os_name()
    out.mkdir(parents=True, exist_ok=True)
    repo = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
    pin_dir = Path(os.environ.get("RUNNER_TEMP", repo.parent)) / "pin-512f6e0a"
    run(["git", "fetch", "--depth", "1", "origin", PIN], cwd=repo)
    fetched = subprocess.check_output(["git", "rev-parse", "FETCH_HEAD"], cwd=repo, text=True).strip()
    if not fetched.startswith(PIN):
        raise SystemExit(f"fetched {fetched}, wanted {PIN}")
    if pin_dir.exists():
        subprocess.run(["git", "worktree", "remove", "--force", str(pin_dir)], cwd=repo, check=False)
        shutil.rmtree(pin_dir, ignore_errors=True)
    run(["git", "worktree", "add", "--detach", str(pin_dir), "FETCH_HEAD"], cwd=repo)
    test_path = pin_dir / "crates" / "lime-model-occt" / "tests" / "dump_json_pin.rs"
    test_path.write_bytes(DUMP_RS.encode("utf-8"))
    env = os.environ.copy()
    occt = env.get("OCCT_ROOT", "")
    if not occt:
        raise SystemExit("OCCT_ROOT is not set")
    env["PATH"] = os.pathsep.join(
        [str(Path(occt) / "bin"), str(Path(occt) / "lib"), env.get("PATH", "")]
    )
    env["CARGO_TARGET_DIR"] = str(pin_dir / "target-pin")
    env["LIME_JSON_PIN_DIR"] = str(out)
    env["CARGO_INCREMENTAL"] = "0"
    try:
        run(
            [
                "cargo",
                "test",
                "-p",
                "lime-model-occt",
                "--test",
                "dump_json_pin",
                "--locked",
                "--",
                "--exact",
                "dump_pre_853_json",
                "--nocapture",
            ],
            cwd=pin_dir,
            env=env,
        )
    finally:
        shutil.rmtree(pin_dir / "target-pin", ignore_errors=True)
        subprocess.run(["git", "worktree", "remove", "--force", str(pin_dir)], cwd=repo, check=False)
        shutil.rmtree(pin_dir, ignore_errors=True)
    for name in ("open", "apply", "probe", "goto"):
        path = out / f"{name}.json"
        data = path.read_bytes()
        if not data or data.endswith(b"\n") or b"\n" in data:
            raise SystemExit(f"{path} is empty or not one line ({len(data)} bytes)")
        print(f"{os_name()} {name} {len(data)} bytes", flush=True)


if __name__ == "__main__":
    main()
