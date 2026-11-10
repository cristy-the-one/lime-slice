//! The runner against a stand-in recipe (src/bin/probe.rs) and, where lust is installed, a real recipe that only logs.
//! The real-lust test skips without lust (LIME_LUST, or lust on PATH); LIME_RECIPE_REQUIRED=1 makes that a failure.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use lime_recipe_runner::{
    build, calls_sentence, find_lust, line_bytes_sentence, lines_sentence, lust_features, memory_sentence, timeout_sentence,
    Limits, RecipeRun, RunEvent, RunExit, MARK_UNREAD_FN,
};

fn probe() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_lime-recipe-probe"))
}

fn start(args: &[&str], limits: Limits) -> (RecipeRun, Receiver<RunEvent>) {
    let (tx, rx) = channel();
    let run = RecipeRun::start(probe(), args, &std::env::temp_dir(), limits, move |event| {
        let _ = tx.send(event);
    })
    .expect("the probe starts");
    (run, rx)
}

/// Every event until the exit, within `within`.
fn until_exit(rx: &Receiver<RunEvent>, within: Duration) -> (Vec<String>, RunExit) {
    let deadline = Instant::now() + within;
    let mut lines = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left).expect("the run ends in time") {
            RunEvent::Line(line) => lines.push(line),
            RunEvent::Exit(exit) => return (lines, exit),
        }
    }
}

fn small(timeout: Duration) -> Limits {
    Limits { memory_bytes: 64 << 20, ..Limits::for_calls(timeout, 20, 4096) }
}

#[test]
fn lines_go_out_and_replies_come_back() {
    let (run, rx) = start(&["echo"], small(Duration::from_secs(10)));
    run.send(r#"{"v":1}"#).unwrap();
    run.send(r#"{"id":1,"ok":true}"#).unwrap();
    run.close_input();
    let (lines, exit) = until_exit(&rx, Duration::from_secs(10));
    assert_eq!(lines, vec![r#"{"echo":"{\"v\":1}"}"#.to_string(), r#"{"echo":"{\"id\":1,\"ok\":true}"}"#.to_string()]);
    assert_eq!(exit.code, Some(0));
    assert_eq!(exit.reason, None);
}

#[test]
fn the_recipe_gets_an_empty_environment() {
    let (_run, rx) = start(&["env"], small(Duration::from_secs(10)));
    let (lines, _) = until_exit(&rx, Duration::from_secs(10));
    let expected = if cfg!(windows) { 1 } else { 0 };
    assert_eq!(lines, vec![format!(r#"{{"note":"{expected}"}}"#)]);
}

#[test]
fn a_recipe_past_its_time_is_stopped() {
    let started = Instant::now();
    let (_run, rx) = start(&["sleep"], small(Duration::from_millis(300)));
    let (_, exit) = until_exit(&rx, Duration::from_secs(10));
    assert_eq!(exit.reason.as_deref(), Some(timeout_sentence(Duration::from_millis(300)).as_str()));
    assert_ne!(exit.code, Some(0));
    assert!(started.elapsed() < Duration::from_secs(5), "stopped after {:?}", started.elapsed());
}

#[test]
fn a_recipe_past_its_memory_cap_is_stopped() {
    let (_run, rx) = start(&["alloc", "512"], small(Duration::from_secs(20)));
    let (_, exit) = until_exit(&rx, Duration::from_secs(20));
    assert_eq!(exit.reason.as_deref(), Some(memory_sentence(64 << 20).as_str()), "{exit:?}");
    assert_eq!(memory_sentence(64 << 20), "The recipe used more than 64 MB of memory and was stopped.");
}

#[test]
fn dropping_the_run_kills_the_recipe() {
    let started = Instant::now();
    let (run, rx) = start(&["sleep"], small(Duration::from_secs(60)));
    std::thread::sleep(Duration::from_millis(100));
    drop(run);
    let (_, exit) = until_exit(&rx, Duration::from_secs(10));
    assert_eq!(exit.reason, None);
    assert_ne!(exit.code, Some(0));
    assert!(started.elapsed() < Duration::from_secs(5), "killed after {:?}", started.elapsed());
}

#[test]
fn a_line_past_its_limit_is_stopped() {
    let (_run, rx) = start(&["long", "10000"], small(Duration::from_secs(10)));
    let (lines, exit) = until_exit(&rx, Duration::from_secs(10));
    assert!(lines.is_empty());
    assert_eq!(exit.reason.as_deref(), Some(line_bytes_sentence(4096).as_str()));
}

#[test]
fn too_many_lines_or_calls_are_stopped() {
    let limits = Limits { max_lines: 30, ..small(Duration::from_secs(10)) };
    let (_run, rx) = start(&["lines", "100"], limits.clone());
    let (lines, exit) = until_exit(&rx, Duration::from_secs(10));
    assert_eq!(lines.len(), limits.max_lines as usize);
    assert_eq!(exit.reason.as_deref(), Some(lines_sentence(limits.max_lines).as_str()));

    let (_run, rx) = start(&["calls", "100"], small(Duration::from_secs(10)));
    let (lines, exit) = until_exit(&rx, Duration::from_secs(10));
    assert_eq!(lines.len(), 21, "the call past the limit is handed on, then the recipe stops");
    assert_eq!(exit.reason.as_deref(), Some(calls_sentence(20).as_str()));
}

fn repo_crate() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("lime-recipe")
}

/// A recipe that only logs, built by lust and run by the runner: one call, one reply, a clean exit.
#[test]
fn a_real_recipe_that_only_logs() {
    let Some(lust) = find_lust(None) else {
        assert!(std::env::var("LIME_RECIPE_REQUIRED").as_deref() != Ok("1"), "lust is required here (LIME_LUST)");
        eprintln!("skipped: set LIME_LUST to a lust build");
        return;
    };
    let root = std::env::temp_dir().join(format!("lime-runner-real-{}", std::process::id()));
    let source = "use lime_recipe::Session;\n\nfn main() {\n    let mut s = Session::start();\n    s.log(\"hello from the app\");\n}\n";
    let built = build(&lust, &root, &repo_crate(), 0, source, Duration::from_secs(120)).expect("lust runs");
    assert_eq!(built.code, Some(0), "{}\n{}", built.stdout, built.stderr);
    let exe = built.exe.expect("the build made a program");
    assert!(built.main.ends_with(Path::new("slot-0").join("src").join("main.rs")));
    // The same text again is the program the slot holds: the file a run starts is the one already built.
    let made = std::fs::metadata(&exe).unwrap().modified().unwrap();
    let again = build(&lust, &root, &repo_crate(), 0, source, Duration::from_secs(120)).unwrap();
    assert_eq!(again.exe.as_deref(), Some(exe.as_path()));
    assert_eq!(std::fs::metadata(&exe).unwrap().modified().unwrap(), made, "unchanged text was built again");
    // Changed text, and then the first text after it, each build.
    let edited = build(&lust, &root, &repo_crate(), 0, &format!("{source}// edited\n"), Duration::from_secs(120)).unwrap();
    assert_eq!(edited.code, Some(0), "{}\n{}", edited.stdout, edited.stderr);
    assert_ne!(std::fs::metadata(&exe).unwrap().modified().unwrap(), made, "changed text was not built");
    let built = build(&lust, &root, &repo_crate(), 0, source, Duration::from_secs(120)).unwrap();
    assert_eq!(built.code, Some(0), "{}\n{}", built.stdout, built.stderr);

    // lust marks the `s.apply` whose reply the recipe never reads (0.3.0's --mark-unread); an older lust is not asked.
    // The marks are lines of the build's output, which the program kept for an unchanged text keeps.
    let marking = "use lime_recipe::{ops, Session};\n\nfn main() {\n    let mut s = Session::start();\n    let p = s.solid_new(ops::cuboid(1.0, 1.0, 1.0)).unwrap();\n    s.apply(&p, ops::cuboid(1.0, 1.0, 1.0)).unwrap();\n    let r = s.apply(&p, ops::cuboid(1.0, 1.0, 1.0)).unwrap();\n    s.log(&format!(\"{r}\"));\n}\n";
    let marked = build(&lust, &root, &repo_crate(), 2, marking, Duration::from_secs(120)).unwrap();
    assert_eq!(marked.code, Some(0), "{}\n{}", marked.stdout, marked.stderr);
    assert_eq!(marked.marked, lust_features(&lust).mark_unread);
    let marks: Vec<&str> = marked.stdout.lines().filter(|l| l.contains("\"kind\":\"unread_result\"")).collect();
    if marked.marked {
        assert_eq!(marks.len(), 1, "{}", marked.stdout);
        assert!(marks[0].contains(MARK_UNREAD_FN) && marks[0].contains("\"line\":6,\"col\":7"), "{}", marks[0]);
    } else {
        assert!(marks.is_empty());
    }
    let kept = build(&lust, &root, &repo_crate(), 2, marking, Duration::from_secs(120)).unwrap();
    assert_eq!((kept.stdout.as_str(), kept.marked), (marked.stdout.as_str(), marked.marked), "a kept program keeps its marks");

    let broken = build(&lust, &root, &repo_crate(), 1, "fn main() { let x: f64 = 1; }\n", Duration::from_secs(120)).unwrap();
    assert_ne!(broken.code, Some(0));
    assert!(broken.exe.is_none());
    assert!(broken.stdout.lines().any(|l| l.contains("\"kind\":\"diagnostic\"")), "{}", broken.stdout);

    let (tx, rx) = channel();
    let run = RecipeRun::start(&exe, &[], &root, Limits::default(), move |event| {
        let _ = tx.send(event);
    })
    .unwrap();
    run.send(r#"{"v":1,"params":{},"context":{"units":"mm"}}"#).unwrap();
    let first = match rx.recv_timeout(Duration::from_secs(20)).unwrap() {
        RunEvent::Line(line) => line,
        other => panic!("expected the log call, got {other:?}"),
    };
    let call: serde_json::Value = serde_json::from_str(&first).unwrap();
    assert_eq!(call["call"], "log");
    assert_eq!(call["args"]["text"], "hello from the app");
    run.send(&format!(r#"{{"id":{},"ok":true,"result":{{"ok":true}}}}"#, call["id"])).unwrap();
    let (rest, exit) = until_exit(&rx, Duration::from_secs(20));
    assert!(rest.is_empty(), "{rest:?}");
    assert_eq!(exit.code, Some(0), "{}", exit.stderr);
    assert_eq!(exit.reason, None);
    drop(run);
    let _ = std::fs::remove_dir_all(&root);
}
