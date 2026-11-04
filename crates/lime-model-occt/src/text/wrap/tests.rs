use super::*;
use crate::text::{lay_out, Align, Spec};
use std::f64::consts::{PI, TAU};

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
        weight: None,
    })
    .unwrap()
    .faces
}

fn cylinder(radius: f64) -> SurfaceInfo {
    SurfaceInfo {
        kind: "cylinder".into(),
        origin: [0.0, 0.0, 0.0],
        xdir: [1.0, 0.0, 0.0],
        ydir: [0.0, 1.0, 0.0],
        zdir: [0.0, 0.0, 1.0],
        radius,
        semi_angle: 0.0,
        sigma: 1.0,
        u0: PI,
        v0: 20.0,
        u_min: 0.0,
        u_max: TAU,
        v_min: 0.0,
        v_max: 40.0,
        full_ring: true,
    }
}

/// A cone from radius 25 at the bottom to 15 at 40 up: the radius falls a quarter of a millimetre per millimetre of height.
fn cone() -> SurfaceInfo {
    let half = (10.0f64 / 40.0).atan();
    // v runs along the generator: 40 up is 40 / cos(half) along it.
    let slant = 40.0 / half.cos();
    SurfaceInfo {
        kind: "cone".into(),
        origin: [0.0, 0.0, 0.0],
        xdir: [1.0, 0.0, 0.0],
        ydir: [0.0, 1.0, 0.0],
        zdir: [0.0, 0.0, 1.0],
        radius: 25.0,
        semi_angle: -half,
        sigma: 1.0,
        u0: PI,
        v0: slant / 2.0,
        u_min: 0.0,
        u_max: TAU,
        v_min: 0.0,
        v_max: slant,
        full_ring: true,
    }
}

fn pts(contour: &Contour) -> Vec<P> {
    contour.flatten(0.05)
}

#[test]
fn a_cylinder_keeps_every_length() {
    // The unrolled distance between any two points of a letter is the layout's: hypot(R du, dv).
    let s = cylinder(20.0);
    let layout = laid("HAg", 6.0);
    wrap(&layout, &s, How::default(), 0.8, false).unwrap();
    let mapper = Mapper::new(&s, How::default());
    let mut checked = 0;
    for face in &layout {
        let a = face.outer.flatten(0.5);
        for (i, p) in a.iter().enumerate() {
            for q in a.iter().skip(i + 1).step_by(3) {
                let (mp, mq) = (mapper.map(*p).unwrap(), mapper.map(*q).unwrap());
                let on_surface = (s.radius * (mq[0] - mp[0])).hypot(mq[1] - mp[1]);
                let flat = (q[0] - p[0]).hypot(q[1] - p[1]);
                assert!((on_surface - flat).abs() < 1e-9, "{on_surface} vs {flat}");
                checked += 1;
            }
        }
    }
    assert!(checked > 100);
}

#[test]
fn a_cone_keeps_every_length() {
    // On a cone the unrolled distance is the law of cosines in the polar chart.
    let s = cone();
    let layout = laid("LIME", 6.0);
    let mapper = Mapper::new(&s, How::default());
    let k = s.semi_angle.sin().abs();
    let apex = -s.radius / s.semi_angle.sin();
    let rho = |v: f64| (v - apex).abs();
    let mut worst = 0.0f64;
    for face in &layout {
        let a = face.outer.flatten(0.4);
        for (i, p) in a.iter().enumerate() {
            for q in a.iter().skip(i + 1) {
                let (mp, mq) = (mapper.map(*p).unwrap(), mapper.map(*q).unwrap());
                let (r1, r2) = (rho(mp[1]), rho(mq[1]));
                let unrolled = (r1 * r1 + r2 * r2 - 2.0 * r1 * r2 * (k * (mq[0] - mp[0])).cos())
                    .max(0.0)
                    .sqrt();
                let flat = (q[0] - p[0]).hypot(q[1] - p[1]);
                worst = worst.max((unrolled - flat).abs());
            }
        }
    }
    assert!(worst < 1e-9, "worst {worst}");
}

#[test]
fn strokes_on_a_cone_are_cut_short_enough_to_stay_straight() {
    // The bar of an I is one segment in the layout; on the cone it becomes several, so the mapped pieces stay within a few
    // microns of the unrolled line.
    let s = cone();
    let layout = laid("I", 12.0);
    let plain = layout[0].outer.segs.len();
    let wrapped = wrap(&layout, &s, How::default(), 0.8, false).unwrap();
    assert!(wrapped.faces[0].outer.segs.len() > plain);
    // The loop is closed exactly.
    let c = &wrapped.faces[0].outer;
    let last = match c.segs.last().unwrap() {
        Seg::Line(p) | Seg::Quad(_, p) | Seg::Cubic(_, _, p) => *p,
    };
    assert_eq!(last, c.start);
    // A cylinder needs no cutting.
    let plain_on_cylinder = wrap(&layout, &cylinder(20.0), How::default(), 0.8, false).unwrap();
    assert_eq!(plain_on_cylinder.faces[0].outer.segs.len(), plain);
}

#[test]
fn outer_loops_run_counter_clockwise_and_holes_clockwise_whichever_way_the_face_looks() {
    for sigma in [1.0, -1.0] {
        let mut s = cylinder(20.0);
        s.sigma = sigma;
        let wrapped = wrap(&laid("AOB8g", 6.0), &s, How::default(), 0.8, false).unwrap();
        let mut holes = 0;
        for face in &wrapped.faces {
            assert!(area(&pts(&face.outer)) > 0.0, "sigma {sigma}: {}", face.ch);
            for hole in &face.holes {
                assert!(area(&pts(hole)) < 0.0);
                holes += 1;
            }
        }
        assert!(holes >= 6);
    }
}

#[test]
fn right_up_and_outward_make_a_right_handed_set_so_the_letters_read_from_outside() {
    for (sigma, zdir, along, flip) in [
        (1.0, [0.0, 0.0, 1.0], false, false),
        (-1.0, [0.0, 0.0, 1.0], false, false),
        (1.0, [0.0, 0.0, 1.0], true, false),
        (1.0, [0.0, 0.0, 1.0], false, true),
        (1.0, [0.0, 0.0, -1.0], false, false),
        (-1.0, [0.0, 0.0, -1.0], true, true),
    ] {
        let mut s = cylinder(20.0);
        s.sigma = sigma;
        s.zdir = zdir;
        // A direct frame: y = z x x.
        s.ydir = cross(zdir, s.xdir);
        let mapper = Mapper::new(&s, How { along, flip });
        let (u, v) = (s.u0, s.v0);
        let o = s.point(u, v);
        let at = |x: f64, y: f64| {
            let q = mapper.map([x, y]).unwrap();
            sub(s.point(q[0], q[1]), o)
        };
        let right = unit(at(0.01, 0.0));
        let up = unit(at(0.0, 0.01));
        let out = s.outward(u, v);
        assert!(
            dot(cross(right, up), out) > 0.99,
            "sigma {sigma} z {zdir:?} along {along} flip {flip}"
        );
        if !along && !flip {
            // Upright: up never points down in the world, whichever way the axis was made.
            assert!(up[2] > 0.99, "up {up:?}");
        }
    }
}

#[test]
fn along_runs_the_baseline_up_the_axis_and_flip_turns_it_half_way_round() {
    let s = cylinder(20.0);
    let round = Mapper::new(&s, How::default()).map([1.0, 0.0]).unwrap();
    assert!((round[0] - (s.u0 + 1.0 / 20.0)).abs() < 1e-12 && (round[1] - s.v0).abs() < 1e-12);
    let along = Mapper::new(
        &s,
        How {
            along: true,
            flip: false,
        },
    )
    .map([1.0, 0.0])
    .unwrap();
    assert!((along[0] - s.u0).abs() < 1e-12 && (along[1] - (s.v0 + 1.0)).abs() < 1e-12);
    let flipped = Mapper::new(
        &s,
        How {
            along: false,
            flip: true,
        },
    )
    .map([1.0, 0.0])
    .unwrap();
    assert!((flipped[0] - (s.u0 - 1.0 / 20.0)).abs() < 1e-12);
}

#[test]
fn text_longer_than_the_way_round_is_refused_with_the_length() {
    let s = cylinder(10.0);
    let long = laid("LIME SLICE 2026 LIME SLICE 2026", 6.0);
    let err = wrap(&long, &s, How::default(), 0.8, false).unwrap_err();
    assert!(
        err.starts_with("The text is longer than the way round this cylinder (62.8 mm)."),
        "{err}"
    );
    // Run up the axis the same text is too long for the face instead.
    let err = wrap(
        &long,
        &s,
        How {
            along: true,
            flip: false,
        },
        0.8,
        false,
    )
    .unwrap_err();
    assert_eq!(err, OFF_FACE);
}

#[test]
fn text_off_the_face_is_refused() {
    let mut s = cylinder(20.0);
    s.v0 = 2.0;
    assert_eq!(
        wrap(&laid("LIME", 6.0), &s, How::default(), 0.8, false).unwrap_err(),
        OFF_FACE
    );
    // A half wall has ends in u.
    let mut s = cylinder(20.0);
    s.full_ring = false;
    s.u_min = PI - 0.1;
    s.u_max = PI + 0.1;
    assert_eq!(
        wrap(&laid("LIME SLICE", 6.0), &s, How::default(), 0.8, false).unwrap_err(),
        OFF_FACE
    );
}

#[test]
fn a_letter_too_deep_for_the_curve_is_refused_with_the_depth_that_works() {
    let s = cylinder(5.0);
    // Engraving eats towards the axis of a wall seen from outside.
    let err = wrap(&laid("L", 3.0), &s, How::default(), 4.6, true).unwrap_err();
    assert_eq!(
        err,
        "Letters this deep would fold over inside this curve. Use a depth under 4.5 mm."
    );
    assert!(wrap(&laid("L", 3.0), &s, How::default(), 4.4, true).is_ok());
    // Raising goes outwards: no limit.
    assert!(wrap(&laid("L", 3.0), &s, How::default(), 4.6, false).is_ok());
    // The inside of a tube is the other way about.
    let mut s = cylinder(5.0);
    s.sigma = -1.0;
    assert!(wrap(&laid("L", 3.0), &s, How::default(), 4.6, true).is_ok());
    assert!(wrap(&laid("L", 3.0), &s, How::default(), 4.6, false).is_err());
}

#[test]
fn the_seam_is_found_when_the_ink_crosses_it() {
    let mut s = cylinder(10.0);
    let clear = wrap(&laid("LIME", 6.0), &s, How::default(), 0.8, false).unwrap();
    assert!(!clear.crosses_seam);
    s.u0 = 0.2;
    let across = wrap(&laid("LIME", 6.0), &s, How::default(), 0.8, false).unwrap();
    assert!(across.crosses_seam);
    assert!(across.bounds[0] < 0.0);
}

#[test]
fn text_past_the_tip_of_a_cone_is_refused() {
    let mut s = cone();
    let apex = -s.radius / s.semi_angle.sin();
    // 1 mm from the tip along the generator.
    s.v0 = apex - 1.0;
    s.v_max = apex;
    let err = wrap(&laid("LIME", 6.0), &s, How::default(), 0.8, false).unwrap_err();
    assert!(err.contains("tip of the cone") || err == OFF_FACE, "{err}");
}

#[test]
fn the_lift_is_the_depth_along_the_normal() {
    for s in [cylinder(20.0), cone()] {
        let (u, v) = (s.u0, s.v0);
        let base = s.point(u, v);
        let top = s.lifted(u, v, 0.8);
        let d = sub(top, base);
        assert!((dot(d, d).sqrt() - 0.8).abs() < 1e-12);
        assert!(dot(unit(d), s.outward(u, v)) > 0.999999);
    }
}
