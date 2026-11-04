use super::*;
use crate::text::{lay_out, Align, Contour, Spec};
use std::f64::consts::{FRAC_PI_2, PI, TAU};

fn laid(text: &str, height: f64) -> Vec<GlyphFace> {
    lay_out(&Spec {
        text: text.into(),
        font: "sans".into(),
        style: None,
        height,
        spacing: None,
        line_spacing: None,
        align: Align::Centre,
        angle_deg: 0.0,
    })
    .unwrap()
    .faces
}

/// A ball of radius `r` about `c`: u is the longitude, v the latitude. Su x Sv looks out.
struct Ball {
    c: V3,
    r: f64,
}

impl Surf for Ball {
    fn d1(&self, u: f64, v: f64) -> Option<(V3, V3, V3)> {
        if v.abs() > FRAC_PI_2 + 1e-9 {
            return None;
        }
        let (su, cu) = u.sin_cos();
        let (sv, cv) = v.sin_cos();
        let p = add(self.c, mul([cv * cu, cv * su, sv], self.r));
        let du = mul([-cv * su, cv * cu, 0.0], self.r);
        let dv = mul([-sv * cu, -sv * su, cv], self.r);
        Some((p, du, dv))
    }
}

/// A torus about Z with the tube radius `minor` and the ring radius `major`. u runs round the ring, v round the tube.
struct Ring {
    major: f64,
    minor: f64,
}

impl Surf for Ring {
    fn d1(&self, u: f64, v: f64) -> Option<(V3, V3, V3)> {
        let (su, cu) = u.sin_cos();
        let (sv, cv) = v.sin_cos();
        let reach = self.major + self.minor * cv;
        let p = [reach * cu, reach * su, self.minor * sv];
        let du = [-reach * su, reach * cu, 0.0];
        let dv = [-self.minor * sv * cu, -self.minor * sv * su, self.minor * cv];
        Some((p, du, dv))
    }
}

/// A wavy sheet z = A sin(wx) sin(wy) over x in 0..120, y in 0..60, with the plain (x, y) for (u, v).
struct Wavy;
const WAVE: f64 = 2.0;
const OMEGA: f64 = TAU / 40.0;

impl Surf for Wavy {
    fn d1(&self, u: f64, v: f64) -> Option<(V3, V3, V3)> {
        if !(-1e-9..=120.0 + 1e-9).contains(&u) || !(-1e-9..=60.0 + 1e-9).contains(&v) {
            return None;
        }
        let z = WAVE * (OMEGA * u).sin() * (OMEGA * v).sin();
        let zx = WAVE * OMEGA * (OMEGA * u).cos() * (OMEGA * v).sin();
        let zy = WAVE * OMEGA * (OMEGA * u).sin() * (OMEGA * v).cos();
        Some(([u, v, z], [1.0, 0.0, zx], [0.0, 1.0, zy]))
    }
}

fn ball_info(u0: f64, v0: f64) -> SkinInfo {
    SkinInfo {
        kind: "sphere".into(),
        sigma: 1.0,
        u0,
        v0,
        u_min: 0.0,
        u_max: TAU,
        v_min: -FRAC_PI_2,
        v_max: FRAC_PI_2,
        u_period: TAU,
        v_period: 0.0,
        full_u: true,
        full_v: false,
    }
}

fn ring_info(u0: f64, v0: f64) -> SkinInfo {
    SkinInfo {
        kind: "torus".into(),
        sigma: 1.0,
        u0,
        v0,
        u_min: 0.0,
        u_max: TAU,
        v_min: 0.0,
        v_max: TAU,
        u_period: TAU,
        v_period: TAU,
        full_u: true,
        full_v: true,
    }
}

fn wavy_info(u0: f64, v0: f64) -> SkinInfo {
    SkinInfo {
        kind: "freeform".into(),
        sigma: 1.0,
        u0,
        v0,
        u_min: 0.0,
        u_max: 120.0,
        v_min: 0.0,
        v_max: 60.0,
        u_period: 0.0,
        v_period: 0.0,
        full_u: false,
        full_v: false,
    }
}

fn at(surf: &dyn Surf, uv: P) -> V3 {
    surf.d1(uv[0], uv[1]).expect("on the surface").0
}

/// Every control point of every loop of `faces`, in order.
fn points(faces: &[GlyphFace]) -> Vec<P> {
    let mut out = Vec::new();
    for face in faces {
        for c in std::iter::once(&face.outer).chain(face.holes.iter()) {
            out.push(c.start);
            for seg in &c.segs {
                out.push(match *seg {
                    Seg::Line(p) | Seg::Quad(_, p) | Seg::Cubic(_, _, p) => p,
                });
            }
        }
    }
    out
}

/// The corner points of the letters: every end point of every outline piece, in layout and mapped, which stay paired.
fn pairs(layout: &[GlyphFace], mapped: &[GlyphFace], surf: &dyn Surf) -> Vec<(P, V3)> {
    // The mapping cuts long pieces, so pair the layout's points with the mapped loops' start points of the same loop: the starts are
    // the layout's starts mapped. Then every piece end of a straight-lined letter is a layout end, in the same order.
    let mut out = Vec::new();
    for (a, b) in layout.iter().zip(mapped.iter()) {
        let pairs = std::iter::once((&a.outer, &b.outer)).chain(a.holes.iter().zip(b.holes.iter()));
        for (la, lb) in pairs {
            out.push((la.start, at(surf, lb.start)));
        }
    }
    out
}

/// The worst difference between a distance in the layout and the distance between the same two points on the surface, as a share of
/// the layout's, over every pair of points at least `min` apart.
fn worst_size_error(pairs: &[(P, V3)], min: f64) -> f64 {
    let mut worst = 0.0f64;
    for (i, (p, a)) in pairs.iter().enumerate() {
        for (q, b) in pairs.iter().skip(i + 1) {
            let flat = (p[0] - q[0]).hypot(p[1] - q[1]);
            if flat < min {
                continue;
            }
            worst = worst.max((len(sub(*a, *b)) - flat).abs() / flat);
        }
    }
    worst
}

/// The letters' outlines mapped by the placer point for point, for the sizes: the layout's flattened points against the surface's,
/// over the pairs of points between 1 and 1.5 mm apart (a longer chord is shorter than its arc by the curve, which is not stretch).
fn size_error_of(layout: &[GlyphFace], placer: &Placer, surf: &dyn Surf) -> f64 {
    let mut worst = 0.0f64;
    for face in layout {
        let flat = face.outer.flatten(0.5);
        let on: Vec<V3> = flat.iter().map(|p| at(surf, placer.map(*p).unwrap())).collect();
        for i in 0..flat.len() {
            for j in (i + 1)..flat.len() {
                let d = (flat[i][0] - flat[j][0]).hypot(flat[i][1] - flat[j][1]);
                if !(1.0..=1.5).contains(&d) {
                    continue;
                }
                worst = worst.max((len(sub(on[i], on[j])) - d).abs() / d);
            }
        }
    }
    worst
}

fn extent(layout: &[GlyphFace]) -> (f64, f64) {
    let b = bounds_of(layout).unwrap();
    (b[0] - 1.0, b[2] + 1.0)
}

#[test]
fn the_baseline_keeps_its_length_on_a_sphere() {
    // Walking x along the baseline is x of arc on the surface: the chord is 2 R sin(x / 2R).
    let ball = Ball { c: [5.0, -3.0, 2.0], r: 30.0 };
    let info = ball_info(1.0, 0.4);
    let placer = Placer::new(&ball, &info, SkinHow::default(), -60.0, 60.0).unwrap();
    let origin = at(&ball, placer.map([0.0, 0.0]).unwrap());
    for x in [-55.0, -20.0, -3.3, 7.0, 40.0, 58.0] {
        let chord = len(sub(at(&ball, placer.map([x, 0.0]).unwrap()), origin));
        let arc = 2.0 * 30.0 * (x.abs() / 60.0).sin();
        assert!((chord - arc).abs() < 1e-3 * arc.max(1.0), "x {x}: {chord} vs {arc}");
    }
    // And square to the baseline, y of arc as well.
    for y in [-9.0, 4.0, 12.0] {
        let chord = len(sub(at(&ball, placer.map([0.0, y]).unwrap()), origin));
        let arc = 2.0 * 30.0 * (y.abs() / 60.0).sin();
        assert!((chord - arc).abs() < 1e-3 * arc, "y {y}: {chord} vs {arc}");
    }
}

#[test]
fn the_baseline_starts_along_u_or_v_and_turns_with_the_angle() {
    let ball = Ball { c: [0.0; 3], r: 30.0 };
    let info = ball_info(0.0, 0.0);
    let dir = |how: SkinHow| {
        let placer = Placer::new(&ball, &info, how, -5.0, 5.0).unwrap();
        let a = at(&ball, placer.map([0.0, 0.0]).unwrap());
        unit(sub(at(&ball, placer.map([1.0, 0.0]).unwrap()), a))
    };
    // At (0, 0) on the equator u runs along +Y, v runs up +Z, the surface looks along +X. Up in the world is +Z, so reading
    // along u goes towards +Y and along v would read sideways-up: turned so that the text's up is +Z-ish or kept.
    let u = dir(SkinHow::default());
    assert!(u[1].abs() > 0.99, "{u:?}");
    let v = dir(SkinHow { v_first: true, ..SkinHow::default() });
    assert!(v[2].abs() > 0.99, "{v:?}");
    // A flip reverses it, 90 degrees turns it to the surface's other way.
    let flipped = dir(SkinHow { flip: true, ..SkinHow::default() });
    assert!((dot(u, flipped) + 1.0).abs() < 2e-3);
    let turned_up = dir(SkinHow { angle_deg: 90.0, ..SkinHow::default() });
    assert!(dot(u, turned_up).abs() < 1e-3 && turned_up[2].abs() > 0.99, "{turned_up:?}");
}

#[test]
fn the_letters_read_from_the_side_the_face_looks_to_whichever_way_it_was_made() {
    // sigma -1 is a face whose normal is the other way: a bowl, read from inside.
    for sigma in [1.0, -1.0] {
        let ball = Ball { c: [0.0; 3], r: 25.0 };
        let mut info = ball_info(0.7, 0.2);
        info.sigma = sigma;
        let placer = Placer::new(&ball, &info, SkinHow::default(), -10.0, 10.0).unwrap();
        let o = at(&ball, placer.map([0.0, 0.0]).unwrap());
        let right = sub(at(&ball, placer.map([1.0, 0.0]).unwrap()), o);
        let up = sub(at(&ball, placer.map([0.0, 1.0]).unwrap()), o);
        let facing = mul(unit(o), sigma);
        assert!(dot(cross(right, up), facing) > 0.0, "sigma {sigma}");
        // Upright: the text's up has the world's up in it.
        assert!(up[2] > 0.0, "sigma {sigma}: up {up:?}");
    }
}

#[test]
fn letters_keep_their_size_within_two_percent_on_a_sphere() {
    // 6 mm capitals, two lines, on a sphere of R 30 away from the equator: the plan's tolerance.
    let layout = laid("HAg", 6.0);
    let ball = Ball { c: [0.0; 3], r: 30.0 };
    let info = ball_info(2.0, 0.7);
    let (lo, hi) = extent(&layout);
    let placer = Placer::new(&ball, &info, SkinHow::default(), lo, hi).unwrap();
    let worst = size_error_of(&layout, &placer, &ball);
    assert!(worst < TOLERANCE, "worst size error {worst}");
    // And the whole check agrees: laying it out is accepted.
    lay(&layout, &info, &ball, SkinHow::default(), 0.8, false).unwrap();
}

#[test]
fn letters_keep_their_size_on_a_torus_outside_and_inside() {
    // Capitals only: a descender sits 4.5 mm from the baseline, where a tube of radius 10 has shrunk the line by 2.5 %.
    let layout = laid("HAE", 6.0);
    let ring = Ring { major: 30.0, minor: 10.0 };
    // The outer equator (v = 0), the top of the tube (v = pi/2) and the inner side (v = pi), where the surface is a saddle.
    for v0 in [0.0, FRAC_PI_2, PI] {
        let info = ring_info(1.0, v0);
        let (lo, hi) = extent(&layout);
        let placer = Placer::new(&ring, &info, SkinHow::default(), lo, hi).unwrap();
        let worst = size_error_of(&layout, &placer, &ring);
        assert!(worst < TOLERANCE, "v0 {v0}: worst size error {worst}");
    }
}

#[test]
fn letters_keep_their_size_on_a_wavy_sheet() {
    let layout = laid("HAg", 6.0);
    let info = wavy_info(30.0, 20.0);
    let (lo, hi) = extent(&layout);
    let placer = Placer::new(&Wavy, &info, SkinHow::default(), lo, hi).unwrap();
    let worst = size_error_of(&layout, &placer, &Wavy);
    assert!(worst < TOLERANCE, "worst size error {worst}");
    let wrapped = lay(&layout, &info, &Wavy, SkinHow::default(), 0.8, false).unwrap();
    assert!(!wrapped.crosses_seam);
}

#[test]
fn mapped_loops_are_closed_and_run_the_right_way_round() {
    let layout = laid("AO8", 6.0);
    let ball = Ball { c: [0.0; 3], r: 30.0 };
    for sigma in [1.0, -1.0] {
        let mut info = ball_info(2.0, 0.3);
        info.sigma = sigma;
        let wrapped = lay(&layout, &info, &ball, SkinHow::default(), 0.8, false).unwrap();
        for face in &wrapped.faces {
            let signed = |c: &Contour| crate::text::area(&c.flatten(0.05));
            assert!(signed(&face.outer) > 0.0);
            assert!(face.holes.iter().all(|h| signed(h) < 0.0));
            for c in std::iter::once(&face.outer).chain(face.holes.iter()) {
                let last = match c.segs.last().unwrap() {
                    Seg::Line(p) | Seg::Quad(_, p) | Seg::Cubic(_, _, p) => *p,
                };
                assert_eq!(last, c.start);
            }
        }
    }
}

#[test]
fn a_second_line_stands_square_to_the_first_by_arc_length() {
    // The lines of a text are equidistant curves of the baseline: every point of line 2 is as far from the baseline as the layout
    // says, along a geodesic square to it.
    let ball = Ball { c: [0.0; 3], r: 30.0 };
    let info = ball_info(0.0, 0.0);
    let placer = Placer::new(&ball, &info, SkinHow::default(), -20.0, 20.0).unwrap();
    for x in [-15.0, 0.0, 12.0] {
        let on_line = at(&ball, placer.map([x, 0.0]).unwrap());
        let above = at(&ball, placer.map([x, 7.8]).unwrap());
        let chord = len(sub(above, on_line));
        let arc = 2.0 * 30.0 * (7.8f64 / 60.0).sin();
        assert!((chord - arc).abs() < 1e-3, "x {x}: {chord} vs {arc}");
    }
}

#[test]
fn a_text_across_a_pole_is_refused() {
    let layout = laid("LIME", 6.0);
    let ball = Ball { c: [0.0; 3], r: 30.0 };
    // The anchor is a hair from the north pole.
    let info = ball_info(1.0, FRAC_PI_2 - 0.01);
    let err = lay(&layout, &info, &ball, SkinHow::default(), 0.8, false).unwrap_err();
    assert!(err.contains("pole of this sphere"), "{err}");
    // A text whose baseline runs over the pole from a little way off is refused too.
    let info = ball_info(1.0, FRAC_PI_2 - 0.12);
    let err = lay(&laid("LIME SLICE", 6.0), &info, &ball, SkinHow { v_first: true, ..SkinHow::default() }, 0.8, false).unwrap_err();
    assert!(err.contains("pole") || err.contains("longer") || err.contains("runs off"), "{err}");
}

#[test]
fn a_text_longer_than_the_way_round_is_refused_with_the_length() {
    let ball = Ball { c: [0.0; 3], r: 10.0 };
    let info = ball_info(0.0, 0.0);
    let err = lay(&laid("LIME SLICE 2026 LIME SLICE 2026", 6.0), &info, &ball, SkinHow::default(), 0.5, false).unwrap_err();
    assert!(
        err.starts_with("The text is longer than the way round this sphere (62.8 mm)."),
        "{err}"
    );
}

#[test]
fn text_off_the_edge_of_a_freeform_face_is_refused() {
    let layout = laid("LIME SLICE", 6.0);
    // Near the end of the sheet: the baseline walks off it.
    let info = wavy_info(112.0, 30.0);
    let err = lay(&layout, &info, &Wavy, SkinHow::default(), 0.8, false).unwrap_err();
    assert_eq!(err, OFF_FACE);
    // The same text well inside is fine.
    let inside = wavy_info(60.0, 30.0);
    let (lo, hi) = extent(&layout);
    let placer = Placer::new(&Wavy, &inside, SkinHow::default(), lo, hi).unwrap();
    for p in points(&layout) {
        placer.map(p).unwrap_or_else(|e| panic!("map {p:?}: {e}"));
    }
    for x in [-20.0, 0.0, 20.0] {
        for y in [-3.0, 0.0, 3.0] {
            placer.stretch(x, y).unwrap_or_else(|e| panic!("stretch {x} {y}: {e:?}"));
        }
    }
    lay(&layout, &inside, &Wavy, SkinHow::default(), 0.8, false).unwrap();
}

#[test]
fn a_letter_too_deep_for_the_curve_is_refused_with_the_depth_that_works() {
    let layout = laid("I", 3.0);
    let ball = Ball { c: [0.0; 3], r: 20.0 };
    let info = ball_info(1.0, 0.1);
    // An engraving 19 deep into R 20 folds over; the sentence names a depth under it.
    let err = lay(&layout, &info, &ball, SkinHow::default(), 19.0, true).unwrap_err();
    assert!(err.starts_with("Letters this deep would fold over inside this curve. Use a depth under "), "{err}");
    let depth: f64 = err.rsplit("under ").next().unwrap().trim_end_matches(" mm.").parse().unwrap();
    assert!(depth > 10.0 && depth < 19.0, "{depth}");
    lay(&layout, &info, &ball, SkinHow::default(), depth, true).unwrap();
    // Raised on the outside of the same ball is fine at any depth; on the inside of a bowl (the face looks in) it folds.
    lay(&layout, &info, &ball, SkinHow::default(), 19.0, false).unwrap();
    let mut inside = ball_info(1.0, 0.1);
    inside.sigma = -1.0;
    assert!(lay(&layout, &inside, &ball, SkinHow::default(), 19.0, false).is_err());
    assert!(lay(&layout, &inside, &ball, SkinHow::default(), 19.0, true).is_ok());
}

#[test]
fn a_text_across_the_seam_is_flagged() {
    let layout = laid("LIME", 6.0);
    let ball = Ball { c: [0.0; 3], r: 30.0 };
    // The seam of a sphere is u = 0 (= 2 pi).
    let across = lay(&layout, &ball_info(0.02, 0.0), &ball, SkinHow::default(), 0.8, false).unwrap();
    assert!(across.crosses_seam);
    let clear = lay(&layout, &ball_info(PI, 0.0), &ball, SkinHow::default(), 0.8, false).unwrap();
    assert!(!clear.crosses_seam);
    // A torus has a seam in v too: a baseline along v over v = 0.
    let ring = Ring { major: 30.0, minor: 10.0 };
    let along_v = SkinHow { v_first: true, ..SkinHow::default() };
    let across = lay(&laid("LIME", 4.0), &ring_info(2.0, 0.05), &ring, along_v, 0.5, false).unwrap();
    assert!(across.crosses_seam);
    let clear = lay(&laid("LIME", 4.0), &ring_info(2.0, FRAC_PI_2), &ring, along_v, 0.5, false).unwrap();
    assert!(!clear.crosses_seam);
}

#[test]
fn project_keeps_the_view_from_above_and_stretches_on_slopes() {
    // On the crest of the wavy sheet the surface is level, so a projection straight down keeps (x, y) exactly.
    let layout = laid("LIME", 6.0);
    let crest = wavy_info(50.0, 10.0);
    let how = SkinHow { project: true, ..SkinHow::default() };
    let placer = Placer::new(&Wavy, &crest, how, -20.0, 20.0).unwrap();
    let o = at(&Wavy, placer.map([0.0, 0.0]).unwrap());
    // (u0, v0) = (50, 10) is where sin(w u) = sin(w v) = 1: a peak, z = 2, level.
    assert!((o[0] - 50.0).abs() < 1e-6 && (o[1] - 10.0).abs() < 1e-6);
    for p in [[-9.0, 2.0], [4.0, -3.0], [12.0, 5.0], [0.0, 6.0]] {
        let on = at(&Wavy, placer.map(p).unwrap());
        // Seen from above it is the layout, with the right-hand side of the text along the surface's +X.
        let seen = [on[0] - o[0], on[1] - o[1]];
        let flat = [p[0], p[1]];
        let ok = (seen[0] - flat[0]).hypot(seen[1] - flat[1]) < 1e-5;
        assert!(ok, "{p:?}: seen {seen:?}");
    }
    // The letters on the sloped side are longer on the surface than in the layout.
    let wrapped = lay(&layout, &wavy_info(50.0, 10.0), &Wavy, how, 0.8, false).unwrap();
    assert!(wrapped.faces.len() == 4);
    // A steep wall turns away: projecting onto a sphere from a point near its horizon is refused.
    let ball = Ball { c: [0.0; 3], r: 10.0 };
    let err = lay(&laid("LIME SLICE", 8.0), &ball_info(0.0, 0.0), &ball, how, 0.5, false).unwrap_err();
    assert!(err.contains("leans too far") || err.contains("miss this face"), "{err}");
}

#[test]
fn outline_pieces_are_cut_only_where_the_surface_bends_them() {
    let segs = |faces: &[GlyphFace]| -> usize { faces.iter().map(|f| std::iter::once(&f.outer).chain(f.holes.iter()).map(|c| c.segs.len()).sum::<usize>()).sum() };
    let layout = laid("LIME", 3.0);
    // On a ball of R 8 a straight stroke is curved by the map and is cut; the loops stay closed.
    let tight = Ball { c: [0.0; 3], r: 8.0 };
    let on_tight = lay(&layout, &ball_info(2.0, 0.9), &tight, SkinHow::default(), 0.2, false).unwrap();
    assert!(segs(&on_tight.faces) > segs(&layout), "{} vs {}", segs(&on_tight.faces), segs(&layout));
    // On a ball of R 200 the same letters keep the pieces they have, or nearly.
    let wide = Ball { c: [0.0; 3], r: 200.0 };
    let on_wide = lay(&layout, &ball_info(2.0, 0.9), &wide, SkinHow::default(), 0.2, false).unwrap();
    assert!(segs(&on_wide.faces) <= segs(&layout) + 4, "{} vs {}", segs(&on_wide.faces), segs(&layout));
}

#[test]
fn letters_too_big_for_the_curve_are_refused_by_the_measured_size() {
    // 14 mm capitals on a ball of R 12 are squeezed much more than the tolerance.
    let layout = laid("LIME", 14.0);
    let ball = Ball { c: [0.0; 3], r: 20.0 };
    let err = lay(&layout, &ball_info(2.0, 0.9), &ball, SkinHow::default(), 0.8, false).unwrap_err();
    assert!(err.contains("too big for this curve") || err.contains("longer"), "{err}");
}

#[test]
fn the_pairs_helper_matches_loops_to_the_layout() {
    let layout = laid("HE", 6.0);
    let ball = Ball { c: [0.0; 3], r: 40.0 };
    let info = ball_info(2.0, 0.2);
    let wrapped = lay(&layout, &info, &ball, SkinHow::default(), 0.8, false).unwrap();
    let paired = pairs(&layout, &wrapped.faces, &ball);
    assert!(paired.len() >= 2);
    assert!(worst_size_error(&paired, 3.0) < TOLERANCE + 0.01);
    assert!(!points(&wrapped.faces).is_empty());
}
