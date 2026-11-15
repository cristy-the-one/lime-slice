//! The support stability report on the supports-rework test parts, flat bed
//! and belt, tree and grid. These pin what the report says today, as
//! characterization: a later fix that changes a support flips the test
//! named after the behaviour it fixes.

use base64::Engine;
use lime_slice_core::{slice_request, Job, SliceRequest, SliceResponse, Stand, SupportStability};
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
    let response = slice_request(
        &request(stl, bed, style, json!({ "supportStability": true })),
        Job::default(),
    )
    .unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    response
}

fn stability(stl: &[u8], bed: Bed, style: &str) -> SupportStability {
    slice(stl, bed, style)
        .support_stability
        .expect("asked for supportStability")
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

/// Bug F1 of the plan: on a flat bed the tree foot is a hollow two-wall
/// ring, and the trunk's second layer prints inside it over bare bed. The
/// floating-support audit passes it; this report does not. Flips when the
/// foot is filled (plan step 1).
#[test]
fn flat_tree_foot_on_the_bridge_span_rests_on_nothing_today() {
    let s = stability(&bridge_span_sample(), Bed::Flat, "tree");
    assert_eq!(s.supports, 1, "{s:?}");
    assert!(s.unrested_mm > 5.0, "{s:?}");
    let tree = &s.most_unrested[0];
    assert_eq!(tree.stands_on, Stand::Bed, "{tree:?}");
    // The first unrested bead is on the second layer, inside the foot ring.
    let at = tree.unrested_at.expect("an unrested bead");
    assert!(at[2] < 0.45, "{tree:?}");
    // The foot is about 4 mm across; the trunk above it far thinner.
    assert!(tree.foot_min_mm > 3.5, "{tree:?}");
    assert!(tree.base_min_mm < 2.0, "{tree:?}");
}

/// No limit on height against width: the lone tree under the tall pad is
/// about 19 times taller than its base. Flips with plan step 4.
#[test]
fn tall_pad_tree_is_over_ten_times_taller_than_wide_today() {
    let s = stability(&tall_pad(), Bed::Flat, "tree");
    assert_eq!(s.supports, 1, "{s:?}");
    let tree = &s.most_slender[0];
    assert!(tree.height_mm > 75.0, "{tree:?}");
    assert!(tree.slenderness > 15.0, "{tree:?}");
    assert_eq!(s.over_limit, 1);
    assert_eq!(tree.stands_on, Stand::Bed);
}

/// Belt trees under the table are blades: thinner along the belt than
/// across it, and every one over the limit. Flips with plan step 4.
#[test]
fn belt_table_trees_are_thinner_along_the_belt_than_across_today() {
    let s = stability(&table(), Bed::Belt, "tree");
    assert_eq!(s.supports, 3, "{s:?}");
    assert_eq!(s.over_limit, 3, "{s:?}");
    for tree in &s.most_slender {
        assert_eq!(tree.stands_on, Stand::Belt, "{tree:?}");
        assert!(tree.base_along_mm + 0.5 < tree.base_across_mm, "{tree:?}");
        assert!(tree.height_mm > 55.0, "{tree:?}");
    }
    // They print first, ahead of the part: short layers of support only.
    assert!(s.support_only_layers > 0, "{s:?}");
    assert!(s.short_layers.unwrap() > 0, "{s:?}");
}

/// Belt grid under the table's leading edge is a sheet one bead thick.
/// Flips with plan step 5 (a wall and a base on small grid columns).
#[test]
fn belt_grid_under_the_table_is_a_one_bead_curtain_today() {
    let s = stability(&table(), Bed::Belt, "grid");
    let sheet = &s.most_slender[0];
    assert!((sheet.base_min_mm - 0.45).abs() < 0.05, "{sheet:?}");
    assert!(sheet.slenderness > 100.0, "{sheet:?}");
    assert_eq!(sheet.stands_on, Stand::Belt, "{sheet:?}");
    assert_eq!(s.unrested_mm, 0.0, "{s:?}");
}

/// Belt grid under the small hanging pad: loose dashes that reach neither
/// the belt nor the pad. Flips with plan step 3.
#[test]
fn belt_grid_under_the_tall_pad_is_loose_dashes_today() {
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

/// Flat grid columns stand whole: every bead rests on the one below.
#[test]
fn flat_grid_under_the_bridges_rests_on_itself() {
    let s = stability(&bridges(), Bed::Flat, "grid");
    assert_eq!(s.supports, 4, "{s:?}");
    assert_eq!(s.unrested_mm, 0.0, "{s:?}");
    assert!(s.most_slender.iter().all(|c| c.stands_on == Stand::Bed));
    assert_eq!(s.over_limit, 0, "{s:?}");
}

/// Grid under narrow lips is one-line cards: a bead thick, many times
/// taller. Flips with plan step 5 or step 9.
#[test]
fn flat_grid_under_the_lips_is_one_bead_thick_today() {
    let s = stability(&lips(), Bed::Flat, "grid");
    assert!((s.thinnest_mm.unwrap() - 0.45).abs() < 0.05, "{s:?}");
    assert!(s.over_limit >= 2, "{s:?}");
}

/// Cantilevers on the belt: slender trees, some beads unrested.
#[test]
fn belt_cantilever_trees_today() {
    let s = stability(&cantilevers(), Bed::Belt, "tree");
    assert!(s.supports >= 3, "{s:?}");
    assert!(s.over_limit >= 1, "{s:?}");
    assert!(s.unrested_mm > 0.0, "{s:?}");
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
