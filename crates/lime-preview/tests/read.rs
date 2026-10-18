//! The reader agrees with `geometryHash` in `src/project-thumb.ts`.

use std::time::Duration;

use lime_preview::{preview, read_preview};

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAC0lEQVR4nGNgQAcAABIAAXfx+gAAAAAASUVORK5CYII=";

fn place(x: &str) -> String {
    format!(
        r#"{{"orient":[1,0,0,0,1,0,0,0,1],"scale":1,"centered":true,"offset":{{"x":{x},"y":0,"z":0}},"stepTolerance":0.05}}"#
    )
}

fn version1(x: &str) -> String {
    format!(
        r#"{{
  "version": 1,
  "mesh": {{"name": "bracket.stl", "bytesBase64": "c3RsAQIDBAk=", "byteLength": 8, "hash": "eaa27901f3139a05"}},
  "placement": {},
  "settings": {{"layerHeight": 0.2}},
  "preset": null,
  "profile": {{"name": "Voron 2.4"}},
  "level": "simple",
  "supportEdits": []
}}"#,
        place(x)
    )
}

fn with_preview(body: &str, hash: &str) -> String {
    format!(
        r#"{{
  "thumbnail": {{
    "format": "png",
    "width": 2,
    "height": 2,
    "data": "{PNG}",
    "meshHash": "{hash}",
    "generatedBy": "lime-slice/2.7.0",
    "createdAt": "2026-10-18T09:00:00.000Z"
  }},
  "summary": {{"name": "bracket.stl", "printer": "Voron 2.4", "objectCount": 1, "layerHeight": 0.2, "slicedSeconds": 90, "grams": 1.5}},
  {body}"#
    )
}

#[test]
fn version1_hash_matches_typescript() {
    let read = preview(version1("0").as_bytes());
    assert_eq!(read.geometry_hash.as_deref(), Some("e55a0c3d9becba93"));
    assert!(read.thumbnail.is_none());
}

#[test]
fn plate_hash_matches_typescript() {
    let file = format!(
        r#"{{"version":3,"objects":[
        {{"id":"a","name":"bracket.stl","mesh":{{"name":"bracket.stl","hash":"eaa27901f3139a05","bytesBase64":"c3RsAQIDBAk=","byteLength":8}},"placement":{}}},
        {{"id":"b","name":"clip.stl","mesh":{{"name":"clip.stl","hash":"be7a5e775165785d","bytesBase64":"AQIDBA==","byteLength":4}},"placement":{}}}
        ]}}"#,
        place("0"),
        place("30")
    );
    let read = preview(file.as_bytes());
    assert_eq!(read.geometry_hash.as_deref(), Some("95ce3ae3d215383b"));
}

#[test]
fn one_simple_object_hashes_as_part() {
    let file = format!(
        r#"{{"version":3,"objects":[{{"id":"not-part","name":"bracket.stl","mesh":{{"name":"bracket.stl","hash":"eaa27901f3139a05"}},"placement":{}}}]}}"#,
        place("0")
    );
    assert_eq!(
        preview(file.as_bytes()).geometry_hash.as_deref(),
        Some("e55a0c3d9becba93")
    );
}

#[test]
fn a_renamed_object_hashes_under_its_id() {
    let file = format!(
        r#"{{"version":3,"objects":[{{"id":"a","name":"other","mesh":{{"name":"bracket.stl","hash":"eaa27901f3139a05"}},"placement":{}}}]}}"#,
        place("0")
    );
    let hash = preview(file.as_bytes()).geometry_hash.unwrap();
    assert_ne!(hash, "e55a0c3d9becba93");
}

#[test]
fn thumbnail_is_shown_only_when_the_hash_matches() {
    let file = with_preview(&version1("0")[1..], "e55a0c3d9becba93");
    let read = preview(file.as_bytes());
    assert!(read.image().is_some());
    assert_eq!(read.thumbnail.as_ref().map(|thumb| thumb.width), Some(2));
    assert_eq!(
        read.summary.as_ref().and_then(|row| row.printer.as_deref()),
        Some("Voron 2.4")
    );
    assert_eq!(read.summary.as_ref().and_then(|row| row.grams), Some(1.5));
    let moved = with_preview(&version1("4")[1..], "e55a0c3d9becba93");
    let stale = preview(moved.as_bytes());
    assert!(stale.image().is_none());
    assert!(stale.thumbnail.is_some());
    assert!(stale.summary.is_some());
}

#[test]
fn a_bad_picture_is_ignored() {
    let jpeg = version1("0").replacen(
        "{",
        r#"{"thumbnail":{"format":"jpeg","width":2,"height":2,"data":"aaaa","meshHash":"e55a0c3d9becba93"},"#,
        1,
    );
    let read = preview(jpeg.as_bytes());
    assert!(read.thumbnail.is_none());
    assert_eq!(read.geometry_hash.as_deref(), Some("e55a0c3d9becba93"));
}

#[test]
fn a_thumbnail_inside_a_name_is_not_the_picture() {
    let file = r#"{"version":1,"mesh":{"name":"thumbnail","hash":"eaa27901f3139a05","bytesBase64":"c3RsAQIDBAk=","byteLength":8},"placement":{"orient":[1,0,0,0,1,0,0,0,1],"scale":1,"centered":true,"offset":{"x":0,"y":0,"z":0},"stepTolerance":0.05}}"#;
    let read = preview(file.as_bytes());
    assert!(read.thumbnail.is_none());
    assert!(read.geometry_hash.is_some());
}

#[test]
fn hostile_input_does_not_panic() {
    assert!(preview(b"").image().is_none());
    assert!(preview(b"{").geometry_hash.is_none());
    assert!(preview(br#"{"thumbnail":"nope""#).thumbnail.is_none());
    assert!(preview(br#"{"thumbnail":{"format":"png""#)
        .image()
        .is_none());
    let mut huge = String::from(
        r#"{"version":1,"mesh":{"name":"a","hash":"eaa27901f3139a05","bytesBase64":""#,
    );
    huge.push_str(&"A".repeat(8 * 1024 * 1024));
    huge.push_str(r#"","byteLength":8},"placement":{"orient":[1,0,0,0,1,0,0,0,1],"scale":1,"centered":true,"offset":{"x":0,"y":0,"z":0},"stepTolerance":0.05}}"#);
    let read = preview(huge.as_bytes());
    assert_eq!(read.geometry_hash.as_deref(), Some("e55a0c3d9becba93"));
    let mut open = String::from(
        r#"{"version":1,"mesh":{"name":"a","hash":"eaa27901f3139a05","bytesBase64":"AAAA"#,
    );
    assert!(preview(open.as_bytes()).geometry_hash.is_none());
    open.push_str(&"B".repeat(1024 * 1024));
    assert!(preview(open.as_bytes()).image().is_none());
}

#[test]
fn a_zero_budget_hides_the_picture() {
    let file = with_preview(&version1("0")[1..], "e55a0c3d9becba93");
    let read = read_preview(file.as_bytes(), Duration::ZERO);
    assert!(read.image().is_none());
}
