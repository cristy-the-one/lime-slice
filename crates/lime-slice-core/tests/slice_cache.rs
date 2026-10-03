use base64::Engine;
use lime_slice_core::{slice_payload, Job, SliceCache};
use serde_json::{json, Value};

/// Binary STL of a `size` mm cube standing on the bed.
fn cube_stl(size: f32) -> Vec<u8> {
    let v = |x: f32, y: f32, z: f32| [x * size, y * size, z * size];
    let quads = [
        [v(0., 0., 0.), v(0., 1., 0.), v(1., 1., 0.), v(1., 0., 0.)],
        [v(0., 0., 1.), v(1., 0., 1.), v(1., 1., 1.), v(0., 1., 1.)],
        [v(0., 0., 0.), v(1., 0., 0.), v(1., 0., 1.), v(0., 0., 1.)],
        [v(0., 1., 0.), v(0., 1., 1.), v(1., 1., 1.), v(1., 1., 0.)],
        [v(0., 0., 0.), v(0., 0., 1.), v(0., 1., 1.), v(0., 1., 0.)],
        [v(1., 0., 0.), v(1., 1., 0.), v(1., 1., 1.), v(1., 0., 1.)],
    ];
    let mut stl = vec![0u8; 80];
    stl.extend_from_slice(&12u32.to_le_bytes());
    for [a, b, c, d] in quads {
        for tri in [[a, b, c], [a, c, d]] {
            stl.extend_from_slice(&[0u8; 12]);
            for p in tri {
                for x in p {
                    stl.extend_from_slice(&x.to_le_bytes());
                }
            }
            stl.extend_from_slice(&[0u8; 2]);
        }
    }
    stl
}

fn request(layer_height: f64, reslice: bool) -> String {
    json!({
        "filename": "cube.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(cube_stl(10.0)),
        "layerHeight": layer_height,
        "baseline": false,
        "includePreview": false,
        "includeGcode": false,
        "reslice": reslice,
    })
    .to_string()
}

/// Slice through `cache`, returning the reply and the G-code handed to `park`.
fn slice(payload: &str, cache: &SliceCache) -> (Value, String) {
    let mut parked = String::new();
    let reply = slice_payload(payload, Some(cache), Job::default(), |gcode| {
        parked = gcode.text();
        "token".into()
    })
    .unwrap();
    cache.flush();
    (serde_json::from_str(&reply).unwrap(), parked)
}

fn entries(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir).map_or(0, |d| {
        d.filter(|e| e.as_ref().unwrap().path().extension().unwrap() == "json")
            .count()
    })
}

#[test]
fn a_repeated_slice_loads_from_the_cache_until_resliced() {
    let dir = tempdir("repeat");
    let cache = SliceCache::new(&dir, 1 << 30);

    let (first, first_gcode) = slice(&request(0.2, false), &cache);
    assert_eq!(first["fromCache"], json!(false));
    assert_eq!(first["gcodeToken"], json!("token"));
    assert!(
        first.get("gcode").is_none(),
        "g-code is parked, not inlined"
    );
    assert!(first_gcode.contains("G1"), "a real slice");

    let (again, again_gcode) = slice(&request(0.2, false), &cache);
    assert_eq!(again["fromCache"], json!(true));
    assert_eq!(again["slicedAtMs"], first["slicedAtMs"]);
    assert_eq!(again["estimate"], first["estimate"]);
    assert_eq!(again_gcode, first_gcode);

    let (other, _) = slice(&request(0.3, false), &cache);
    assert_eq!(
        other["fromCache"],
        json!(false),
        "another layer height is another slice"
    );

    let (fresh, fresh_gcode) = slice(&request(0.2, true), &cache);
    assert_eq!(fresh["fromCache"], json!(false), "reslice plans again");
    assert_eq!(fresh_gcode, first_gcode);
    assert_eq!(entries(&dir), 2);

    let (after, _) = slice(&request(0.2, false), &cache);
    assert_eq!(after["fromCache"], json!(true));
    assert_eq!(
        after["slicedAtMs"], fresh["slicedAtMs"],
        "the reslice replaced the entry"
    );
}

#[test]
fn the_cache_drops_the_oldest_slices_past_its_cap() {
    let dir = tempdir("cap");
    let probe = tempdir("probe");
    slice(&request(0.25, false), &SliceCache::new(&probe, 1 << 30));
    let one = std::fs::read_dir(&probe)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .metadata()
        .unwrap()
        .len();
    let cache = SliceCache::new(&dir, one * 5 / 2);

    slice(&request(0.2, false), &cache);
    std::thread::sleep(std::time::Duration::from_millis(20));
    slice(&request(0.25, false), &cache);
    std::thread::sleep(std::time::Duration::from_millis(20));
    slice(&request(0.3, false), &cache);

    assert_eq!(entries(&dir), 2);
    assert_eq!(
        slice(&request(0.2, false), &cache).0["fromCache"],
        json!(false)
    );
    assert_eq!(
        slice(&request(0.3, false), &cache).0["fromCache"],
        json!(true)
    );
}

fn json_entries(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().unwrap() == "json")
        .collect()
}

#[test]
fn a_cached_reply_equals_the_fresh_one() {
    let dir = tempdir("equal");
    let cache = SliceCache::new(&dir, 1 << 30);
    let request = {
        let mut req: Value = serde_json::from_str(&request(0.2, false)).unwrap();
        req["includeGcode"] = json!(true);
        req["includePreview"] = json!(true);
        req.to_string()
    };

    let (mut fresh, _) = slice(&request, &cache);
    let (mut cached, _) = slice(&request, &cache);

    assert_eq!(fresh["fromCache"], json!(false));
    assert_eq!(cached["fromCache"], json!(true));
    assert!(fresh["gcode"].as_str().unwrap().contains("G1"));
    assert!(!fresh["layers"].as_array().unwrap().is_empty());
    fresh.as_object_mut().unwrap().remove("fromCache");
    cached.as_object_mut().unwrap().remove("fromCache");
    assert_eq!(cached, fresh);

    let on_disk: Value =
        serde_json::from_slice(&std::fs::read(&json_entries(&dir)[0]).unwrap()).unwrap();
    assert_eq!(on_disk, fresh, "the file holds the whole reply");
}

#[test]
fn a_half_written_temp_file_is_ignored() {
    let dir = tempdir("halfway");
    let cache = SliceCache::new(&dir, 1 << 30);
    slice(&request(0.2, false), &cache);
    let entry = json_entries(&dir).remove(0);
    let key = entry.file_stem().unwrap().to_str().unwrap().to_owned();
    let whole = std::fs::read(&entry).unwrap();
    std::fs::remove_file(&entry).unwrap();
    let half = dir.join(format!("{key}.4242.0.tmp"));
    std::fs::write(&half, &whole[..whole.len() / 2]).unwrap();

    let (again, _) = slice(&request(0.2, false), &cache);

    assert_eq!(
        again["fromCache"],
        json!(false),
        "the temp file is no entry"
    );
    assert_eq!(json_entries(&dir), vec![entry], "a whole entry replaces it");
    assert!(
        half.exists(),
        "a recent temp file may belong to a live write"
    );
}

#[test]
fn a_stale_temp_file_is_cleaned_up_by_the_next_write() {
    let dir = tempdir("stale");
    std::fs::create_dir_all(&dir).unwrap();
    let stale = dir.join("dead.1.0.tmp");
    std::fs::write(&stale, b"{\"half\":").unwrap();
    let file = std::fs::File::options().write(true).open(&stale).unwrap();
    let two_hours = std::time::Duration::from_secs(2 * 3600);
    file.set_modified(std::time::SystemTime::now() - two_hours)
        .unwrap();
    drop(file);

    slice(&request(0.2, false), &SliceCache::new(&dir, 1 << 30));

    assert!(!stale.exists());
    assert_eq!(entries(&dir), 1);
}

fn tempdir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "lime-slice-cache-test-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}
