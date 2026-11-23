//! Golden meshes for the height frame. The shapes are generated here, so the
//! expected heights come from the shape, not from a stored file.

use std::io::Cursor;

use lime_haptic::{compile, height_to_u16, sidecar_json, write_csv, write_png, Base, Extent};

fn cuboid(x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64) -> Vec<[[f64; 3]; 3]> {
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
    let faces = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ];
    faces
        .into_iter()
        .map(|f| [v[f[0]], v[f[1]], v[f[2]]])
        .collect()
}

fn approx(got: f64, expect: f64) {
    assert!((got - expect).abs() < 1e-6, "got {got}, expected {expect}");
}

#[test]
fn flat_plate_pins_match_thickness() {
    let plate = cuboid(0.0, 0.0, 0.0, 8.0, 6.0, 2.5);
    let frame = compile(
        &plate,
        1.0,
        10.0,
        Extent::Rect {
            x0: -2.0,
            y0: -2.0,
            x1: 10.0,
            y1: 8.0,
        },
        Base::Min,
    )
    .unwrap();
    assert_eq!((frame.cols, frame.rows), (12, 10));
    let mut hits = 0;
    for row in 0..frame.rows {
        for col in 0..frame.cols {
            let [x, y] = frame.centre(col, row);
            let inside = (0.0..8.0).contains(&x) && (0.0..6.0).contains(&y);
            if inside {
                approx(frame.height(col, row), 2.5);
                assert!(!frame.missed(col, row));
                hits += 1;
            } else {
                approx(frame.height(col, row), 0.0);
                assert!(frame.missed(col, row));
            }
        }
    }
    assert_eq!(hits, 8 * 6);
    assert_eq!(frame.no_hit_count(), 12 * 10 - hits);
    approx(frame.base_z_mm, 0.0);
}

#[test]
fn step_block_keeps_both_levels_at_the_edge() {
    let mut mesh = cuboid(0.0, 0.0, 0.0, 5.0, 4.0, 1.5);
    mesh.extend(cuboid(5.0, 0.0, 0.0, 10.0, 4.0, 4.0));
    let frame = compile(&mesh, 1.0, 10.0, Extent::Auto, Base::Min).unwrap();
    assert_eq!((frame.cols, frame.rows), (10, 4));
    let edge = 5.0;
    let mut saw_low = false;
    let mut saw_high = false;
    for row in 0..frame.rows {
        for col in 0..frame.cols {
            let x = frame.centre(col, row)[0];
            let dist = (x - edge).abs();
            let height = frame.height(col, row);
            let expect = if x < edge { 1.5 } else { 4.0 };
            approx(height, expect);
            assert!(!frame.missed(col, row));
            if dist <= frame.pitch_mm * 0.5 + 1e-9 {
                if x < edge {
                    saw_low = true;
                } else {
                    saw_high = true;
                }
            }
        }
    }
    assert!(
        saw_low && saw_high,
        "both sides of the step need a pin within pitch/2"
    );
}

#[test]
fn hemisphere_matches_the_analytic_dome() {
    let radius = 10.0;
    let mesh = hemisphere(radius, 32, 96);
    let frame = compile(
        &mesh,
        1.0,
        20.0,
        Extent::Rect {
            x0: -radius,
            y0: -radius,
            x1: radius,
            y1: radius,
        },
        Base::Min,
    )
    .unwrap();
    assert_eq!((frame.cols, frame.rows), (20, 20));
    let mut checked = 0;
    let mut worst = 0.0;
    let mut at = [0.0; 4];
    for row in 0..frame.rows {
        for col in 0..frame.cols {
            let [x, y] = frame.centre(col, row);
            let d = x.hypot(y);
            if d > radius - 1.0 {
                continue;
            }
            let expect = (radius * radius - d * d).sqrt();
            let got = frame.height(col, row);
            let err = (got - expect).abs();
            if err > worst {
                worst = err;
                at = [x, y, expect, got];
            }
            assert!(
                !frame.missed(col, row),
                "pin at {x},{y} (d {d}) missed the dome"
            );
            checked += 1;
        }
    }
    assert!(checked > 100, "checked {checked} pins");
    assert!(
        worst < 0.05,
        "worst dome error {worst} mm at xy {at:?} (expect, got)"
    );
    let corner = frame.missed(0, 0);
    assert!(corner, "the corner pin is outside the dome");
    approx(frame.height(0, 0), 0.0);
}

#[test]
fn travel_clips_to_the_stroke() {
    let thick = cuboid(0.0, 0.0, 0.0, 4.0, 2.0, 5.0);
    let clipped = compile(&thick, 1.0, 2.0, Extent::Auto, Base::Min).unwrap();
    assert_eq!((clipped.cols, clipped.rows), (4, 2));
    for row in 0..clipped.rows {
        for col in 0..clipped.cols {
            approx(clipped.height(col, row), 2.0);
            assert!(!clipped.missed(col, row));
            assert_eq!(
                height_to_u16(clipped.height(col, row), clipped.travel_mm),
                65535
            );
        }
    }

    let thin = cuboid(0.0, 0.0, 0.0, 4.0, 2.0, 1.0);
    let kept = compile(&thin, 1.0, 2.0, Extent::Auto, Base::Min).unwrap();
    for row in 0..kept.rows {
        for col in 0..kept.cols {
            approx(kept.height(col, row), 1.0);
        }
    }

    let mut stepped = cuboid(0.0, 0.0, 0.0, 2.0, 2.0, 1.0);
    stepped.extend(cuboid(2.0, 0.0, 0.0, 4.0, 2.0, 6.0));
    let mixed = compile(&stepped, 2.0, 3.0, Extent::Auto, Base::Min).unwrap();
    assert_eq!((mixed.cols, mixed.rows), (2, 1));
    approx(mixed.height(0, 0), 1.0);
    approx(mixed.height(1, 0), 3.0);
}

#[test]
fn top_base_windows_the_upper_stroke() {
    let mut mesh = cuboid(0.0, 0.0, 0.0, 2.0, 2.0, 10.0);
    mesh.extend(cuboid(2.0, 0.0, 0.0, 4.0, 2.0, 8.0));
    mesh.extend(cuboid(4.0, 0.0, 0.0, 6.0, 2.0, 5.0));
    let frame = compile(&mesh, 2.0, 4.0, Extent::Auto, Base::Top).unwrap();
    assert_eq!((frame.cols, frame.rows), (3, 1));
    approx(frame.base_z_mm, 6.0);
    approx(frame.height(0, 0), 4.0);
    approx(frame.height(1, 0), 2.0);
    approx(frame.height(2, 0), 0.0);
    assert!(
        !frame.missed(2, 0),
        "the low shelf is a hit that clipped to 0"
    );
}

#[test]
fn grid_count_snaps_an_exact_multiple() {
    let plate = cuboid(-1.0, -1.0, 0.0, 12.0, 2.0, 1.0);
    let exact = compile(
        &plate,
        1.0,
        5.0,
        Extent::Rect {
            x0: 0.0,
            y0: 0.0,
            x1: 10.0,
            y1: 1.0,
        },
        Base::Min,
    )
    .unwrap();
    assert_eq!(exact.cols, 10);
    approx(exact.centre(0, 0)[0], 0.5);
    approx(exact.centre(9, 0)[0], 9.5);

    let extra = compile(
        &plate,
        1.0,
        5.0,
        Extent::Rect {
            x0: 0.0,
            y0: 0.0,
            x1: 10.2,
            y1: 1.0,
        },
        Base::Min,
    )
    .unwrap();
    assert_eq!(extra.cols, 11);
    approx(extra.centre(10, 0)[0], 10.5);
    approx(extra.height(10, 0), 1.0);
}

#[test]
fn csv_and_png_carry_the_frame() {
    let plate = cuboid(0.0, 0.0, 0.0, 2.0, 1.0, 1.5);
    let frame = compile(&plate, 1.0, 5.0, Extent::Auto, Base::Min).unwrap();
    let mut csv = Vec::new();
    write_csv(&frame, &mut csv).unwrap();
    let text = String::from_utf8(csv).unwrap();
    assert_eq!(
        text,
        "\
# lime-haptic height frame (experimental)
# format: lime-haptic-height-1
# pitch_mm: 1.000
# travel_mm: 5.000
# origin_mm: 0.000,0.000
# extent_mm: 0.000,0.000,2.000,1.000
# base: min
# base_z_mm: 0.000
# cols: 2
# rows: 1
# units: mm
# row_0: min_y
# no_hit_count: 0
# no_hit_mask: AA==
1.500,1.500
"
    );

    let mut png = Vec::new();
    write_png(&frame, &mut png).unwrap();
    let mut again = Vec::new();
    write_png(&frame, &mut again).unwrap();
    assert_eq!(png, again, "the PNG is deterministic");

    let decoder = png::Decoder::new(Cursor::new(&png));
    let mut reader = decoder.read_info().unwrap();
    assert_eq!(reader.info().color_type, png::ColorType::Grayscale);
    assert_eq!(reader.info().bit_depth, png::BitDepth::Sixteen);
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).unwrap();
    assert_eq!((info.width, info.height), (2, 1));
    let sample = u16::from_be_bytes([buf[0], buf[1]]);
    assert_eq!(sample, height_to_u16(1.5, 5.0));
    assert_eq!(sample, u16::from_be_bytes([buf[2], buf[3]]));

    let side: serde_json::Value = serde_json::from_str(&sidecar_json(&frame)).unwrap();
    assert_eq!(side["format"], "lime-haptic-height-1");
    assert_eq!(side["experimental"], true);
    assert_eq!(side["pitchMm"], 1.0);
    assert_eq!(side["travelMm"], 5.0);
    assert_eq!(side["originMm"], serde_json::json!([0.0, 0.0]));
    assert_eq!(side["cols"], 2);
    assert_eq!(side["rows"], 1);
    assert_eq!(side["units"], "mm");
    assert_eq!(side["row0"], "minY");
    assert_eq!(side["pngRow0"], "maxY");
    assert_eq!(side["noHitCount"], 0);
    assert_eq!(side["noHitMask"], "AA==");
    assert_eq!(side["base"], "min");
}

#[test]
fn png_top_row_is_maximum_y() {
    let mut mesh = cuboid(0.0, 0.0, 0.0, 1.0, 1.0, 1.0);
    mesh.extend(cuboid(0.0, 1.0, 0.0, 1.0, 2.0, 3.0));
    let frame = compile(&mesh, 1.0, 3.0, Extent::Auto, Base::Min).unwrap();
    assert_eq!((frame.cols, frame.rows), (1, 2));
    approx(frame.height(0, 0), 1.0);
    approx(frame.height(0, 1), 3.0);

    let mut png = Vec::new();
    write_png(&frame, &mut png).unwrap();
    let decoder = png::Decoder::new(Cursor::new(&png));
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size()];
    reader.next_frame(&mut buf).unwrap();
    let top = u16::from_be_bytes([buf[0], buf[1]]);
    let bottom = u16::from_be_bytes([buf[2], buf[3]]);
    assert_eq!(
        top, 65535,
        "the picture's top row is maximum Y, full travel"
    );
    assert_eq!(bottom, height_to_u16(1.0, 3.0));
}

#[test]
fn misses_are_flagged_in_the_mask() {
    let plate = cuboid(0.0, 0.0, 0.0, 2.0, 1.0, 1.0);
    let frame = compile(
        &plate,
        1.0,
        5.0,
        Extent::Rect {
            x0: 10.0,
            y0: 0.0,
            x1: 12.0,
            y1: 1.0,
        },
        Base::Min,
    )
    .unwrap();
    assert_eq!(frame.no_hit_count(), 2);
    assert!(frame.missed(0, 0) && frame.missed(1, 0));
    let side: serde_json::Value = serde_json::from_str(&sidecar_json(&frame)).unwrap();
    assert_eq!(side["noHitCount"], 2);
    assert_eq!(side["noHitMask"], "wA==");
}

#[test]
fn compile_is_deterministic() {
    let mut mesh = cuboid(0.0, 0.0, 0.0, 5.0, 3.0, 2.0);
    mesh.extend(hemisphere(4.0, 12, 24));
    let a = compile(&mesh, 0.5, 6.0, Extent::Auto, Base::Min).unwrap();
    let b = compile(&mesh, 0.5, 6.0, Extent::Auto, Base::Min).unwrap();
    assert_eq!(a.heights_mm, b.heights_mm);
    assert_eq!(a.no_hit, b.no_hit);
    assert_eq!(a.cols, b.cols);
}

#[test]
fn rejects_a_bad_request() {
    let plate = cuboid(0.0, 0.0, 0.0, 1.0, 1.0, 1.0);
    assert!(compile(&plate, 0.0, 1.0, Extent::Auto, Base::Min).is_err());
    assert!(compile(&plate, -1.0, 1.0, Extent::Auto, Base::Min).is_err());
    assert!(compile(&plate, 1.0, 0.0, Extent::Auto, Base::Min).is_err());
    assert!(compile(&[], 1.0, 1.0, Extent::Auto, Base::Min).is_err());
    assert!(Extent::parse("1,2,3").is_err());
    assert!(Extent::parse("auto").is_ok());
    assert!(Base::parse("top").is_ok());
    assert!(Base::parse("bed").is_err());
    assert_eq!(height_to_u16(0.0, 10.0), 0);
    assert_eq!(height_to_u16(10.0, 10.0), 65535);
    assert_eq!(height_to_u16(5.0, 10.0), 32768);
}

/// Upper hemisphere of radius `r`, centred on the origin, equator on Z = 0.
/// Vertices lie on the sphere, so a facet is inside it.
fn hemisphere(r: f64, stacks: usize, slices: usize) -> Vec<[[f64; 3]; 3]> {
    let mut tris = Vec::new();
    let pole = [0.0, 0.0, r];
    let ring = |i: usize| -> Vec<[f64; 3]> {
        let phi = std::f64::consts::FRAC_PI_2 * (i as f64) / (stacks as f64);
        let z = r * phi.cos();
        let radius = r * phi.sin();
        (0..slices)
            .map(|j| {
                let theta = std::f64::consts::TAU * (j as f64) / (slices as f64);
                [radius * theta.cos(), radius * theta.sin(), z]
            })
            .collect()
    };
    let first = ring(1);
    for j in 0..slices {
        let j1 = (j + 1) % slices;
        tris.push([pole, first[j], first[j1]]);
    }
    let mut prev = first;
    for i in 2..=stacks {
        let row = ring(i);
        for j in 0..slices {
            let j1 = (j + 1) % slices;
            tris.push([prev[j], row[j], row[j1]]);
            tris.push([prev[j], row[j1], prev[j1]]);
        }
        prev = row;
    }
    tris
}
