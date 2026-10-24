//! A sliced study: holds, loads and targets by region, margins with a hot
//! spot, and the two trust rules of the sliced plan's §10.

use lime_sim::material::{BeadSection, Governs};
use lime_sim::slice_field::{Header, LayerRow, Segment, SliceField, FORMAT, ROLES};
use lime_sim::sliced_study::{
    cell_stresses, run, SolverChoice, Constraint, ConstraintKind, Region, SlicedHold, SlicedLoad,
    SlicedStudy,
};
use lime_sim::study::Card;
use lime_sim::trust::TrustLevel;

const LAYER: f32 = 0.2;
const WIDTH: f32 = 0.45;
const OUTER: u8 = 0;

fn field(
    layers: u32,
    frame_shift: [f64; 3],
    beads_of_layer: impl Fn(f32) -> Vec<([f32; 2], [f32; 2])>,
) -> SliceField {
    let mut segments = Vec::new();
    let mut rows = Vec::new();
    for layer in 0..layers {
        let start = segments.len() as u32;
        let z = (layer + 1) as f32 * LAYER;
        for (a, b) in beads_of_layer(z) {
            segments.push(Segment {
                layer,
                role: OUTER,
                from: [a[0], a[1], z],
                to: [b[0], b[1], z],
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
                [1.0, 0.0, 0.0, frame_shift[0]],
                [0.0, 1.0, 0.0, frame_shift[1]],
                [0.0, 0.0, 1.0, frame_shift[2]],
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

/// Beads along X, one width apart, filling `w` × `d`.
fn lines(w: f64, d: f64) -> impl Fn(f32) -> Vec<([f32; 2], [f32; 2])> {
    move |_| {
        let n = (d / f64::from(WIDTH)).round() as usize;
        (0..n)
            .map(|i| {
                let y = (i as f32 + 0.5) * WIDTH;
                ([0.0, y], [w as f32, y])
            })
            .collect()
    }
}

/// Concentric rings about the origin filling a disc of radius `r`, as a
/// part sliced with walls all the way in.
fn rings(r: f64) -> impl Fn(f32) -> Vec<([f32; 2], [f32; 2])> {
    move |_| {
        let w = f64::from(WIDTH);
        let mut out = Vec::new();
        let mut radius = r - 0.5 * w;
        while radius > 0.5 * w {
            let n = ((std::f64::consts::TAU * radius / 0.4).ceil() as usize).max(8);
            for k in 0..n {
                let a = std::f64::consts::TAU * k as f64 / n as f64;
                let b = std::f64::consts::TAU * (k + 1) as f64 / n as f64;
                out.push((
                    [(radius * a.cos()) as f32, (radius * a.sin()) as f32],
                    [(radius * b.cos()) as f32, (radius * b.sin()) as f32],
                ));
            }
            radius -= w;
        }
        out
    }
}

fn isotropic_card() -> Card {
    serde_json::from_value(serde_json::json!({
        "id": "test", "polymer": "PLA", "EInPlaneMPa": 2000.0, "EAcrossLayersMPa": 2000.0, "nu": 0.35,
        "strengthInPlaneMPa": 40.0, "strengthAcrossLayersMPa": 40.0, "densityGCm3": 1.24, "isotropic": true
    }))
    .unwrap()
}

fn bead_card(strength_layers: f64) -> Card {
    let mut card = isotropic_card();
    card.isotropic = false;
    card.beads = Some(BeadSection {
        provisional: false,
        e_along_mpa: 2000.0,
        e_across_mpa: 1500.0,
        e_layers_mpa: 1200.0,
        strength_along_mpa: 40.0,
        strength_across_mpa: 25.0,
        strength_layers_mpa: strength_layers,
        shear_layers_mpa: 0.5 * strength_layers,
        shear_across_mpa: None,
        bridge_factor: 0.5,
    });
    card
}

fn top(z: f64) -> Region {
    Region::Box {
        min: [-1e3, -1e3, z - 0.01],
        max: [1e3, 1e3, z + 0.01],
    }
}

/// The sliced plan's 9.4: a shaft of radius 8 mm and 4 mm tall, standing on
/// the bed, twisted at its top. Along the shaft, away from both ends, the
/// torsional shear at the surface is within 5% of T r / J at both cell
/// sizes, read where the margins read: cell averages, skipping the
/// staircase's half-empty cells. The ends are where the bed grips the
/// staircase edge and where the twist goes in, and the margins rightly see
/// them; this test reads the shaft between them.
#[test]
fn a_twisted_shaft_carries_t_r_over_j_at_its_surface() {
    let (r, height) = (8.0, 4.0);
    let shaft = field(20, [0.0; 3], rings(r));
    let torque = 600.0;
    let report = run(
        &shaft,
        &SlicedStudy {
            h_xy: Some(1.0),
            card: isotropic_card(),
            holds: vec![SlicedHold::Bed],
            load_cases: Vec::new(),
            loads: vec![SlicedLoad::Torque {
                region: top(height),
                origin: [0.0, 0.0, 0.0],
                axis: [0.0, 0.0, 1.0],
                torque,
            }],
            constraints: vec![Constraint {
                kind: ConstraintKind::MinSafetyFactor,
                value: 2.0,
                ..Default::default()
            }],
            check_resolution: true,
            memory_mb: None,
            solver: Default::default(),
            check_solver: Default::default(),
            use_gpu: true,
            gpu_from_nodes: None,
        },
    )
    .unwrap();
    let expect = torque * r / (std::f64::consts::PI * r.powi(4) / 2.0);
    let (finer, finer_mesh) = report.finer.as_ref().expect("both cell sizes fit the cap");
    let solves = [
        (
            report.solution.as_ref().unwrap(),
            report.mesh.as_ref().unwrap(),
        ),
        (finer, finer_mesh),
    ];
    let mut peaks = Vec::new();
    for (solution, mesh) in solves {
        let mut peak: f64 = 0.0;
        for cell in cell_stresses(solution, mesh) {
            let [x, y, z] = cell.at;
            let rho = x.hypot(y);
            if cell.staircase || rho < 1e-9 || z < height / 3.0 || z > 2.0 * height / 3.0 {
                continue;
            }
            // σ_θz = −sin θ σ_xz + cos θ σ_yz.
            let tau = (-y * cell.stress[5] + x * cell.stress[4]) / rho;
            peak = peak.max(tau.abs());
        }
        println!(
            "h {:.3} mm: τ {peak:.4} MPa against T r / J {expect:.4} ({:+.2}%)",
            mesh.h_xy,
            (peak / expect - 1.0) * 100.0
        );
        assert!(
            (peak / expect - 1.0).abs() < 0.05,
            "h {}: τ {peak} against {expect}",
            mesh.h_xy
        );
        peaks.push(peak);
    }
    // The surface value settles: the two sizes agree within 5%.
    assert!((peaks[0] - peaks[1]).abs() / peaks[1] < 0.05, "{peaks:?}");
    // Converged only if the governing margin held between the two sizes.
    let (a, b) = (
        report.resolutions[0].governing_value.unwrap(),
        report.resolutions[1].governing_value.unwrap(),
    );
    let moved = (a - b).abs() / a.max(b);
    println!(
        "governing safety factor {a:.4} then {b:.4}, moved {:.1}%, trust {:?}",
        moved * 100.0,
        report.trust
    );
    // The trust word is the two sizes' verdict: 4.7% is converged.
    if moved > 0.05 {
        assert_ne!(report.trust, TrustLevel::Converged);
        assert!(report
            .notes
            .iter()
            .any(|n| n.starts_with("The sliced result moved ")));
    } else {
        assert_eq!(report.trust, TrustLevel::Converged);
    }
    // The margins skip the staircase's half-empty cells, never the other way.
    assert!(report.raw_min_safety_factor.unwrap() <= report.min_safety_factor.unwrap());
}

/// L4's check: a bar pulled up its layers, on a card whose layers bond at a
/// quarter of the bead's strength, says the layers decide it.
#[test]
fn a_bar_weak_across_layers_says_so() {
    let bar = field(40, [0.0; 3], lines(4.5, 4.5));
    let report = run(
        &bar,
        &SlicedStudy {
            h_xy: Some(0.9),
            card: bead_card(10.0),
            holds: vec![SlicedHold::Bed],
            load_cases: Vec::new(),
            loads: vec![SlicedLoad::Force {
                region: top(8.0),
                force: [0.0, 0.0, 40.0],
            }],
            constraints: vec![
                Constraint {
                    kind: ConstraintKind::MinSafetyFactor,
                    value: 2.0,
                    ..Default::default()
                },
                Constraint {
                    kind: ConstraintKind::MaxDeflectionMm,
                    value: 0.01,
                    ..Default::default()
                },
            ],
            check_resolution: false,
            memory_mb: None,
            solver: Default::default(),
            check_solver: Default::default(),
            use_gpu: true,
            gpu_from_nodes: None,
        },
    )
    .unwrap();
    let sf = &report.margins[0];
    let spot = sf.hot_spot.as_ref().unwrap();
    assert_eq!(spot.governs, Some(Governs::AcrossLayers));
    assert_eq!(spot.role, "outer");
    assert!(spot.layer.is_some() && spot.layer_z_mm.is_some());
    // Away from its ends the bar carries 40 N over 4.5 × 4.5 mm up its
    // layers. The bed holds its foot fully, so the corners there are worse,
    // and the margin reads them.
    let stress = 40.0 / (4.5 * 4.5);
    let solution = report.solution.as_ref().unwrap();
    let middle: Vec<f64> = solution
        .gauss
        .iter()
        .filter(|g| g.xyz[2] > 3.0 && g.xyz[2] < 5.0)
        .map(|g| g.stress[2])
        .collect();
    let mean = middle.iter().sum::<f64>() / middle.len() as f64;
    assert!(
        (mean / stress - 1.0).abs() < 0.02,
        "mid-height σzz {mean} against {stress}"
    );
    assert!(sf.value <= 10.0 / stress, "{}", sf.value);
    assert!((sf.margin - (sf.value - 2.0) / 2.0).abs() < 1e-12);
    let deflection = &report.margins[1];
    assert!((deflection.margin - (0.01 - deflection.value) / 0.01).abs() < 1e-12);
    // One cell size only: at most usable, and it says so.
    assert_ne!(report.trust, TrustLevel::Converged);
    assert!(report
        .notes
        .iter()
        .any(|n| n == "The sliced result was solved at one cell size only."));
}

#[test]
fn trust_follows_the_two_cell_sizes() {
    use lime_sim::sliced_study::sliced_trust;
    assert_eq!(sliced_trust(false, Some(0.03), "").0, TrustLevel::Converged);
    let (level, note) = sliced_trust(false, Some(0.08), "");
    assert_eq!(level, TrustLevel::Usable);
    assert_eq!(
        note.unwrap(),
        "The sliced result moved 8% between two cell sizes."
    );
    assert_eq!(sliced_trust(false, Some(0.2), "").0, TrustLevel::Rough);
    let (level, note) = sliced_trust(false, None, "One size.");
    assert_eq!(
        (level, note.unwrap().as_str()),
        (TrustLevel::Usable, "One size.")
    );
    assert_eq!(sliced_trust(true, Some(0.01), "").0, TrustLevel::Rough);
}

/// Regions and hot spots are in the part frame, wherever the slice put it.
/// A second cell size that doesn't fit the memory is checked at a coarser
/// size instead, and the note says which and why.
#[test]
fn a_finer_size_past_the_memory_is_checked_coarser() {
    let shaft = field(20, [0.0; 3], rings(8.0));
    let report = run(
        &shaft,
        &SlicedStudy {
            h_xy: Some(1.0),
            card: isotropic_card(),
            holds: vec![SlicedHold::Bed],
            load_cases: Vec::new(),
            loads: vec![SlicedLoad::Force {
                region: top(4.0),
                force: [1.0, 0.0, 0.0],
            }],
            constraints: Vec::new(),
            check_resolution: true,
            // Less than any study needs, so the finer size can't fit.
            memory_mb: Some(1.0),
            solver: Default::default(),
            check_solver: Default::default(),
            use_gpu: true,
            gpu_from_nodes: None,
        },
    )
    .unwrap();
    assert_eq!(report.resolutions.len(), 2);
    let coarse = report.resolutions[1].h_xy_mm;
    assert!((coarse - std::f64::consts::SQRT_2).abs() < 1e-9, "{coarse}");
    assert!(report.finer.is_none());
    let note = report
        .notes
        .iter()
        .find(|n| n.contains("checked at a coarser 1.41 mm"))
        .unwrap_or_else(|| panic!("{:?}", report.notes));
    assert!(note.starts_with("A second cell size of 0.71 mm needs about"), "{note}");
    assert!(note.contains("past the 1 MB this solve may use"), "{note}");
}

/// The finer cell size solved iteratively, preconditioned by the first
/// size's factor, gives the direct solve's answer.
#[test]
fn the_iterative_check_matches_the_direct_one() {
    let shaft = field(20, [0.0; 3], rings(8.0));
    let study = |check_solver| SlicedStudy {
        h_xy: Some(1.0),
        card: isotropic_card(),
        holds: vec![SlicedHold::Bed],
        load_cases: Vec::new(),
        loads: vec![SlicedLoad::Force {
            region: top(4.0),
            force: [1.0, 0.0, 0.0],
        }],
        constraints: vec![Constraint {
            kind: ConstraintKind::MaxDeflectionMm,
            value: 1.0,
            ..Default::default()
        }],
        check_resolution: true,
        memory_mb: None,
        solver: Default::default(),
        check_solver,
        use_gpu: true,
        gpu_from_nodes: None,
    };
    let direct = run(&shaft, &study(SolverChoice::Direct)).unwrap();
    let iterative = run(&shaft, &study(SolverChoice::Iterative)).unwrap();
    let fine = |r: &lime_sim::sliced_study::SlicedReport| r.resolutions[1].governing_value.unwrap();
    let (a, b) = (fine(&direct), fine(&iterative));
    assert!((a - b).abs() / a.abs() < 1e-6, "direct {a}, iterative {b}");
    assert!(
        iterative.notes.iter().any(|n| n.contains("solved iteratively")),
        "{:?}",
        iterative.notes
    );
    assert!(!direct.notes.iter().any(|n| n.contains("solved iteratively")));
}

/// The first cell size solved by p-multigrid gives the direct solve's
/// deflection and safety factor.
#[test]
fn the_iterative_first_size_matches_the_direct_one() {
    let shaft = field(20, [0.0; 3], rings(8.0));
    let study = |solver| SlicedStudy {
        h_xy: Some(1.0),
        card: isotropic_card(),
        holds: vec![SlicedHold::Bed],
        load_cases: Vec::new(),
        loads: vec![SlicedLoad::Force {
            region: top(4.0),
            force: [1.0, 0.0, 0.0],
        }],
        constraints: vec![Constraint {
            kind: ConstraintKind::MaxDeflectionMm,
            value: 1.0,
            ..Default::default()
        }],
        check_resolution: false,
        memory_mb: None,
        solver,
        check_solver: SolverChoice::Auto,
        use_gpu: false,
        gpu_from_nodes: None,
    };
    let direct = run(&shaft, &study(SolverChoice::Direct)).unwrap();
    let iterative = run(&shaft, &study(SolverChoice::Iterative)).unwrap();
    let (a, b) = (direct.max_displacement_mm, iterative.max_displacement_mm);
    assert!((a - b).abs() / a < 1e-6, "direct {a}, iterative {b}");
    let (a, b) = (
        direct.min_safety_factor.unwrap(),
        iterative.min_safety_factor.unwrap(),
    );
    assert!((a - b).abs() / a < 1e-5, "direct {a}, iterative {b}");
    assert!(
        iterative.notes.iter().any(|n| n.contains("1 mm cell size was solved iteratively")),
        "{:?}",
        iterative.notes
    );
}

/// Smoothing on a GPU gives the CPU's answer. Skipped, with a line saying
/// so, in a build without the `gpu` feature or on a machine with no adapter.
#[test]
fn the_gpu_smoothing_matches_the_cpu() {
    if !lime_sim::multigrid::gpu_available() {
        println!("skipped: no GPU in this build or on this machine");
        return;
    }
    let shaft = field(20, [0.0; 3], rings(8.0));
    let study = |use_gpu| SlicedStudy {
        h_xy: Some(1.0),
        card: isotropic_card(),
        holds: vec![SlicedHold::Bed],
        load_cases: Vec::new(),
        loads: vec![SlicedLoad::Force {
            region: top(4.0),
            force: [1.0, 0.0, 0.0],
        }],
        constraints: vec![Constraint {
            kind: ConstraintKind::MaxDeflectionMm,
            value: 1.0,
            ..Default::default()
        }],
        check_resolution: true,
        memory_mb: None,
        solver: Default::default(),
        check_solver: SolverChoice::Iterative,
        use_gpu,
        // This shaft is far below the default; smooth it on the GPU anyway.
        gpu_from_nodes: Some(0),
    };
    let cpu = run(&shaft, &study(false)).unwrap();
    let gpu = run(&shaft, &study(true)).unwrap();
    let fine = |r: &lime_sim::sliced_study::SlicedReport| r.resolutions[1].governing_value.unwrap();
    let (a, b) = (fine(&cpu), fine(&gpu));
    assert!((a - b).abs() / a.abs() < 1e-6, "cpu {a}, gpu {b}");
    assert!(gpu.notes.iter().any(|n| n.contains("smoothed on the GPU")), "{:?}", gpu.notes);
    assert!(!cpu.notes.iter().any(|n| n.contains("GPU")), "{:?}", cpu.notes);
}

#[test]
fn regions_and_hot_spots_are_in_the_part_frame() {
    // The slice frame is the part moved 50 mm along X.
    let shift = [-50.0, 0.0, 0.0];
    let bar = field(20, shift, |_| {
        let n = (4.5 / f64::from(WIDTH)).round() as usize;
        (0..n)
            .map(|i| {
                let y = (i as f32 + 0.5) * WIDTH;
                ([50.0, y], [68.0, y])
            })
            .collect()
    });
    let report = run(
        &bar,
        &SlicedStudy {
            h_xy: Some(0.9),
            card: isotropic_card(),
            holds: vec![SlicedHold::Region {
                region: Region::Box {
                    min: [-0.01, -1.0, -1.0],
                    max: [0.01, 10.0, 10.0],
                },
            }],
            load_cases: Vec::new(),
            loads: vec![SlicedLoad::Force {
                region: Region::Box {
                    min: [17.99, -1.0, -1.0],
                    max: [18.01, 10.0, 10.0],
                },
                force: [0.0, 0.0, -1.0],
            }],
            constraints: vec![Constraint {
                kind: ConstraintKind::MaxDeflectionMm,
                value: 1.0,
                ..Default::default()
            }],
            check_resolution: false,
            memory_mb: None,
            solver: Default::default(),
            check_solver: Default::default(),
            use_gpu: true,
            gpu_from_nodes: None,
        },
    )
    .unwrap();
    let at = report.margins[0].hot_spot.as_ref().unwrap().at;
    assert!(
        (at[0] - 18.0).abs() < 1e-6,
        "the tip is at x 18 in the part frame: {at:?}"
    );
    let missing = run(
        &bar,
        &SlicedStudy {
            h_xy: Some(0.9),
            card: isotropic_card(),
            holds: vec![SlicedHold::Region {
                region: Region::Near {
                    point: [500.0, 0.0, 0.0],
                    radius: 1.0,
                },
            }],
            load_cases: Vec::new(),
            loads: vec![SlicedLoad::Force {
                region: top(4.0),
                force: [0.0, 0.0, 1.0],
            }],
            constraints: Vec::new(),
            check_resolution: false,
            memory_mb: None,
            solver: Default::default(),
            check_solver: Default::default(),
            use_gpu: true,
            gpu_from_nodes: None,
        },
    )
    .unwrap_err();
    assert_eq!(
        missing.message,
        "A hold's region touches no surface of the sliced part."
    );
}
