//! The support stability report on the supports-rework test parts, flat bed
//! and belt, tree and grid. Tests named "today" pin what the report says, as
//! characterization: a later fix that changes a support flips the test
//! named after the behaviour it fixes. The rest assert the fixed rules.

use base64::Engine;
use lime_slice_core::{
    slice_request, Job, SliceRequest, SliceResponse, Stand, SupportStability, SLENDER_LIMIT,
};
use serde_json::{json, Value};

type Box3 = ([f64; 3], [f64; 3]);

/// Boxes, z up, as one ASCII STL.
fn boxes_stl(boxes: &[Box3]) -> Vec<u8> {
    let mut s = String::from("solid p\n");
    for &([x0, y0, z0], [x1, y1, z1]) in boxes {
        let v = [
            [x0, y0, z0],
            [x1, y0, z0],
            [x1, y1, z0],
            [x0, y1, z0],
            [x0, y0, z1],
            [x1, y0, z1],
            [x1, y1, z1],
            [x0, y1, z1],
        ];
        for [a, b, c, d] in [
            [0, 3, 2, 1],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [2, 3, 7, 6],
            [1, 2, 6, 5],
            [3, 0, 4, 7],
        ] {
            for [p, q, r] in [[a, b, c], [a, c, d]] {
                s.push_str("facet normal 0 0 0\nouter loop\n");
                for k in [p, q, r] {
                    s.push_str(&format!("vertex {} {} {}\n", v[k][0], v[k][1], v[k][2]));
                }
                s.push_str("endloop\nendfacet\n");
            }
        }
    }
    s.push_str("endsolid p\n");
    s.into_bytes()
}

/// A post with a pad hanging 70 mm above the bed from an arm: one lone tall support.
fn tall_pad() -> Vec<u8> {
    boxes_stl(&[
        ([0.0, 0.0, 0.0], [10.0, 10.0, 80.0]),
        ([0.0, 0.0, 80.0], [30.0, 10.0, 82.0]),
        ([24.0, 0.0, 70.0], [30.0, 10.0, 80.0]),
    ])
}

/// A 60 × 40 roof 60 mm up on four legs: tall supports side by side.
fn table() -> Vec<u8> {
    boxes_stl(&[
        ([0.0, 0.0, 0.0], [5.0, 5.0, 60.0]),
        ([55.0, 0.0, 0.0], [60.0, 5.0, 60.0]),
        ([0.0, 35.0, 0.0], [5.0, 40.0, 60.0]),
        ([55.0, 35.0, 0.0], [60.0, 40.0, 60.0]),
        ([0.0, 0.0, 60.0], [60.0, 40.0, 62.0]),
    ])
}

/// Bridges of 5, 10, 20 and 40 mm between posts, 15 mm up.
fn bridges() -> Vec<u8> {
    boxes_stl(&[
        ([0.0, 0.0, 0.0], [5.0, 60.0, 15.0]),
        ([10.0, 0.0, 0.0], [15.0, 12.0, 15.0]),
        ([0.0, 0.0, 15.0], [15.0, 12.0, 17.0]),
        ([15.0, 16.0, 0.0], [20.0, 28.0, 15.0]),
        ([0.0, 16.0, 15.0], [20.0, 28.0, 17.0]),
        ([25.0, 32.0, 0.0], [30.0, 44.0, 15.0]),
        ([0.0, 32.0, 15.0], [30.0, 44.0, 17.0]),
        ([45.0, 48.0, 0.0], [50.0, 60.0, 15.0]),
        ([0.0, 48.0, 15.0], [50.0, 60.0, 17.0]),
    ])
}

/// Cantilevers of 3, 6, 12 and 25 mm from a wall, 25 mm up.
fn cantilevers() -> Vec<u8> {
    boxes_stl(&[
        ([0.0, 0.0, 0.0], [8.0, 60.0, 30.0]),
        ([8.0, 2.0, 25.0], [11.0, 12.0, 27.0]),
        ([8.0, 17.0, 25.0], [14.0, 27.0, 27.0]),
        ([8.0, 32.0, 25.0], [20.0, 42.0, 27.0]),
        ([8.0, 47.0, 25.0], [33.0, 57.0, 27.0]),
    ])
}

/// Lips of 0.5, 1, 2 and 4 mm out of a wall, 20 mm up.
fn lips() -> Vec<u8> {
    boxes_stl(&[
        ([0.0, 0.0, 0.0], [10.0, 60.0, 30.0]),
        ([10.0, 2.0, 20.0], [10.5, 12.0, 30.0]),
        ([10.0, 17.0, 20.0], [11.0, 27.0, 30.0]),
        ([10.0, 32.0, 20.0], [12.0, 42.0, 30.0]),
        ([10.0, 47.0, 20.0], [14.0, 57.0, 30.0]),
    ])
}

/// A pedestal 10 mm tall, then 60 one-layer steps each 0.19 mm further out:
/// every layer passes the 45° test, and the top hangs 11.4 mm out.
fn staircase() -> Vec<u8> {
    let mut boxes = vec![([0.0, 0.0, 0.0], [10.0, 20.0, 10.0])];
    for k in 0..60 {
        let z = 10.0 + 0.2 * k as f64;
        boxes.push(([0.0, 0.0, z], [10.0 + 0.19 * (k + 1) as f64, 20.0, z + 0.2]));
    }
    boxes_stl(&boxes)
}

/// A 40 mm deck 15 mm up, held on one side only, by a 5 mm post.
fn one_sided_span() -> Vec<u8> {
    boxes_stl(&[
        ([0.0, 0.0, 0.0], [5.0, 10.0, 15.0]),
        ([0.0, 0.0, 15.0], [40.0, 10.0, 17.0]),
    ])
}

/// The repo sample, a binary STL: a 14 mm deck over a gap.
fn bridge_span_sample() -> Vec<u8> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../samples/bridge_span.stl");
    std::fs::read(path).expect("samples/bridge_span.stl")
}

fn ir3() -> Value {
    json!({
        "angleDeg": 45.0, "axis": "z", "direction": 1, "widthMm": 250.0,
        "copies": 1, "gapMm": 5.0, "floorSupports": true,
    })
}

#[derive(Clone, Copy, Debug)]
enum Bed {
    Flat,
    Belt,
}

/// The test parts' request: Speed, 0.2 mm layers, 0.45 mm lines, default
/// support settings, as the plan measured them.
fn request(stl: &[u8], bed: Bed, style: &str, extra: Value) -> SliceRequest {
    let mut body = json!({
        "filename": "part.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "blend": { "mode": "single", "strategy": "speed" },
        "baseline": false,
        "compare": false,
        "includePreview": false,
        "includeGcode": true,
        "supports": true,
        "supportStyle": style,
    });
    if let Bed::Belt = bed {
        body["belt"] = ir3();
    }
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    serde_json::from_value(body).unwrap()
}

fn slice(stl: &[u8], bed: Bed, style: &str) -> SliceResponse {
    slice_with(stl, bed, style, json!({}))
}

fn slice_with(stl: &[u8], bed: Bed, style: &str, extra: Value) -> SliceResponse {
    let mut extra = extra;
    extra["supportStability"] = json!(true);
    let response = slice_request(&request(stl, bed, style, extra), Job::default()).unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    response
}

fn stability(stl: &[u8], bed: Bed, style: &str) -> SupportStability {
    stability_with(stl, bed, style, json!({}))
}

fn stability_with(stl: &[u8], bed: Bed, style: &str, extra: Value) -> SupportStability {
    slice_with(stl, bed, style, extra)
        .support_stability
        .expect("asked for supportStability")
}

/// The belt setting that holds thin strips.
fn hold_thin() -> Value {
    json!({ "supportBeltHoldThin": true })
}

/// The thin-strip setting is off by default: `false` slices exactly as a
/// request that leaves it out, and a request that leaves it out does not
/// name it, so cached requests keep their bytes. On, the G-code says so.
#[test]
fn holding_thin_strips_is_off_unless_asked() {
    let stl = tall_pad();
    for style in ["tree", "grid"] {
        let unset = request(&stl, Bed::Belt, style, json!({}));
        let off = request(
            &stl,
            Bed::Belt,
            style,
            json!({ "supportBeltHoldThin": false }),
        );
        let wire = serde_json::to_value(&unset).unwrap();
        assert!(wire.get("supportBeltHoldThin").is_none());
        let unset = slice_request(&unset, Job::default()).unwrap();
        let off = slice_request(&off, Job::default()).unwrap();
        assert_eq!(unset.gcode, off.gcode, "{style}");
        assert!(!unset.gcode.contains("thin belt strips held"), "{style}");
        let on = slice_request(
            &request(&stl, Bed::Belt, style, hold_thin()),
            Job::default(),
        )
        .unwrap();
        assert!(on.gcode.contains("thin belt strips held"), "{style}");
    }
    // A flat bed has no belt to hold strips on: asking changes nothing.
    let flat = slice_request(&request(&stl, Bed::Flat, "grid", json!({})), Job::default()).unwrap();
    let asked = slice_request(
        &request(&stl, Bed::Flat, "grid", hold_thin()),
        Job::default(),
    )
    .unwrap();
    assert_eq!(flat.gcode, asked.gcode);
}

#[test]
fn the_report_is_opt_in_and_leaves_the_gcode_alone() {
    let stl = bridge_span_sample();
    for bed in [Bed::Flat, Bed::Belt] {
        let plain = slice_request(&request(&stl, bed, "tree", json!({})), Job::default()).unwrap();
        let checked = slice(&stl, bed, "tree");
        assert!(plain.support_stability.is_none());
        assert!(checked.support_stability.is_some());
        assert_eq!(plain.gcode, checked.gcode, "{bed:?}");
        let wire = serde_json::to_value(&plain).unwrap();
        assert!(wire.get("supportStability").is_none());
        let asked = serde_json::to_value(request(&stl, bed, "tree", json!({}))).unwrap();
        assert!(asked.get("supportStability").is_none());
    }
}

/// Bug F1 of the plan: on a flat bed the tree foot was a hollow two-wall
/// ring, and the trunk's second layer printed inside it over bare bed. Plan
/// step 1 fills the foot and narrows the trunk from it half a bead a layer,
/// so the foot and the layers just over it all rest.
#[test]
fn flat_tree_foot_on_the_bridge_span_rests_on_its_filled_foot() {
    let s = stability(&bridge_span_sample(), Bed::Flat, "tree");
    assert_eq!(s.supports, 1, "{s:?}");
    let tree = &s.most_slender[0];
    assert_eq!(tree.stands_on, Stand::Bed, "{tree:?}");
    // The foot is still about 4 mm across, and nothing on the foot's own
    // layers or the taper just over it rests on nothing.
    assert!(tree.foot_min_mm > 3.5, "{tree:?}");
    if let Some(at) = tree.unrested_at {
        assert!(at[2] > 1.0, "{tree:?}");
    }
}

/// Plan step 4, the slender rule: a free-standing tree or grid column
/// over 15 mm tall stands at most ten times its base width, in its thinnest
/// direction along real gravity. Before it, the tall pad's lone tree was 19
/// times (26 on the belt), the table's trees 14 (21), and the belt grid under
/// the table's leading edge a one-bead curtain 132 times.
#[test]
fn tall_supports_stand_within_ten_times_their_base_width() {
    for (name, stl) in [("tall pad", tall_pad()), ("table", table())] {
        for bed in [Bed::Flat, Bed::Belt] {
            for style in ["tree", "grid"] {
                let s = stability(&stl, bed, style);
                assert!(s.supports > 0, "{name} {bed:?} {style}: {s:?}");
                assert_eq!(s.over_limit, 0, "{name} {bed:?} {style}: {s:?}");
                assert!(
                    s.worst_slenderness <= SLENDER_LIMIT,
                    "{name} {bed:?} {style}: {s:?}"
                );
            }
        }
    }
}

/// The lone tree under the tall pad is widened only toward the bed: its
/// thinnest section is still the branch under the pad.
#[test]
fn tall_pad_tree_is_widened_at_its_base() {
    let s = stability(&tall_pad(), Bed::Flat, "tree");
    assert_eq!(s.supports, 1, "{s:?}");
    let tree = &s.most_slender[0];
    assert!(tree.height_mm > 75.0, "{tree:?}");
    assert!(
        tree.base_min_mm * SLENDER_LIMIT >= tree.height_mm,
        "{tree:?}"
    );
    assert!(tree.thinnest_mm.unwrap() < 2.0, "{tree:?}");
    assert!(
        tree.thinnest_at_mm.unwrap() > 0.5 * tree.height_mm,
        "{tree:?}"
    );
    assert_eq!(tree.stands_on, Stand::Bed);
}

/// Belt trees under the table were blades, 2.9 mm along the belt for 59 mm
/// of height. They are sized along the belt now, so they meet the rule in
/// that direction too.
#[test]
fn belt_table_trees_are_wide_enough_along_the_belt() {
    let s = stability(&table(), Bed::Belt, "tree");
    assert_eq!(s.supports, 3, "{s:?}");
    assert_eq!(s.over_limit, 0, "{s:?}");
    for tree in &s.most_slender {
        assert_eq!(tree.stands_on, Stand::Belt, "{tree:?}");
        assert!(tree.height_mm > 55.0, "{tree:?}");
        assert!(
            tree.base_along_mm * SLENDER_LIMIT >= tree.height_mm,
            "{tree:?}"
        );
    }
    // They still print first, ahead of the part: short layers of support only.
    assert!(s.support_only_layers > 0, "{s:?}");
    assert!(s.short_layers.unwrap() > 0, "{s:?}");
}

/// Belt grid under the table's leading edge was a sheet one bead thick. It
/// is widened along the belt toward its foot now, by ribs across the sheet
/// that each stand on the rib under it: no bead of it rests on nothing.
#[test]
fn belt_grid_under_the_table_is_widened_along_the_belt() {
    let s = stability(&table(), Bed::Belt, "grid");
    let sheet = &s.most_slender[0];
    assert!(
        sheet.base_along_mm * SLENDER_LIMIT >= sheet.height_mm,
        "{sheet:?}"
    );
    assert_eq!(sheet.stands_on, Stand::Belt, "{sheet:?}");
    assert_eq!(s.unrested_mm, 0.0, "{s:?}");
}

/// The widened belt grid adds no beads in the air but at its feet: on the
/// cantilevers, where a rib meets the belt beside the wall, under 10 mm of
/// its 7.5 m, all within a millimetre and a half of the belt. The tall
/// pad's column had 540 mm unrested before the rule (#710 left them), and
/// fewer after.
#[test]
fn belt_grid_ribs_rest_on_the_ribs_under_them() {
    for (name, stl, most) in [
        ("tall pad", tall_pad(), 600.0),
        ("table", table(), 0.0),
        ("cantilevers", cantilevers(), 10.0),
    ] {
        let s = stability(&stl, Bed::Belt, "grid");
        assert!(s.unrested_mm <= most, "{name}: {s:?}");
        if name == "cantilevers" {
            for c in &s.most_unrested {
                assert!(c.unrested_at.unwrap()[2] < 1.5, "{name}: {c:?}");
            }
        }
    }
}

/// Belt grid under the small hanging pad, by default: loose dashes that
/// reach neither the belt nor the pad.
#[test]
fn belt_grid_under_the_tall_pad_is_loose_dashes_by_default() {
    let s = stability(&tall_pad(), Bed::Belt, "grid");
    assert!(s.supports > 10, "{s:?}");
    assert!(s.support_mm < 50.0, "{s:?}");
    assert!(
        s.most_slender
            .iter()
            .all(|c| c.stands_on == Stand::Air && c.height_mm < 3.0),
        "{s:?}"
    );
}

/// Holding thin strips prints a line along each strip the lab-fixed grid
/// lines miss, so the grid under the small hanging pad is one column
/// standing on the belt, all the way up to the pad.
#[test]
fn belt_grid_under_the_tall_pad_is_one_column_on_the_belt() {
    let s = stability_with(&tall_pad(), Bed::Belt, "grid", hold_thin());
    assert_eq!(s.supports, 1, "{s:?}");
    let column = &s.most_slender[0];
    assert_eq!(column.stands_on, Stand::Belt, "{column:?}");
    assert!(column.height_mm > 75.0, "{column:?}");
}

/// Flat grid columns stand whole: every bead rests on the one below.
#[test]
fn flat_grid_under_the_bridges_rests_on_itself() {
    let s = stability(&bridges(), Bed::Flat, "grid");
    assert_eq!(s.supports, 4, "{s:?}");
    assert_eq!(s.unrested_mm, 0.0, "{s:?}");
    assert!(s.most_slender.iter().all(|c| c.stands_on == Stand::Bed));
    assert_eq!(s.over_limit, 0, "{s:?}");
}

/// Grid under narrow lips was one-line cards, 43 times taller than a bead.
/// The slender rule widens each card toward the bed, with a wall where its
/// lines cannot cross it, and every bead of that rests on the one under it.
/// Above a third of its height the card is still a bead thick.
#[test]
fn flat_grid_under_the_lips_is_widened_toward_the_bed() {
    let s = stability(&lips(), Bed::Flat, "grid");
    assert!((s.thinnest_mm.unwrap() - 0.45).abs() < 0.05, "{s:?}");
    assert_eq!(s.over_limit, 0, "{s:?}");
    assert_eq!(s.unrested_mm, 0.0, "{s:?}");
}

/// Cantilevers on the belt: the trees meet the rule but one, whose trunk
/// stands a couple of millimetres off the wall: the xy gap leaves it no room
/// to widen, and the report shows it.
#[test]
fn belt_cantilever_trees_widen_where_the_wall_leaves_room() {
    let s = stability(&cantilevers(), Bed::Belt, "tree");
    assert!(s.supports >= 3, "{s:?}");
    for tree in s
        .most_slender
        .iter()
        .filter(|t| t.slenderness > SLENDER_LIMIT)
    {
        assert!(tree.at[0] < 8.0 + 3.0, "{tree:?}");
    }
    assert!(s.over_limit <= 1, "{s:?}");
}

/// Supports under 15 mm are left as they grow, so most G-code does not move:
/// the belt bridges' trees and grid cards stay over the limit.
#[test]
fn short_supports_are_left_as_they_grow() {
    for style in ["tree", "grid"] {
        let s = stability(&bridges(), Bed::Belt, style);
        assert!(s.over_limit > 0, "{style}: {s:?}");
        for c in s
            .most_slender
            .iter()
            .filter(|c| c.slenderness > SLENDER_LIMIT)
        {
            assert!(c.height_mm < 15.5, "{style}: {c:?}");
        }
    }
}

/// Every layer of the staircase passes the per-layer angle test, so it gets
/// no support at all, though its top hangs 11.4 mm out. Flips when the
/// demand looks past one layer.
#[test]
fn staircase_of_small_steps_gets_no_support_today() {
    for bed in [Bed::Flat, Bed::Belt] {
        for style in ["tree", "grid"] {
            let s = stability(&staircase(), bed, style);
            assert_eq!(s.supports, 0, "{bed:?} {style}: {s:?}");
        }
    }
}

/// A deck held on one side only: one grid block on the flat bed that rests
/// whole, and trees whose beads do not.
#[test]
fn one_sided_span_today() {
    let grid = stability(&one_sided_span(), Bed::Flat, "grid");
    assert_eq!(grid.supports, 1, "{grid:?}");
    assert_eq!(grid.unrested_mm, 0.0, "{grid:?}");
    let tree = stability(&one_sided_span(), Bed::Flat, "tree");
    assert_eq!(tree.supports, 2, "{tree:?}");
    assert!(tree.unrested_mm > 0.0, "{tree:?}");
}
