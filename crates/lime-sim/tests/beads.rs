//! A sliced cell mixes its beads: stiff along them, softer across them and
//! across the layers, by the card's bead section (the sliced plan, §6).

use lime_sim::material::{BeadSection, Governs, LinearOrthotropic};
use lime_sim::mesh::faces_on_plane;
use lime_sim::recipe::Recipe;
use lime_sim::slice_field::{Header, LayerRow, Segment, SliceField, FORMAT, ROLES};
use lime_sim::sliced::{SlicedGrid, PHI_MIN};
use lime_sim::study::{provisional_cards, Card, Request, Step};
use lime_sim::trust::TrustLevel;
use lime_sim::{solve_request, Hold, Load, Mesh, NodeHold, Solution};

const LAYER: f32 = 0.2;
const WIDTH: f32 = 0.45;
const OUTER: u8 = 0;

/// A solid block of `layers` layers, `w` × `d` mm, its beads one width
/// apart and all along X or all along Y.
fn block(w: f64, d: f64, layers: u32, along_x: bool) -> SliceField {
    let mut segments = Vec::new();
    let mut rows = Vec::new();
    for layer in 0..layers {
        let start = segments.len() as u32;
        let z = (layer + 1) as f32 * LAYER;
        let lines = ((if along_x { d } else { w }) / f64::from(WIDTH)).round() as usize;
        for n in 0..lines {
            let c = (n as f32 + 0.5) * WIDTH;
            let (from, to) = if along_x {
                ([0.0, c, z], [w as f32, c, z])
            } else {
                ([c, 0.0, z], [c, d as f32, z])
            };
            segments.push(Segment {
                layer,
                role: OUTER,
                from,
                to,
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

fn section(along: f64, across: f64, layers: f64) -> BeadSection {
    BeadSection {
        provisional: false,
        e_along_mpa: along,
        e_across_mpa: across,
        e_layers_mpa: layers,
        strength_along_mpa: 40.0,
        strength_across_mpa: 20.0,
        strength_layers_mpa: 10.0,
        shear_layers_mpa: 5.0,
        shear_across_mpa: None,
        bridge_factor: 0.5,
    }
}

/// Pull the face at the largest coordinate along `axis` with `force` N,
/// holding the opposite face on rollers: across that axis it may shrink.
fn pull(
    mesh: Mesh,
    cells: Vec<lime_sim::sliced::CellMaterial>,
    beads: Option<BeadSection>,
    axis: usize,
    h: f64,
) -> Solution {
    let lo = mesh
        .nodes
        .iter()
        .map(|p| p[axis])
        .fold(f64::INFINITY, f64::min);
    let hi = mesh
        .nodes
        .iter()
        .map(|p| p[axis])
        .fold(f64::NEG_INFINITY, f64::max);
    let root: Vec<usize> = (0..mesh.nodes.len())
        .filter(|&i| (mesh.nodes[i][axis] - lo).abs() < 1e-6)
        .collect();
    let mut holds: Vec<NodeHold> = root
        .iter()
        .map(|&node| NodeHold {
            node,
            hold: Hold::Axis { axis, value: 0.0 },
        })
        .collect();
    // One root node fixed and a second held across, so the part can't spin.
    let a = (axis + 1) % 3;
    let first = root[0];
    holds.push(NodeHold {
        node: first,
        hold: Hold::Fixed,
    });
    let far = *root
        .iter()
        .max_by(|&&p, &&q| {
            let dp = (mesh.nodes[p][a] - mesh.nodes[first][a]).abs();
            let dq = (mesh.nodes[q][a] - mesh.nodes[first][a]).abs();
            dp.total_cmp(&dq)
        })
        .unwrap();
    holds.push(NodeHold {
        node: far,
        hold: Hold::Axis {
            axis: (axis + 2) % 3,
            value: 0.0,
        },
    });
    let tip = faces_on_plane(&mesh, axis, hi, 1e-6);
    let area: f64 = tip.iter().map(|f| f.area).sum();
    let mut traction = [0.0; 3];
    traction[axis] = 10.0 / area;
    let loads = tip
        .into_iter()
        .map(|face| Load::Traction {
            nodes: face.nodes,
            traction,
        })
        .collect();
    solve_request(&Request {
        mesh,
        material: LinearOrthotropic::isotropic(1000.0, 0.35, 1.24),
        recipe: Recipe::solid(),
        build_axis: [0.0, 0.0, 1.0],
        holds,
        loads,
        steps: vec![Step {
            factor: 1.0,
            max_iter: 1,
            tol: 1e-10,
        }],
        linear: true,
        gravity: None,
        h_mm: h,
        allow_linear_tets: false,
        analysis: "static".into(),
        temperature_c: None,
        fibre_axis: None,
        solver: "faer-ldlt".into(),
        representation: "sliced".into(),
        cells,
        beads,
        post_steps: Vec::new(),
        provisional: false,
        cancel: None,
        on_progress: None,
    })
    .unwrap_or_else(|err| panic!("{}", err.message))
}

fn solve(field: &SliceField, beads: Option<BeadSection>, axis: usize) -> Solution {
    let h = 0.9;
    let mesh = SlicedGrid::rasterize(field, h)
        .unwrap()
        .mesh(PHI_MIN)
        .unwrap();
    pull(mesh.mesh, mesh.cells, beads, axis, h)
}

/// With every modulus equal the beads are the card's isotropic polymer, so
/// a sliced cell solves exactly as the smear of that card.
#[test]
fn equal_bead_moduli_are_the_isotropic_card() {
    let field = block(9.0, 3.6, 16, true);
    let mixed = solve(&field, Some(section(1000.0, 1000.0, 1000.0)), 0);
    let plain = solve(&field, None, 0);
    let rel =
        (mixed.max_displacement_mm - plain.max_displacement_mm).abs() / plain.max_displacement_mm;
    assert!(
        rel < 1e-9,
        "{} vs {}",
        mixed.max_displacement_mm,
        plain.max_displacement_mm
    );
    assert_eq!(mixed.criterion, "max-stress-bead");
    assert_eq!(plain.criterion, "max-stress");
    assert!(plain.notes.iter().any(|n| {
        n == "This card has no bead constants, so each cell is a smear of the card at its fraction."
    }));
}

/// The sliced plan's 9.3: beads along the load against beads across it.
/// The bar's stretch differs by the card's ratio, within 5%.
#[test]
fn beads_along_the_load_are_stiffer_by_the_cards_ratio() {
    let card = section(2000.0, 800.0, 800.0);
    let along = solve(&block(9.0, 3.6, 16, true), Some(card.clone()), 0);
    let across = solve(&block(9.0, 3.6, 16, false), Some(card.clone()), 0);
    let ratio = across.max_displacement_mm / along.max_displacement_mm;
    let expect = card.e_along_mpa / card.e_across_mpa;
    println!("stretch across / along {ratio:.4}, card {expect}");
    assert!(
        (ratio / expect - 1.0).abs() < 0.05,
        "stretch across / along {ratio:.4}, card {expect}"
    );
}

#[test]
fn the_safety_factor_names_what_governs_it() {
    let card = section(2000.0, 800.0, 800.0);
    // Pulled along the layer normal, the layers part first.
    let up = solve(&block(4.5, 4.5, 30, true), Some(card.clone()), 2);
    assert_eq!(up.min_safety_governs, Some(Governs::AcrossLayers));
    // Pulled across the beads, the bond between beads goes.
    let across = solve(&block(9.0, 3.6, 16, false), Some(card.clone()), 0);
    assert_eq!(across.min_safety_governs, Some(Governs::AcrossBead));
    // 10 N over 3.6 × 3.2 mm against a 20 MPa bond.
    let stress = 10.0 / (3.6 * 3.2);
    let sf = across.min_safety_factor.unwrap();
    println!(
        "across-bead safety {sf:.4}, bond over stress {:.4}",
        20.0 / stress
    );
    assert!((sf - 20.0 / stress).abs() / (20.0 / stress) < 0.05, "{sf}");
    let summary = serde_json::to_value(across.summary()).unwrap();
    assert_eq!(summary["minSafetyGoverns"], "across-bead");
}

#[test]
fn provisional_bead_constants_keep_the_study_rough() {
    let mut card = section(2000.0, 800.0, 800.0);
    card.provisional = true;
    let solved = solve(&block(9.0, 3.6, 16, true), Some(card), 0);
    assert_eq!(solved.trust, TrustLevel::Rough);
    assert!(solved
        .notes
        .iter()
        .any(|n| n == "Provisional bead constants, not a measurement."));
}

#[test]
fn a_card_reads_its_bead_section_and_the_placeholders_carry_one() {
    let json = serde_json::json!({
        "id": "t", "polymer": "PLA", "EInPlaneMPa": 1700.0, "EAcrossLayersMPa": 1400.0, "nu": 0.35,
        "strengthInPlaneMPa": 28.0, "strengthAcrossLayersMPa": 14.0, "densityGCm3": 1.24,
        "beads": {
            "EAlongBeadMPa": 1800.0, "EAcrossBeadMPa": 1200.0, "EAcrossLayersMPa": 1000.0,
            "strengthAlongBeadMPa": 30.0, "strengthAcrossBeadMPa": 18.0, "strengthAcrossLayersMPa": 12.0,
            "shearAcrossLayersMPa": 6.0, "bridgeFactor": 0.6
        }
    });
    let card: Card = serde_json::from_value(json).unwrap();
    let beads = card.beads.unwrap();
    assert_eq!(beads.e_across_mpa, 1200.0);
    assert!(!beads.provisional);
    for card in provisional_cards() {
        let beads = card.beads.expect("a placeholder bead section");
        assert!(beads.provisional, "{}", card.id);
        assert!(beads.check().is_ok(), "{}", card.id);
    }
}
