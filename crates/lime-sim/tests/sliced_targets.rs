//! Targets on a region, bands, stiffness, relative deflection and load
//! cases (the sliced plan, §7.1 and §9.7).

use lime_sim::assemble::{Hold, Load, NodeHold};
use lime_sim::material::LinearOrthotropic;
use lime_sim::mesh::{beam, faces_on_plane};
use lime_sim::recipe::Recipe;
use lime_sim::slice_field::{Header, LayerRow, Segment, SliceField, FORMAT, ROLES};
use lime_sim::sliced_study::{
    run, signed_margin, Constraint, ConstraintKind, LoadCase, Region, SlicedHold, SlicedLoad,
    SlicedStudy,
};
use lime_sim::study::{Card, Request, Step};
use lime_sim::{solve_cases, solve_request, ElementKind};

const LAYER: f32 = 0.2;
const WIDTH: f32 = 0.45;
const L: f64 = 18.0;

/// A bar `L` × 4.5 × 4 mm of beads along X.
fn bar() -> SliceField {
    let mut segments = Vec::new();
    let mut rows = Vec::new();
    for layer in 0..20u32 {
        let start = segments.len() as u32;
        let z = (layer + 1) as f32 * LAYER;
        for i in 0..10 {
            let y = (i as f32 + 0.5) * WIDTH;
            segments.push(Segment {
                layer,
                role: 0,
                from: [0.0, y, z],
                to: [L as f32, y, z],
                width_mm: WIDTH,
                bead_height_mm: LAYER,
                flow: 1.0,
            });
        }
        rows.push(LayerRow {
            index: layer,
            z_mm: f64::from(z),
            height_mm: f64::from(LAYER),
            bead_start: start,
            bead_count: segments.len() as u32 - start,
        });
    }
    SliceField {
        header: Header {
            format: FORMAT.into(),
            slice_hash: String::new(),
            frame: [
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
                [0.0, 0.0, 0.0, 1.0],
            ],
            layer_normal: [0.0, 0.0, 1.0],
            layers: rows,
            roles: ROLES.iter().map(|r| r.to_string()).collect(),
            segment_count: segments.len() as u32,
        },
        segments,
    }
}

fn card() -> Card {
    serde_json::from_value(serde_json::json!({
        "id": "test", "polymer": "PLA", "EInPlaneMPa": 2000.0, "EAcrossLayersMPa": 2000.0, "nu": 0.35,
        "strengthInPlaneMPa": 40.0, "strengthAcrossLayersMPa": 40.0, "densityGCm3": 1.24, "isotropic": true
    }))
    .unwrap()
}

/// The plane x = `x` of the bar, as a thin box.
fn at_x(x: f64) -> Region {
    Region::Box {
        min: [x - 0.01, -1.0, -1.0],
        max: [x + 0.01, 10.0, 10.0],
    }
}

fn root() -> SlicedHold {
    SlicedHold::Region { region: at_x(0.0) }
}

fn tip_down(newtons: f64) -> SlicedLoad {
    SlicedLoad::Force {
        region: at_x(L),
        force: [0.0, 0.0, -newtons],
    }
}

fn study(loads: Vec<SlicedLoad>, constraints: Vec<Constraint>) -> SlicedStudy {
    SlicedStudy {
        h_xy: Some(0.9),
        card: card(),
        holds: vec![root()],
        loads,
        load_cases: Vec::new(),
        constraints,
        check_resolution: false,
        memory_mb: None,
        check_solver: Default::default(),
    }
}

fn band(region: Region, lo: f64, hi: f64) -> Constraint {
    Constraint {
        kind: ConstraintKind::DeflectionBandMm,
        band: Some([lo, hi]),
        region: Some(region),
        ..Default::default()
    }
}

/// 9.7: a band on the tip is 1 at its centre, 0 at each edge, and names the
/// side it missed outside.
#[test]
fn a_band_on_the_tip_is_one_at_its_centre_and_zero_at_its_edges() {
    let first = run(
        &bar(),
        &study(vec![tip_down(1.0)], vec![band(at_x(L), 0.0, 10.0)]),
    )
    .unwrap();
    let v = first.margins[0].value;
    assert!(v > 0.0);
    let bands = vec![
        band(at_x(L), 0.5 * v, 1.5 * v),
        band(at_x(L), v, 2.0 * v),
        band(at_x(L), 0.5 * v, v),
        band(at_x(L), 1.5 * v, 2.0 * v),
        band(at_x(L), 0.25 * v, 0.5 * v),
    ];
    let report = run(&bar(), &study(vec![tip_down(1.0)], bands)).unwrap();
    let m: Vec<f64> = report.margins.iter().map(|m| m.margin).collect();
    assert!((m[0] - 1.0).abs() < 1e-9, "centre {}", m[0]);
    assert!(
        m[1].abs() < 1e-9 && m[2].abs() < 1e-9,
        "edges {} {}",
        m[1],
        m[2]
    );
    assert!(m[3] < 0.0 && m[4] < 0.0);
    let note = |i: usize| report.margins[i].note.clone().unwrap();
    assert!(note(3).starts_with("Too stiff: it moves "), "{}", note(3));
    assert!(
        note(4).starts_with("Too flexible: it moves "),
        "{}",
        note(4)
    );
    assert!(report.margins[0].note.is_none());
    assert!(report.margins.iter().all(|m| m.load_case == "default"));
}

/// 9.7: two load cases give what two separate solves give, from one
/// factorisation of the stiffness.
#[test]
fn two_load_cases_share_one_factorisation() {
    let mesh = beam(12.0, 3.0, 3.0, 1.0, ElementKind::Tet10).unwrap();
    let holds: Vec<NodeHold> = (0..mesh.nodes.len())
        .filter(|&i| mesh.nodes[i][0].abs() < 1e-9)
        .map(|node| NodeHold {
            node,
            hold: Hold::Fixed,
        })
        .collect();
    let tip = |t: [f64; 3]| -> Vec<Load> {
        faces_on_plane(&mesh, 0, 12.0, 1e-9)
            .into_iter()
            .map(|f| Load::Traction {
                nodes: f.nodes,
                traction: t,
            })
            .collect()
    };
    let cases = vec![tip([0.0, 0.0, -0.1]), tip([0.0, 0.2, 0.0])];
    let request = |loads: Vec<Load>| Request {
        mesh: mesh.clone(),
        material: LinearOrthotropic::isotropic(2000.0, 0.35, 1.24),
        recipe: Recipe::solid(),
        build_axis: [0.0, 0.0, 1.0],
        holds: holds.clone(),
        loads,
        steps: vec![Step {
            factor: 1.0,
            max_iter: 1,
            tol: 1e-10,
        }],
        linear: true,
        gravity: None,
        h_mm: 1.0,
        allow_linear_tets: false,
        analysis: "static".into(),
        temperature_c: None,
        fibre_axis: None,
        solver: "faer-ldlt".into(),
        representation: "smear".into(),
        cells: Vec::new(),
        beads: None,
        post_steps: Vec::new(),
        provisional: false,
        cancel: None,
        on_progress: None,
    };
    let together = solve_cases(&request(Vec::new()), &cases).unwrap();
    assert_eq!(together.factorisations, 1);
    for (case, solved) in cases.iter().zip(&together.solutions) {
        let alone = solve_request(&request(case.clone())).unwrap();
        let scale = alone.max_displacement_mm;
        let worst = solved
            .displacement
            .iter()
            .zip(&alone.displacement)
            .flat_map(|(a, b)| (0..3).map(move |k| (a[k] - b[k]).abs()))
            .fold(0.0, f64::max);
        assert!(worst <= 1e-10 * scale, "{worst} against {scale}");
    }
}

/// 9.7's clip: the mount must stay put under the working load, and the
/// latch must travel inside a band under the snap force. Both margins come
/// from one factorisation.
#[test]
fn a_clip_reports_a_stiff_mount_and_a_latch_band_from_one_factorisation() {
    let mount = Region::Box {
        min: [0.5, -1.0, -1.0],
        max: [3.0, 10.0, 10.0],
    };
    let report = run(
        &bar(),
        &SlicedStudy {
            h_xy: Some(0.9),
            card: card(),
            holds: vec![root()],
            loads: Vec::new(),
            load_cases: vec![
                LoadCase {
                    name: "work".into(),
                    // Pressed down on a patch of the top, mid-length.
                    loads: vec![SlicedLoad::Force {
                        region: Region::Box {
                            min: [8.0, -1.0, 3.99],
                            max: [10.0, 10.0, 4.01],
                        },
                        force: [0.0, 0.0, -2.0],
                    }],
                },
                LoadCase {
                    name: "snap".into(),
                    loads: vec![tip_down(1.0)],
                },
            ],
            constraints: vec![
                Constraint {
                    kind: ConstraintKind::MaxDeflectionMm,
                    value: 0.05,
                    region: Some(mount),
                    load_case: Some("work".into()),
                    ..Default::default()
                },
                Constraint {
                    load_case: Some("snap".into()),
                    ..band(at_x(L), 0.001, 10.0)
                },
                Constraint {
                    kind: ConstraintKind::MinStiffnessNPerMm,
                    value: 1.0,
                    region: Some(at_x(L)),
                    load_case: Some("snap".into()),
                    ..Default::default()
                },
            ],
            check_resolution: false,
            memory_mb: None,
            check_solver: Default::default(),
        },
    )
    .unwrap();
    assert_eq!(report.load_cases, vec!["work", "snap"]);
    assert_eq!(report.resolutions[0].factorisations, 1);
    let (mount, latch, stiffness) = (&report.margins[0], &report.margins[1], &report.margins[2]);
    assert_eq!(mount.load_case, "work");
    assert_eq!(latch.load_case, "snap");
    assert!(
        mount.margin > 0.0 && latch.margin > 0.0,
        "{mount:?} {latch:?}"
    );
    // The mount, near the root, moves less than the whole part does.
    let work = &report.case_solutions[0];
    assert!(mount.value < work.max_displacement_mm);
    // 1 N at the tip over the tip's mean drop.
    assert!(
        (stiffness.value - 1.0 / latch.value).abs() / stiffness.value < 0.05,
        "{} vs {}",
        stiffness.value,
        1.0 / latch.value
    );
}

#[test]
fn a_stiffness_band_says_which_side_it_missed() {
    let stiffness = |lo: f64, hi: f64| Constraint {
        kind: ConstraintKind::StiffnessBandNPerMm,
        band: Some([lo, hi]),
        region: Some(at_x(L)),
        ..Default::default()
    };
    let report = run(
        &bar(),
        &study(vec![tip_down(1.0)], vec![stiffness(1e-6, 1e9)]),
    )
    .unwrap();
    let k = report.margins[0].value;
    let report = run(
        &bar(),
        &study(
            vec![tip_down(1.0)],
            vec![stiffness(2.0 * k, 3.0 * k), stiffness(0.2 * k, 0.5 * k)],
        ),
    )
    .unwrap();
    assert!(report.margins[0]
        .note
        .as_ref()
        .unwrap()
        .starts_with("Too flexible: it takes "));
    assert!(report.margins[1]
        .note
        .as_ref()
        .unwrap()
        .starts_with("Too stiff: it takes "));
}

/// Pulled along its length, the bar's tip moves away from its root by the
/// stretch: the relative deflection between the two ends.
#[test]
fn a_relative_deflection_is_the_change_between_two_regions() {
    let report = run(
        &bar(),
        &study(
            vec![SlicedLoad::Force {
                region: at_x(L),
                force: [20.0, 0.0, 0.0],
            }],
            vec![Constraint {
                kind: ConstraintKind::RelativeDeflectionMm,
                value: 1.0,
                region: Some(at_x(0.0)),
                other: Some(at_x(L)),
                ..Default::default()
            }],
        ),
    )
    .unwrap();
    // F L / (E A) for 20 N on 4.5 × 4 mm over 18 mm.
    let stretch = 20.0 * L / (2000.0 * 4.5 * 4.0);
    let got = report.margins[0].value;
    assert!(
        (got / stretch - 1.0).abs() < 0.03,
        "{got} against {stretch}"
    );
}

#[test]
fn malformed_targets_are_sentences() {
    let err = |constraints: Vec<Constraint>| {
        run(&bar(), &study(vec![tip_down(1.0)], constraints))
            .unwrap_err()
            .message
    };
    assert_eq!(
        err(vec![Constraint {
            kind: ConstraintKind::DeflectionBandMm,
            ..Default::default()
        }]),
        "A band needs two numbers, the lower first."
    );
    assert_eq!(
        err(vec![Constraint {
            kind: ConstraintKind::MinStiffnessNPerMm,
            value: 1.0,
            ..Default::default()
        }]),
        "A stiffness target needs the region it reads."
    );
    assert_eq!(
        err(vec![Constraint {
            kind: ConstraintKind::MaxDeflectionMm,
            value: 1.0,
            load_case: Some("snap".into()),
            ..Default::default()
        }]),
        "There is no load case named snap."
    );
    let mut both = study(vec![tip_down(1.0)], Vec::new());
    both.load_cases = vec![LoadCase {
        name: "x".into(),
        loads: vec![tip_down(1.0)],
    }];
    assert_eq!(
        run(&bar(), &both).unwrap_err().message,
        "Give loads or load cases, not both."
    );
    // A band's margin by formula: 1 at the centre, 0 at the edges.
    let c = band(at_x(L), 1.0, 3.0);
    assert_eq!(signed_margin(&c, 2.0), 1.0);
    assert_eq!(signed_margin(&c, 1.0), 0.0);
    assert_eq!(signed_margin(&c, 3.0), 0.0);
}
