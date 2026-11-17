//! How long a shell solve takes, by triangle count. Ignored in the default
//! run; measure it in release:
//!
//! `cargo test -p lime-sim --release --test shell_timing -- --ignored --nocapture`

mod shell_common;

use std::time::Instant;

use lime_sim::shell::{Rib, RibSection, RibSide, ShellMesh, ShellModel, ShellOptions};
use shell_common::*;

#[test]
#[ignore]
fn solve_time_by_triangle_count() {
    let a = 100.0;
    eprintln!("| triangles | free dofs | assemble shell s | analyse s | ribs s | factor s | solve s | recover s | total first solve s | re-solve after a rib change s |");
    eprintln!("|---|---|---|---|---|---|---|---|---|---|");
    for n in [32, 50, 71, 100, 160] {
        let started = Instant::now();
        let mesh = ShellMesh::rectangle([a, a], [n, n], 2.0);
        let triangles = mesh.triangles.len();
        let holds = rectangle_holds(&mesh, a, a, Edge::Clamped);
        let mut model = ShellModel::new(
            mesh,
            material(2000.0, 0.35),
            &holds,
            ShellOptions::default(),
        )
        .unwrap();
        // Four ribs, as a planner's early candidate set would have.
        let ribs: Vec<Rib> = [n / 5, 2 * n / 5, 3 * n / 5, 4 * n / 5]
            .iter()
            .map(|&j| Rib {
                edges: (0..n)
                    .map(|i| (((n + 1) * j + i) as u32, ((n + 1) * j + i + 1) as u32))
                    .collect(),
                section: RibSection::rectangular(1.6),
                height: 6.0,
                side: RibSide::Positive,
            })
            .collect();
        model.set_ribs(ribs).unwrap();
        let case = pressure(model.mesh(), 0.01);
        let r = model.solve(&case).unwrap();
        let first = started.elapsed().as_secs_f64();
        let t = model.timings();
        // The planner's loop: drop a rib, re-solve.
        let again = Instant::now();
        model.remove_rib(0).unwrap();
        let r2 = model.solve(&case).unwrap();
        let resolve = again.elapsed().as_secs_f64();
        assert!(r2.strain_energy > r.strain_energy);
        eprintln!(
            "| {triangles} | {} | {:.3} | {:.3} | {:.4} | {:.3} | {:.3} | {:.3} | {first:.3} | {resolve:.3} |",
            model.free_dofs(),
            t.assemble_shell,
            t.analyse,
            t.assemble_ribs,
            t.factor,
            t.solve,
            t.recover,
        );
    }
}
