//! A smear of walls, and a build axis that is not machine Z.
//!
//! More walls put more polymer in the skin, so the same box deflects less.
//! Bending along the weak axis deflects more than bending in the layer plane.

#![allow(clippy::needless_range_loop)]

use lime_sim::assemble::{Hold, Load, NodeHold};
use lime_sim::element::ElementKind;
use lime_sim::material::LinearOrthotropic;
use lime_sim::mesh::{beam, faces_on_plane};
use lime_sim::recipe::{volume_fractions, Pattern, Recipe};
use lime_sim::study::{Request, Step};
use lime_sim::{solve_request, Solution};

const L: f64 = 40.0;
const B: f64 = 20.0;
const H: f64 = 20.0;
const EDGE: f64 = 5.0;

fn recipe(walls: u32, infill: f64, pattern: Pattern) -> Recipe {
    Recipe {
        walls,
        line_width_mm: 1.0,
        layer_height_mm: 0.2,
        skin_layers: 3,
        infill,
        pattern,
        pattern_factor: 1.0,
        pattern_measured: pattern.measured(),
        regions: Vec::new(),
        reinforced_infill: infill,
    }
}

fn solve(
    recipe: Recipe,
    material: LinearOrthotropic,
    axis: [f64; 3],
    provisional: bool,
) -> Solution {
    let mesh = beam(L, B, H, EDGE, ElementKind::Tet10).unwrap();
    let mut holds = Vec::new();
    for (i, p) in mesh.nodes.iter().enumerate() {
        if p[0] <= 1e-8 {
            holds.push(NodeHold {
                node: i,
                hold: Hold::Fixed,
            });
        }
    }
    let traction = [0.0, 0.0, -2.0 / (B * H)];
    let mut loads = Vec::new();
    for face in faces_on_plane(&mesh, 0, L, 1e-6) {
        loads.push(Load::Traction {
            nodes: face.nodes,
            traction,
        });
    }
    solve_request(&Request {
        mesh,
        material,
        recipe,
        build_axis: axis,
        holds,
        loads,
        steps: vec![Step {
            factor: 1.0,
            max_iter: 1,
            tol: 1e-10,
        }],
        linear: true,
        gravity: None,
        h_mm: EDGE,
        allow_linear_tets: false,
        analysis: "static".into(),
        temperature_c: None,
        fibre_axis: None,
        solver: "faer-ldlt".into(),
        representation: "smear".into(),
        cells: Vec::new(),
        beads: None,
        post_steps: Vec::new(),
        provisional,
        cancel: None,
        on_progress: None,
    })
    .unwrap_or_else(|err| panic!("{}", err.message))
}

fn polymer() -> LinearOrthotropic {
    LinearOrthotropic::isotropic(8_000.0, 0.3, 1.24)
}

#[test]
fn more_walls_deflect_less_on_the_same_mesh() {
    let mesh = beam(L, B, H, EDGE, ElementKind::Tet10).unwrap();
    let few_recipe = recipe(1, 0.15, Pattern::Grid);
    let many_recipe = recipe(6, 0.15, Pattern::Grid);
    let axis = [0.0, 0.0, 1.0];
    let few_vf = volume_fractions(&mesh, &few_recipe, axis);
    let many_vf = volume_fractions(&mesh, &many_recipe, axis);
    let sum = |vf: &[f64]| vf.iter().sum::<f64>();
    assert!(
        sum(&many_vf) > sum(&few_vf) + 0.5,
        "skin fraction few {} many {}",
        sum(&few_vf),
        sum(&many_vf)
    );
    let few = solve(few_recipe, polymer(), axis, false);
    let many = solve(many_recipe, polymer(), axis, false);
    eprintln!(
        "walls: few disp {:.6} mm mass {:.4} g, many disp {:.6} mm mass {:.4} g, solid {:.4} g",
        few.max_displacement_mm,
        few.mass_g,
        many.max_displacement_mm,
        many.mass_g,
        many.solid_mass_g
    );
    assert!(
        many.max_displacement_mm < few.max_displacement_mm,
        "many {} few {}",
        many.max_displacement_mm,
        few.max_displacement_mm
    );
    assert!(many.mass_g > few.mass_g);
    assert!(few.mass_g < few.solid_mass_g);
    assert!(many.mass_g < many.solid_mass_g);
}

#[test]
fn the_build_axis_changes_bending() {
    let material = LinearOrthotropic {
        e_in_plane_mpa: 12_000.0,
        e_across_layers_mpa: 3_000.0,
        nu: 0.3,
        strength_in_plane_mpa: 40.0,
        strength_across_layers_mpa: 20.0,
        compression_in_plane_mpa: 40.0,
        compression_across_layers_mpa: 20.0,
        shear_across_layers_mpa: 10.0,
        density_g_cm3: 1.24,
        isotropic: false,
    };
    let solid = Recipe::solid();
    let upright = solve(solid.clone(), material.clone(), [0.0, 0.0, 1.0], false);
    let along = solve(solid, material, [1.0, 0.0, 0.0], false);
    eprintln!(
        "axis: Z disp {:.6} mm, X disp {:.6} mm",
        upright.max_displacement_mm, along.max_displacement_mm
    );
    let rel = (along.max_displacement_mm - upright.max_displacement_mm).abs()
        / upright.max_displacement_mm;
    assert!(
        rel > 0.05,
        "Z {} X {}",
        upright.max_displacement_mm,
        along.max_displacement_mm
    );
    assert!(
        along.max_displacement_mm > upright.max_displacement_mm,
        "bending across the layers should be the softer one"
    );
}

#[test]
fn lightning_adds_its_trust_note() {
    let solution = solve(
        recipe(2, 0.2, Pattern::Lightning),
        polymer(),
        [0.0, 0.0, 1.0],
        false,
    );
    let note = "Lightning infill is modelled as a grid of the same density. A tree of struts is a poor smear.";
    assert!(
        solution.notes.iter().any(|line| line == note),
        "notes {:?}",
        solution.notes
    );
    let grid = solve(
        recipe(2, 0.2, Pattern::Grid),
        polymer(),
        [0.0, 0.0, 1.0],
        false,
    );
    assert!(grid.notes.iter().all(|line| line != note));
}
