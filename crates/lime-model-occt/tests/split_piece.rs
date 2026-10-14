//! The piece a split adds is a solid the session holds under its own id, with its own undo,
//! until undo of the split takes it off and redo puts it back. One test: one session per process.

use lime_model_occt::Plane;
use serde_json::Value;

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.05,
        "{actual} is not near {expected}"
    );
}

fn volume(reply: &str) -> f64 {
    let json = parse(reply);
    assert!(json.get("error").is_none(), "{json}");
    json["volumeMm3"].as_f64().expect("volume")
}

fn at_z(z: f64) -> Plane {
    Plane {
        origin: [0.0, 0.0, z],
        normal: [0.0, 0.0, 1.0],
    }
}

fn measured(id: i32) -> Value {
    parse(&lime_model_occt::distance(id, "face", 0, "face", 1))
}

const GONE: Option<&str> = Some("That solid is no longer open");

#[test]
fn a_split_piece_is_a_held_solid() {
    let opened = parse(&lime_model_occt::open_box(10.0, 10.0, 10.0));
    if opened.get("error").is_some() {
        if std::env::var_os("LIME_REQUIRE_OCCT").is_some() {
            panic!("OCCT was required: {opened}");
        }
        return;
    }
    let part = opened["id"].as_i64().expect("id") as i32;

    let split = parse(&lime_model_occt::split(part, at_z(4.0), 0.1));
    near(split["volumeMm3"].as_f64().expect("kept"), 400.0);
    near(split["other"]["volumeMm3"].as_f64().expect("piece"), 600.0);
    let piece = split["other"]["id"].as_i64().expect("piece id") as i32;
    assert_ne!(piece, 0);
    assert_ne!(piece, part);
    assert!(measured(piece)["distanceMm"].as_f64().is_some(), "{}", measured(piece));

    near(volume(&lime_model_occt::scale(piece, 2.0, 0.1)), 4800.0);
    near(volume(&lime_model_occt::undo(piece, 0.1)), 600.0);
    let nothing = parse(&lime_model_occt::undo(piece, 0.1));
    assert_eq!(nothing["error"].as_str(), Some("There is no edit to undo"), "the piece has its own history");

    near(volume(&lime_model_occt::undo(part, 0.1)), 1000.0);
    assert_eq!(measured(piece)["error"].as_str(), GONE, "undo of the split takes the piece off");
    near(volume(&lime_model_occt::redo(part, 0.1)), 400.0);
    assert!(measured(piece).get("error").is_none(), "redo puts the piece back under its id");
    near(volume(&lime_model_occt::redo(piece, 0.1)), 4800.0);
    near(volume(&lime_model_occt::undo(piece, 0.1)), 600.0);

    let again = parse(&lime_model_occt::split(piece, at_z(7.0), 0.1));
    near(again["volumeMm3"].as_f64().expect("kept"), 300.0);
    near(again["other"]["volumeMm3"].as_f64().expect("piece of the piece"), 300.0);
    let third = again["other"]["id"].as_i64().expect("third id") as i32;
    assert!(third != part && third != piece);

    near(volume(&lime_model_occt::undo(part, 0.1)), 1000.0);
    near(volume(&lime_model_occt::scale(part, 2.0, 0.1)), 8000.0);
    assert_eq!(measured(piece)["error"].as_str(), GONE, "a new edit drops the undone piece");
    let no_redo = parse(&lime_model_occt::redo(part, 0.1));
    assert_eq!(no_redo["error"].as_str(), Some("There is no edit to redo"));

    let next = parse(&lime_model_occt::open_box(5.0, 5.0, 5.0));
    let next_id = next["id"].as_i64().expect("id") as i32;
    assert!(next_id != part && next_id != piece && next_id != third, "ids are not reused");
    assert_eq!(measured(part)["error"].as_str(), GONE, "opening a file releases the last one");
}
