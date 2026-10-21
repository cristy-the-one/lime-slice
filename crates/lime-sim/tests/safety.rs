//! The safety factor scales with the infill, and it sees compression and
//! interlayer shear. In-plane shear stays on the principal check.

use lime_sim::assemble::{Hold, Load, NodeHold};
use lime_sim::element::ElementKind;
use lime_sim::material::{
    FailureCriterion, LinearOrthotropic, MaterialContext, MaterialModel, MaxStress, Stress,
};
use lime_sim::mesh::{beam, faces_on_plane};
use lime_sim::recipe::{Pattern, Recipe};
use lime_sim::solve_request;
use lime_sim::study::{Request, Step};

const SENTENCE_AXIS: [f64; 3] = [0.0, 0.0, 1.0];

fn card() -> LinearOrthotropic {
    LinearOrthotropic {
        e_in_plane_mpa: 1_000.0,
        e_across_layers_mpa: 1_000.0,
        nu: 0.3,
        strength_in_plane_mpa: 30.0,
        strength_across_layers_mpa: 15.0,
        compression_in_plane_mpa: 40.0,
        compression_across_layers_mpa: 20.0,
        shear_across_layers_mpa: 7.5,
        density_g_cm3: 1.2,
        isotropic: false,
    }
}

fn ctx(vf: f64) -> MaterialContext {
    MaterialContext {
        build_axis: SENTENCE_AXIS,
        temperature_c: None,
        fibre_axis: None,
        volume_fraction: vf,
    }
}

fn recipe(infill: f64) -> Recipe {
    Recipe {
        walls: 0,
        line_width_mm: 0.4,
        layer_height_mm: 0.2,
        skin_layers: 0,
        infill,
        pattern: Pattern::Grid,
        pattern_factor: 1.0,
        pattern_measured: true,
        regions: Vec::new(),
        reinforced_infill: infill,
    }
}

fn bar(infill: f64, traction: [f64; 3]) -> lime_sim::Solution {
    let mesh = beam(20.0, 10.0, 10.0, 10.0, ElementKind::Tet10).unwrap();
    let mut holds = Vec::new();
    for (node, p) in mesh.nodes.iter().enumerate() {
        if p[0].abs() <= 1e-8 {
            holds.push(NodeHold {
                node,
                hold: Hold::Fixed,
            });
        }
    }
    let mut loads = Vec::new();
    for face in faces_on_plane(&mesh, 0, 20.0, 1e-8) {
        loads.push(Load::Traction {
            nodes: face.nodes,
            traction,
        });
    }
    solve_request(&Request {
        mesh,
        material: card(),
        recipe: recipe(infill),
        build_axis: SENTENCE_AXIS,
        holds,
        loads,
        steps: vec![Step {
            factor: 1.0,
            max_iter: 1,
            tol: 1e-8,
        }],
        linear: true,
        gravity: None,
        h_mm: 10.0,
        allow_linear_tets: false,
        analysis: "static".into(),
        temperature_c: None,
        fibre_axis: None,
        solver: "faer-ldlt".into(),
        representation: "smear".into(),
        post_steps: Vec::new(),
        provisional: false,
        cancel: None,
        on_progress: None,
    })
    .unwrap_or_else(|err| panic!("{}", err.message))
}

#[test]
fn a_sparse_core_is_a_fifth_as_safe_as_the_solid_bar() {
    let solid = bar(1.0, [1.0, 0.0, 0.0]).min_safety_factor.unwrap();
    let core = bar(0.2, [1.0, 0.0, 0.0]).min_safety_factor.unwrap();
    let ratio = core / solid;
    assert!(
        (ratio - 0.2).abs() < 0.002,
        "core {core} solid {solid} ratio {ratio}"
    );
}

#[test]
fn pure_compression_uses_the_compression_allowable() {
    let sigma = 10.0;
    let sf = MaxStress.safety(
        &Stress {
            v: [-sigma, 0.0, 0.0, 0.0, 0.0, 0.0],
        },
        &card().allowables(),
        &ctx(1.0),
    );
    assert!(
        (sf - card().compression_in_plane_mpa / sigma).abs() < 1e-9,
        "sf {sf}"
    );
    // The end traction is 1 MPa. Away from the fixed root the section stress
    // is that compression, and the factor is the allowable over it.
    let solved = bar(1.0, [-1.0, 0.0, 0.0]);
    let mut best: Option<(f64, [f64; 6])> = None;
    for sample in &solved.gauss {
        let d = (sample.xyz[0] - 10.0).powi(2)
            + (sample.xyz[1] - 5.0).powi(2)
            + (sample.xyz[2] - 5.0).powi(2);
        if best.map(|(s, _)| d < s).unwrap_or(true) {
            best = Some((d, sample.stress));
        }
    }
    let (_, stress) = best.expect("a gauss point at mid-span");
    let sigma = -stress[0];
    let sf_bar = MaxStress.safety(&Stress { v: stress }, &card().allowables(), &ctx(1.0));
    assert!(
        (sigma - 1.0).abs() < 0.05,
        "mid-span compression {sigma} from {stress:?}"
    );
    let expect = card().compression_in_plane_mpa / sigma;
    assert!(
        (sf_bar - expect).abs() / expect < 0.01,
        "sf {sf_bar} expect {expect}"
    );
}

#[test]
fn interlayer_shear_uses_its_allowable_and_in_plane_shear_does_not() {
    let tau = 5.0;
    let allow = card().allowables();
    let shear_sf = allow.shear_across_layers_mpa / tau;
    // Global yz and zx are the layer-normal shears once the build frame is +Z.
    for stress in [
        [0.0, 0.0, 0.0, 0.0, tau, 0.0],
        [0.0, 0.0, 0.0, 0.0, 0.0, tau],
    ] {
        let sf = MaxStress.safety(&Stress { v: stress }, &allow, &ctx(1.0));
        assert!((sf - shear_sf).abs() < 1e-9, "sf {sf} stress {stress:?}");
    }
    let in_plane = MaxStress.safety(
        &Stress {
            v: [0.0, 0.0, 0.0, tau, 0.0, 0.0],
        },
        &allow,
        &ctx(1.0),
    );
    // In-plane shear opens principals of ±τ. Those use the tension and
    // compression allowables, not the interlayer shear allowable.
    let principal = allow.compression_in_plane_mpa.min(allow.in_plane_mpa) / tau;
    assert!(
        (in_plane - principal).abs() < 1e-6,
        "in-plane {in_plane} principal {principal} shear {shear_sf}"
    );
    assert!((in_plane - shear_sf).abs() > 0.1);
}
