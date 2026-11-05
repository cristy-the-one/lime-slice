use super::*;
use crate::support::edit::{gaps_in, SupportEdit, TipSite};
use crate::support::{End, NodeId};

/// What pruning costs against planning supports from scratch, on the mesh
/// at `LIME_EDIT_MESH` under toughness. Prints one line per case.
///
/// LIME_EDIT_MESH=/path/part.stp cargo test -p lime-slice-core --release --lib edit_cost -- --ignored --nocapture
#[test]
#[ignore = "needs LIME_EDIT_MESH"]
fn edit_cost() {
    let path = std::env::var("LIME_EDIT_MESH").expect("set LIME_EDIT_MESH to a mesh path");
    let bytes = std::fs::read(&path).unwrap();
    let mesh = load_slice_mesh_tol(&path, &bytes, false, 0.1).unwrap();
    let blend = BlendMode::Single {
        strategy: StrategyId::Toughness,
    };
    let settings = SliceSettings {
        supports: true,
        ..SliceSettings::default()
    };
    let bounds = mesh.bounds().unwrap();
    let bands = plan_bands(
        &mesh,
        &HeightOpts {
            nominal: settings.layer_height,
            adaptive: false,
            min_h: settings.adaptive_min,
            max_h: settings.layer_height,
        },
    )
    .unwrap();
    let index = ZIndex::build(&mesh);
    let tolerance = outline_tolerance(&settings, 0.4);
    let contours: Vec<Vec<Loop>> = bands
        .par_iter()
        .map(|b| simplify_loops(index.slice(b.cut_z()), tolerance))
        .collect();
    let object = Contours::new(bands, contours, bounds, &settings);
    let plan = || plan_supports(&object, &blend, &settings, None, None, &Watch::idle()).unwrap();

    let started = Instant::now();
    let base = plan();
    let full_ms = elapsed_ms(started);
    let limbs = &base.supports.forest.limbs;
    let knots: usize = limbs.iter().map(|l| l.knots.len()).sum();
    let disks: usize = base.supports.layers.iter().map(|l| l.disks.len()).sum();
    println!(
        "full plan_supports {full_ms:.0} ms (supports {:.0} ms, paths {:.0} ms); {} layers, {} limbs, {knots} knots of {} B, layer index {:.1} MB, knots {:.1} MB; storing raw disks instead would be up to one per knot at {} B, {:.1} MB; {disks} printed disks",
        base.support_ms,
        base.toolpath_ms,
        object.bands.len(),
        limbs.len(),
        std::mem::size_of_val(&limbs[0].knots[0]),
        knots as f64 * 4.0 / 1e6,
        knots as f64 * std::mem::size_of_val(&limbs[0].knots[0]) as f64 / 1e6,
        std::mem::size_of::<Disk>(),
        knots as f64 * std::mem::size_of::<Disk>() as f64 / 1e6,
    );
    let started = Instant::now();
    base.supports.coverage(&object.bands, &object.contours);
    println!("one coverage pass {:.0} ms", elapsed_ms(started));

    // Limbs in each branch, counted up from the youngest guest.
    let mut branch = vec![1usize; limbs.len()];
    for k in (0..limbs.len()).rev() {
        if let End::Merged { into } = limbs[k].end {
            branch[into.0 as usize - 1] += branch[k];
        }
    }
    let median = |mut ks: Vec<usize>| {
        ks.sort_by_key(|&k| (branch[k], k));
        ks[ks.len() / 2]
    };
    let merged = |k: usize| matches!(limbs[k].end, End::Merged { .. });
    let mut trees: Vec<usize> = (0..limbs.len()).filter(|&k| !merged(k)).collect();
    trees.sort_by_key(|&k| (branch[k], k));
    let tips = |at: f64| branch[trees[((trees.len() - 1) as f64 * at) as usize]];
    println!(
        "{} trees, tips per tree: median {}, p90 {}, p99 {}, max {}",
        trees.len(),
        tips(0.5),
        tips(0.9),
        tips(0.99),
        tips(1.0)
    );
    let tree = median(
        (0..limbs.len())
            .filter(|&k| !merged(k) && branch[k] >= 10)
            .collect(),
    );
    let largest = *trees.last().unwrap();
    let guest = median(
        (0..limbs.len())
            .filter(|&k| merged(k) && branch[k] >= 2)
            .collect(),
    );
    let bands = &object.bands;
    let id = |k: usize| NodeId(k as u32 + 1);
    let mut seed = 0x2545_F491_4F6C_DD1Du64;
    let subset: Vec<TipSite> = (0..limbs.len())
        .filter(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % 100 == 0
        })
        .map(|k| base.supports.limb_site(id(k), bands))
        .collect();
    let cases = [
        ("mid-size tree", base.supports.tree_sites(id(tree), bands)),
        ("largest tree", base.supports.tree_sites(id(largest), bands)),
        ("one branch", base.supports.branch_sites(id(guest), bands)),
        ("1% of tips", subset),
    ];
    let mid = cases[0].1.clone();
    let warned = |p: &SupportPlan| {
        let area: f64 = p.coverage.iter().map(|g| f64::from(g.area_mm2)).sum();
        (p.coverage.len(), (area * 10.0).round() / 10.0)
    };
    let warned_built = warned(&base);
    let built = base
        .supports
        .coverage_from(&object.bands, &object.contours, 0.0);
    drop(base);
    for (name, sites) in cases {
        let mut plan = plan();
        let tips = sites.len();
        let edit = [SupportEdit::Prune { sites }];
        let started = Instant::now();
        let out = Arc::make_mut(&mut plan.supports).apply(&edit, &object.bands, &object.contours);
        let apply_ms = elapsed_ms(started);
        let started = Instant::now();
        let painted = plan.refresh(&object, &out[0].changed, &blend, &settings);
        let refresh_ms = elapsed_ms(started);
        let same = plan.supports.layers == plan.supports.rebuilt(&object.bands, &object.contours);
        println!(
            "{name}: {tips} tips, {:?}, apply {apply_ms:.0} ms, {} layers changed in {:?}, stood {}, refresh {refresh_ms:.0} ms repainting {} layers, newly floating {:.1} mm2, incremental == full {same}",
            out[0].status,
            out[0].changed.len(),
            out[0].changed.first().zip(out[0].changed.last()),
            out[0].stood,
            painted.len(),
            out[0].newly_floating_mm2,
        );
        assert!(
            same,
            "{name}: the incremental rebuild differs from a full one"
        );
    }

    let mut plan = plan();
    let pruned = Arc::make_mut(&mut plan.supports).apply(
        &[SupportEdit::Prune { sites: mid }],
        &object.bands,
        &object.contours,
    );
    plan.refresh(&object, &pruned[0].changed, &blend, &settings);
    let edit = [SupportEdit::over_gaps(&pruned[0].floating)];
    let SupportEdit::Regrow { region, z } = &edit[0] else {
        unreachable!()
    };
    let area = |gaps: &[CoverageGap]| -> f64 {
        gaps_in(gaps, region, *z)
            .iter()
            .map(|g| f64::from(g.area_mm2))
            .sum()
    };
    let (limbs, warned_before) = (plan.supports.forest.limbs.len(), warned(&plan));
    let started = Instant::now();
    let out = Arc::make_mut(&mut plan.supports).apply(&edit, &object.bands, &object.contours);
    let apply_ms = elapsed_ms(started);
    let started = Instant::now();
    let painted = plan.refresh(&object, &out[0].changed, &blend, &settings);
    let refresh_ms = elapsed_ms(started);
    let same = plan.supports.layers == plan.supports.rebuilt(&object.bands, &object.contours);
    let (now, was) = (area(&out[0].floating), area(&built));
    println!(
        "mid-size tree pruned then regrown over its {} gaps: {:?}, apply {apply_ms:.0} ms, {} limbs grown, {} layers changed in {:?}, stood {}, refresh {refresh_ms:.0} ms repainting {} layers, warned coverage {warned_built:?} as built, {warned_before:?} pruned, {:?} regrown (gaps, mm2), newly floating {:.1} mm2, in the region {now:.1} mm2 against {was:.1} mm2 as built, incremental == full {same}",
        pruned[0].floating.len(),
        out[0].status,
        plan.supports.forest.limbs.len() - limbs,
        out[0].changed.len(),
        out[0].changed.first().zip(out[0].changed.last()),
        out[0].stood,
        painted.len(),
        warned(&plan),
        out[0].newly_floating_mm2,
    );
    assert!(
        same,
        "regrow: the incremental rebuild differs from a full one"
    );
    assert!(
        now <= was + 1e-3,
        "the regrown region floats {now} mm2, more than the {was} mm2 it did as built"
    );
}
