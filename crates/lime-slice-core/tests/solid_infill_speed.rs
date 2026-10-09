//! Solid infill inside a thin-walled cover is a strip a few beads wide. Rows
//! across a strip make a turn every few millimetres and the head never reaches
//! its feed, so those strips print along their length instead.

use std::collections::BTreeMap;

use base64::Engine;
use clipper2::{EndType, FillRule, JoinType, Milli, Paths};
use lime_slice_core::{slice_request, Job, SliceRequest, SliceResponse};
use serde_json::json;

type P = [f64; 3];

/// Cross-section of the 1.75 mm filament the G-code's E values count.
const FILAMENT_AREA_MM2: f64 = std::f64::consts::PI * 0.875 * 0.875;

fn quad(out: &mut Vec<[P; 3]>, a: P, b: P, c: P, d: P) {
    out.push([a, b, c]);
    out.push([a, c, d]);
}

/// A box with a pocket open at the bottom: walls and a roof `wall` thick.
fn cover_stl(x: f64, y: f64, z: f64, wall: f64) -> String {
    stl_text(&cover_facets(x, y, z, wall))
}

fn cover_facets(x: f64, y: f64, z: f64, wall: f64) -> Vec<[P; 3]> {
    let mut f: Vec<[P; 3]> = Vec::new();
    let (hi_x, hi_y, hi_z) = (x - wall, y - wall, z - wall);
    quad(&mut f, [0., 0., z], [x, 0., z], [x, y, z], [0., y, z]);
    for (x0, y0, x1, y1, z0, z1, out) in [
        (0.0, 0.0, x, y, 0.0, z, true),
        (wall, wall, hi_x, hi_y, 0.0, hi_z, false),
    ] {
        let sides = [
            ([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]),
            ([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
            ([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]),
            ([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]),
        ];
        for (a, b, c, d) in sides {
            if out {
                quad(&mut f, a, b, c, d);
            } else {
                quad(&mut f, d, c, b, a);
            }
        }
    }
    quad(
        &mut f,
        [wall, wall, hi_z],
        [wall, hi_y, hi_z],
        [hi_x, hi_y, hi_z],
        [hi_x, wall, hi_z],
    );
    let o = [[0., 0.], [x, 0.], [x, y], [0., y]];
    let i = [[wall, wall], [hi_x, wall], [hi_x, hi_y], [wall, hi_y]];
    for k in 0..4 {
        let n = (k + 1) % 4;
        let p = |q: [f64; 2]| [q[0], q[1], 0.0];
        quad(&mut f, p(o[k]), p(i[k]), p(i[n]), p(o[n]));
    }
    f
}

/// The box from `lo` to `hi`, a closed shell of its own.
fn box_facets(out: &mut Vec<[P; 3]>, lo: P, hi: P) {
    let ([x0, y0, z0], [x1, y1, z1]) = (lo, hi);
    quad(out, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    quad(out, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    quad(out, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
    quad(out, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
    quad(out, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    quad(out, [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
}

/// The vertical cylinder of `radius` round `at`, from `z0` to `z1`, a closed
/// shell of its own.
fn cylinder_facets(out: &mut Vec<[P; 3]>, at: [f64; 2], radius: f64, z0: f64, z1: f64) {
    const SIDES: usize = 48;
    let ring = |k: usize, z: f64| {
        let a = k as f64 * std::f64::consts::TAU / SIDES as f64;
        [at[0] + radius * a.cos(), at[1] + radius * a.sin(), z]
    };
    for k in 0..SIDES {
        let n = k + 1;
        quad(out, ring(k, z0), ring(n, z0), ring(n, z1), ring(k, z1));
        out.push([[at[0], at[1], z1], ring(k, z1), ring(n, z1)]);
        out.push([[at[0], at[1], z0], ring(n, z0), ring(k, z0)]);
    }
}

/// Ribs across the short side of the ribbed cover: where each starts along Y.
const RIB_Y: [f64; 4] = [60.0, 120.0, 180.0, 240.0];
const RIB_MM: f64 = 3.0;
const RIB_TOP_MM: f64 = 20.0;
const BOSS_RADIUS_MM: f64 = 5.0;

/// Where the bosses of the ribbed cover stand: on the diagonal of each
/// corner, 6 mm in from the wall, so each overlaps the wall band.
const BOSSES: [[f64; 2]; 4] = [
    [13.03, 13.03],
    [136.97, 13.03],
    [13.03, 286.97],
    [136.97, 286.97],
];

/// `round_cover_stl(150, 300, 50, 3, 30)` with four ribs, 3 mm thick and 20
/// mm tall, across its short side, and a 10 mm boss in each corner. All of
/// them are joined to the wall band, so the solid between the perimeters is
/// one island that is thin along the walls and the ribs and wide at the
/// bosses.
fn ribbed_cover_stl() -> String {
    let mut f = round_cover_facets(150.0, 300.0, 50.0, 3.0, 30.0);
    for y in RIB_Y {
        box_facets(&mut f, [1.5, y, 0.0], [148.5, y + RIB_MM, RIB_TOP_MM]);
    }
    for at in BOSSES {
        cylinder_facets(&mut f, at, BOSS_RADIUS_MM, 0.0, 48.0);
    }
    stl_text(&f)
}

/// The outline of a `x` by `y` box with its corners rounded to `radius`,
/// shrunk by `inset` on every side.
fn rounded_ring(x: f64, y: f64, radius: f64, inset: f64) -> Vec<[f64; 2]> {
    let mut pts = Vec::new();
    for (corner, (cx, cy)) in [
        (0, (x - radius, y - radius)),
        (1, (radius, y - radius)),
        (2, (radius, radius)),
        (3, (x - radius, radius)),
    ] {
        for k in 0..=12 {
            let a = (corner as f64 * 90.0 + k as f64 * 7.5).to_radians();
            pts.push([
                cx + (radius - inset) * a.cos(),
                cy + (radius - inset) * a.sin(),
            ]);
        }
    }
    pts
}

/// `cover_stl` with its corners rounded to `radius`, so its walls bend and the
/// strips of solid between the perimeters change width along their length.
fn round_cover_stl(x: f64, y: f64, z: f64, wall: f64, radius: f64) -> String {
    stl_text(&round_cover_facets(x, y, z, wall, radius))
}

fn round_cover_facets(x: f64, y: f64, z: f64, wall: f64, radius: f64) -> Vec<[P; 3]> {
    let (outer, inner) = (
        rounded_ring(x, y, radius, 0.0),
        rounded_ring(x, y, radius, wall),
    );
    let at = |q: [f64; 2], h: f64| [q[0], q[1], h];
    let (middle, hi_z) = ([x / 2.0, y / 2.0], z - wall);
    let mut f: Vec<[P; 3]> = Vec::new();
    for k in 0..outer.len() {
        let n = (k + 1) % outer.len();
        let (o0, o1, i0, i1) = (outer[k], outer[n], inner[k], inner[n]);
        quad(&mut f, at(o0, 0.0), at(o1, 0.0), at(o1, z), at(o0, z));
        quad(&mut f, at(i1, 0.0), at(i0, 0.0), at(i0, hi_z), at(i1, hi_z));
        quad(&mut f, at(o0, 0.0), at(i0, 0.0), at(i1, 0.0), at(o1, 0.0));
        f.push([at(o0, z), at(o1, z), at(middle, z)]);
        f.push([at(i1, hi_z), at(i0, hi_z), at(middle, hi_z)]);
    }
    f
}

fn stl_text(facets: &[[P; 3]]) -> String {
    let mut s = String::from("solid cover\n");
    for t in facets {
        s.push_str("facet normal 0 0 0\nouter loop\n");
        for v in t {
            s.push_str(&format!("vertex {} {} {}\n", v[0], v[1], v[2]));
        }
        s.push_str("endloop\nendfacet\n");
    }
    s.push_str("endsolid cover\n");
    s
}

/// What the solid infill did: the estimator's mean volumetric rate over all
/// layers, and the extruded solid moves (G-code columns) of the mid layers.
struct Solid {
    mm3_s: f64,
    mean_move_mm: f64,
}

fn cover_reply(belt: bool, stl: &str) -> SliceResponse {
    let mut body = json!({
        "filename": "cover.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "blend": {"mode": "single", "strategy": "speed"},
        "walls": 2,
        "infill": 1.0,
        "arcFit": false,
        "baseline": false,
        "compare": false,
        "supports": false,
        "includePreview": false,
        "includeGcode": true,
        "printer": {
            "name": "cover test",
            "nozzleDiameter": 0.4,
            "filamentDiameter": 1.75,
            "nozzleTemp": 215.0,
            "bedTemp": 60.0,
            "bedX": 250.0,
            "bedY": 250.0,
            "maxVolumetricMm3S": 12.0,
            "maxAccel": 7000.0,
        },
    });
    if belt {
        body["belt"] = json!({
            "angleDeg": 45.0, "axis": "z", "direction": 1, "widthMm": 250.0,
            "copies": 1, "gapMm": 5.0, "floorSupports": true,
        });
    }
    let request: SliceRequest = serde_json::from_value(body).unwrap();
    slice_request(&request, Job::default()).unwrap()
}

fn solid_infill(belt: bool) -> Solid {
    let reply = cover_reply(belt, &cover_stl(150.0, 300.0, 50.0, 3.0));
    // Cartesian mid layers are all wall strips. A belt layer cuts the walls
    // aslant, so every belt layer is.
    let (mut layer_z, mut solid) = (0.0, false);
    let (mut x, mut y, mut e) = (0.0f64, 0.0f64, 0.0f64);
    let (mut moves, mut length) = (0usize, 0.0);
    for line in reply.gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            layer_z = rest
                .split("Z:")
                .nth(1)
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap()
                .parse()
                .unwrap();
        } else if let Some(kind) = line.strip_prefix("; TYPE:") {
            solid = kind.trim() == "SOLID";
        } else if line.starts_with("G1") {
            let word = |c: char| {
                line.split_whitespace()
                    .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
            };
            let (nx, ny, ne) = (
                word('X').unwrap_or(x),
                word('Y').unwrap_or(y),
                word('E').unwrap_or(e),
            );
            let mid = belt || (10.0..40.0).contains(&layer_z);
            if solid && mid && ne > e && (word('X').is_some() || word('Y').is_some()) {
                moves += 1;
                length += (nx - x).hypot(ny - y);
            }
            (x, y, e) = (nx, ny, ne);
        }
    }
    let row = reply
        .estimate
        .by_feature
        .iter()
        .find(|f| f.kind == "solid")
        .unwrap();
    let volume = row.filament_mm * std::f64::consts::PI * 0.875f64.powi(2);
    let found = Solid {
        mm3_s: volume / row.seconds,
        mean_move_mm: length / moves as f64,
    };
    println!(
        "belt {belt}: solid {:.0} s, {:.1} cm3, {:.2} mm3/s, {moves} moves, mean {:.2} mm",
        row.seconds,
        volume / 1000.0,
        found.mm3_s,
        found.mean_move_mm
    );
    found
}

#[test]
fn solid_strips_of_a_cover_print_along_their_length() {
    let tilted = solid_infill(true);
    let flat = solid_infill(false);
    assert!(
        flat.mean_move_mm >= 20.0,
        "flat cover: mean solid move {:.2} mm, {:.2} mm3/s",
        flat.mean_move_mm,
        flat.mm3_s
    );
    assert!(
        tilted.mm3_s >= 8.0,
        "belt cover: {:.2} mm3/s, mean solid move {:.2} mm",
        tilted.mm3_s,
        tilted.mean_move_mm
    );
}

/// The G-code's moves that do not extrude, by the `; TYPE:` they come under:
/// count and length in mm.
struct Travels {
    by_kind: BTreeMap<String, (usize, f64)>,
    seconds: f64,
    /// All the filament the print takes, mm.
    filament_mm: f64,
    /// Solid extruded between Z 10 and 40, mm3, and the layers that holds.
    mid_solid_mm3: f64,
    mid_layers: usize,
    /// Solid and gap fill extruded in `WINDOWS`, mm3, and the layers each holds.
    window_mm3: [f64; 2],
    window_layers: [usize; 2],
    /// The solid hops in `WINDOWS`.
    window_hops: [usize; 2],
}

/// Z bands of a flat ribbed cover: ribs and bosses, then bosses alone. Both
/// keep clear of the skins at the rib tops and the floor.
const WINDOWS: [(f64, f64); 2] = [(5.0, 15.0), (25.0, 40.0)];

impl Travels {
    fn moves(&self) -> usize {
        self.by_kind.values().map(|v| v.0).sum()
    }
}

fn travels(belt: bool) -> Travels {
    travels_of(belt, &round_cover_stl(150.0, 300.0, 50.0, 3.0, 30.0))
}

fn travels_of(belt: bool, stl: &str) -> Travels {
    let reply = cover_reply(belt, stl);
    let (mut window_mm3, mut window_layers, mut window_hops) = ([0.0; 2], [0usize; 2], [0usize; 2]);
    let mut by_kind: BTreeMap<String, (usize, f64)> = BTreeMap::new();
    let (mut kind, mut x, mut y, mut e) = (String::new(), 0.0f64, 0.0f64, 0.0f64);
    let mut retracts = 0;
    let (mut layer_z, mut mid_solid_mm3, mut mid_layers) = (0.0, 0.0, 0);
    for line in reply.gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            layer_z = rest
                .split("Z:")
                .nth(1)
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap()
                .parse()
                .unwrap();
            mid_layers += usize::from((10.0..40.0).contains(&layer_z));
            for (k, (lo, hi)) in WINDOWS.iter().enumerate() {
                window_layers[k] += usize::from((*lo..*hi).contains(&layer_z));
            }
        } else if let Some(rest) = line.strip_prefix("; TYPE:") {
            kind = rest.trim().to_string();
        } else if line.starts_with("G1") {
            let word = |c: char| {
                line.split_whitespace()
                    .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
            };
            let (nx, ny, ne) = (
                word('X').unwrap_or(x),
                word('Y').unwrap_or(y),
                word('E').unwrap_or(e),
            );
            if word('X').is_none() && word('Y').is_none() {
                retracts += usize::from(ne < e);
            } else if ne <= e {
                let row = by_kind.entry(kind.clone()).or_default();
                row.0 += 1;
                row.1 += (nx - x).hypot(ny - y);
                if kind == "SOLID" {
                    for (k, (lo, hi)) in WINDOWS.iter().enumerate() {
                        window_hops[k] += usize::from((*lo..*hi).contains(&layer_z));
                    }
                }
            } else {
                if kind == "SOLID" && (10.0..40.0).contains(&layer_z) {
                    mid_solid_mm3 += (ne - e) * FILAMENT_AREA_MM2;
                }
                if kind == "SOLID" || kind == "GAP-FILL" {
                    for (k, (lo, hi)) in WINDOWS.iter().enumerate() {
                        if (*lo..*hi).contains(&layer_z) {
                            window_mm3[k] += (ne - e) * FILAMENT_AREA_MM2;
                        }
                    }
                }
            }
            (x, y, e) = (nx, ny, ne);
        }
    }
    let seconds = reply
        .estimate
        .by_feature
        .iter()
        .find(|f| f.kind == "travel")
        .map_or(0.0, |f| f.seconds);
    let found = Travels {
        by_kind,
        seconds,
        filament_mm: reply.estimate.filament_mm,
        mid_solid_mm3,
        mid_layers,
        window_mm3,
        window_layers,
        window_hops,
    };
    println!(
        "  bands: {:.1} mm3 and {} solid hops over {} layers, {:.1} mm3 and {} over {}",
        found.window_mm3[0],
        found.window_hops[0],
        found.window_layers[0],
        found.window_mm3[1],
        found.window_hops[1],
        found.window_layers[1]
    );
    println!(
        "belt {belt}: {} travel moves, {:.0} s travel, {retracts} retracts, {:.0} s and {:.1} g ({:.2} mm) in all, mid solid {:.1} mm3 over {} layers",
        found.moves(),
        found.seconds,
        reply.estimate.seconds,
        reply.estimate.filament_g,
        found.filament_mm,
        found.mid_solid_mm3,
        found.mid_layers
    );
    for (kind, (n, mm)) in &found.by_kind {
        println!("  {kind}: {n} moves, {:.1} m", mm / 1000.0);
    }
    found
}

#[test]
fn gap_fill_of_a_rounded_cover_prints_beside_its_solid() {
    // The gap fill beside the strips was ordered as a run of its own after
    // the solid, so it toured the whole cover: hops of 100 to 250 m between
    // corner beads, 96 m of travel on the flat cover.
    let tilted = travels(true);
    let flat = travels(false);
    let gap_fill_m = |t: &Travels| t.by_kind["GAP-FILL"].1 / 1000.0;
    assert!(
        gap_fill_m(&flat) <= 20.0 && gap_fill_m(&tilted) <= 25.0,
        "gap fill travels {:.1} m flat, {:.1} m on the belt",
        gap_fill_m(&flat),
        gap_fill_m(&tilted)
    );
    assert!(
        flat.seconds <= 1150.0,
        "flat cover: {:.0} s travelling, {} travel moves",
        flat.seconds,
        flat.moves()
    );
    assert!(
        tilted.seconds <= 1950.0,
        "belt cover: {:.0} s travelling, {} travel moves",
        tilted.seconds,
        tilted.moves()
    );
}

/// The area of a 150 x 300 mm rounded box shrunk by `inset` on every side,
/// its corners 30 mm in radius before the shrink.
fn rounded_box_mm2(inset: f64) -> f64 {
    let r = 30.0 - inset;
    (150.0 - 2.0 * inset) * (300.0 - 2.0 * inset) - (4.0 - std::f64::consts::PI) * r * r
}

#[test]
fn solid_in_the_wall_of_a_rounded_cover_follows_the_strip() {
    // On 4a6d8e1 the strip of each layer was a hundred short rows, all linked
    // by hops: 41441 solid hops on the flat cover and 34045 on the belt, with
    // 966 s and 1875 s of travel. Loops along the strip print it in a few.
    let (before_flat, before_belt) = (41441, 34045);
    let (flat_mm, belt_mm) = (106907.44, 103488.74);
    let flat = travels(false);
    let tilted = travels(true);
    let hops = |t: &Travels| t.by_kind["SOLID"].0;
    assert!(
        hops(&flat) * 3 <= before_flat && hops(&tilted) * 3 <= before_belt,
        "solid hops: {} flat (was {before_flat}), {} on the belt (was {before_belt})",
        hops(&flat),
        hops(&tilted)
    );
    assert!(
        flat.seconds <= 400.0 && tilted.seconds <= 1600.0,
        "travel: {:.0} s flat (was 966), {:.0} s on the belt (was 1875)",
        flat.seconds,
        tilted.seconds
    );
    // The strip is filled to its area: the mid layers' solid extrudes the
    // strip times the layer height. The rows it had overlapped by 12%.
    let strip = (rounded_box_mm2(0.9) - rounded_box_mm2(2.1)) * 0.2 * flat.mid_layers as f64;
    assert!(
        (flat.mid_solid_mm3 / strip - 1.0).abs() <= 0.01,
        "flat mid layers: {:.0} mm3 of solid for a strip of {strip:.0} mm3",
        flat.mid_solid_mm3
    );
    // The print takes no more plastic than the strips ask for. The rows
    // overfilled the flat cover by 2.3% of its plastic and left the belt
    // cover's 2% short, so the files move that far and no more.
    assert!(
        (flat.filament_mm / flat_mm - 1.0).abs() <= 0.03
            && flat.filament_mm <= flat_mm * 1.005
            && (tilted.filament_mm / belt_mm - 1.0).abs() <= 0.02,
        "filament {:.0} mm flat (was {flat_mm}), {:.0} mm on the belt (was {belt_mm})",
        flat.filament_mm,
        tilted.filament_mm
    );
}

/// The area of the interior of the ribbed cover's layer, in mm2: where the
/// solid goes, inside two walls of the contour. The ribs are in the layer
/// below `RIB_TOP_MM` only.
fn ribbed_interior_mm2(ribs: bool) -> f64 {
    let rect = |x0: f64, y0: f64, x1: f64, y1: f64| vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1)];
    let mut cutters: Vec<Vec<(f64, f64)>> = Vec::new();
    if ribs {
        cutters.extend(RIB_Y.map(|y| rect(1.5, y, 148.5, y + RIB_MM)));
    }
    for [x, y] in BOSSES {
        cutters.push(
            (0..48)
                .map(|k| {
                    let a = k as f64 * std::f64::consts::TAU / 48.0;
                    (x + BOSS_RADIUS_MM * a.cos(), y + BOSS_RADIUS_MM * a.sin())
                })
                .collect(),
        );
    }
    let ring = |inset: f64| -> Vec<(f64, f64)> {
        let pts = rounded_ring(150.0, 300.0, 30.0, inset);
        pts.iter().map(|p| (p[0], p[1])).collect()
    };
    let pocket: Paths<Milli> = vec![ring(3.0)].into();
    let outer: Paths<Milli> = vec![ring(0.0)].into();
    let air = pocket
        .to_clipper_subject()
        .add_clip(Paths::<Milli>::from(cutters))
        .difference(FillRule::NonZero)
        .unwrap();
    let part = outer
        .to_clipper_subject()
        .add_clip(air)
        .difference(FillRule::NonZero)
        .unwrap();
    let inside: Vec<Vec<(f64, f64)>> = part
        .inflate(-0.9, JoinType::Square, EndType::Polygon, 2.0)
        .into();
    inside
        .iter()
        .map(|l| {
            (0..l.len())
                .map(|i| {
                    let (p, q) = (l[i], l[(i + 1) % l.len()]);
                    p.0 * q.1 - q.0 * p.1
                })
                .sum::<f64>()
                * 0.5
        })
        .sum::<f64>()
        .abs()
}

#[test]
fn solid_where_a_thin_band_joins_wide_parts_follows_the_band() {
    // On da4af97 the solid between the perimeters was one island, ribs and
    // bosses and all, and the bosses made it wider than three beads, so all
    // of it printed as rows: 62313 solid hops on the flat cover and 43158 on
    // the belt, 1949 s and 1914 s of travel, and 10 to 11% more solid than
    // the island holds. The bosses' own rows (about 70 a layer) stay.
    let stl = ribbed_cover_stl();
    let flat = travels_of(false, &stl);
    let tilted = travels_of(true, &stl);
    let (band_hops, belt_hops) = ([11939, 14863], 43158);
    assert!(
        (0..2).all(|k| flat.window_hops[k] * 5 <= band_hops[k] * 2),
        "solid hops in the bands: {:?} flat (was {band_hops:?})",
        flat.window_hops
    );
    assert!(
        tilted.by_kind["SOLID"].0 * 100 <= belt_hops * 65,
        "solid hops on the belt: {} (was {belt_hops})",
        tilted.by_kind["SOLID"].0
    );
    assert!(
        flat.seconds <= 1300.0 && tilted.seconds <= 1700.0,
        "travel: {:.0} s flat (was 1949), {:.0} s on the belt (was 1914)",
        flat.seconds,
        tilted.seconds
    );
    // The island is filled to its area: solid and gap fill extrude the
    // interior times the layer height, where the rows overfilled it by 10%.
    for (k, with_ribs) in [true, false].into_iter().enumerate() {
        let want = ribbed_interior_mm2(with_ribs) * 0.2 * flat.window_layers[k] as f64;
        assert!(
            (flat.window_mm3[k] / want - 1.0).abs() <= 0.015,
            "flat band {k}: {:.0} mm3 of solid and gap fill for an interior of {want:.0} mm3",
            flat.window_mm3[k]
        );
    }
    // The print takes about the plastic it did: the rows overfilled the flat
    // cover and left the belt cover short.
    let (flat_mm, belt_mm) = (127174.0, 123827.0);
    assert!(
        (flat.filament_mm / flat_mm - 1.0).abs() <= 0.03
            && (tilted.filament_mm / belt_mm - 1.0).abs() <= 0.02,
        "filament {:.0} mm flat (was {flat_mm}), {:.0} mm on the belt (was {belt_mm})",
        flat.filament_mm,
        tilted.filament_mm
    );
}
