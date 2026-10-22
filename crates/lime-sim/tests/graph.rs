//! The solve crate does not link the slicer. Spawning `cargo metadata` from
//! a test deadlocks the package lock, so this reads the manifest the same
//! way the resolver does: dependency keys, not a comment and not a substring
//! of another crate name.

#[test]
fn lime_sim_does_not_depend_on_the_slicer() {
    let manifest = include_str!("../Cargo.toml");
    let names = dependency_names(manifest);
    for banned in ["lime-slice-core", "lime-slice", "lime-model-occt"] {
        assert!(
            !names.iter().any(|name| name == banned),
            "{banned} is on the solve path: {names:?}"
        );
    }
}

fn dependency_names(manifest: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut in_deps = false;
    for line in manifest.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_deps = trimmed == "[dependencies]" || trimmed == "[dev-dependencies]";
            continue;
        }
        if !in_deps || trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((name, _)) = trimmed.split_once('=') {
            names.push(name.trim().trim_matches('"').to_string());
        }
    }
    names
}

#[test]
fn infill_pattern_strength_is_not_referenced() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for entry in std::fs::read_dir(&root).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("InfillPattern"),
            "{} must not read the slicer's strength heuristic",
            path.display()
        );
    }
}
