//! The two comparisons every plan carries, with the same solver,
//! material, holds and loads: the wall thickened evenly, and an even
//! orthogonal grid of the plan's rib section, each searched to the plan's
//! compliance. A pattern can only claim to save material against these
//! (the academic notes, §6.7).

use std::collections::{BTreeMap, HashMap};

use crate::error::SimError;
use crate::shell::{IsotropicShell, LoadCase, ShellHold, ShellMesh, ShellModel, ShellOptions};
use crate::units::{add, scale, sub};

use super::select::{network_volume, DRib};
use super::surface::Surface;
use super::trace::{simplify, Family};
use super::{
    edge_caps, remap_cases, resolve_holds, GridBaseline, Holds, RibRules, ThickeningBaseline,
};

/// The even added thickness at which the bare wall's compliance is
/// `target`. Regula falsi (Illinois) on log compliance; the answer is the
/// linear interpolation between the bracketing solves, within 0.2 %.
pub(crate) fn thickening(
    mesh: &ShellMesh,
    material: IsotropicShell,
    holds: &[ShellHold],
    cases: &[LoadCase],
    c0: f64,
    target: f64,
) -> Result<ThickeningBaseline, SimError> {
    let area: f64 = mesh
        .triangles
        .iter()
        .map(|t| {
            let p = t.map(|v| mesh.vertices[v as usize]);
            0.5 * crate::units::norm(crate::units::cross(sub(p[1], p[0]), sub(p[2], p[0])))
        })
        .sum();
    if target >= c0 {
        return Ok(ThickeningBaseline {
            added_thickness_mm: 0.0,
            added_volume_mm3: 0.0,
            compliance: c0,
            solves: 0,
        });
    }
    let mean_t = mesh.thickness.iter().sum::<f64>() / mesh.thickness.len() as f64;
    let mut solves = 0;
    let mut f = |dt: f64| -> Result<f64, SimError> {
        let mut m = mesh.clone();
        for t in &mut m.thickness {
            *t += dt;
        }
        let mut model = ShellModel::new(m, material, holds, ShellOptions::default())?;
        let r = model.solve_cases(cases)?;
        solves += 1;
        Ok(r.iter().map(|x| x.compliance).sum::<f64>())
    };
    let g = |c: f64| c.ln() - target.ln();
    let (mut lo, mut glo) = (0.0, g(c0));
    // Plate bending: compliance goes as t⁻³.
    let mut hi = mean_t * ((c0 / target).powf(1.0 / 3.0) - 1.0);
    let mut chi = f(hi)?;
    let mut ghi = g(chi);
    let mut grow = 0;
    while ghi > 0.0 && grow < 8 {
        lo = hi;
        glo = ghi;
        hi *= 2.0;
        chi = f(hi)?;
        ghi = g(chi);
        grow += 1;
    }
    let mut side = 0;
    for _ in 0..12 {
        if ghi.abs() < 2e-3 {
            break;
        }
        let x = hi - ghi * (hi - lo) / (ghi - glo);
        let cx = f(x)?;
        let gx = g(cx);
        if gx > 0.0 {
            lo = x;
            glo = gx;
            if side == -1 {
                ghi *= 0.5;
            }
            side = -1;
        } else {
            hi = x;
            ghi = gx;
            chi = cx;
            if side == 1 {
                glo *= 0.5;
            }
            side = 1;
        }
    }
    let dt = if (glo - ghi).abs() > 0.0 && ghi.abs() >= 2e-3 {
        hi - ghi * (hi - lo) / (ghi - glo)
    } else {
        hi
    };
    Ok(ThickeningBaseline {
        added_thickness_mm: dt,
        added_volume_mm3: dt * area,
        compliance: chi,
        solves,
    })
}

pub(crate) struct GridInput<'a> {
    pub surface: &'a Surface,
    pub blocked: &'a [bool],
    /// Height cap per input triangle.
    pub tri_cap: &'a [f64],
    pub rules: &'a RibRules,
    pub material: IsotropicShell,
    pub holds: &'a Holds,
    pub cases: &'a [LoadCase],
    pub target: f64,
    pub tolerance: f64,
}

struct GridEval {
    pitch: f64,
    volume: f64,
    compliance: f64,
}

/// The even grid at the plan's compliance. The pitch is searched by
/// bisection in log pitch between `min_spacing` and the longer extent;
/// line counts are `round(extent / pitch)` per axis, lines at the centres
/// of equal bands.
pub(crate) fn grid(input: &GridInput) -> Result<GridBaseline, SimError> {
    let s = input.surface;
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for p in &s.pos {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let ext = [0, 1, 2].map(|k| hi[k] - lo[k]);
    let mut axes = [0usize, 1, 2];
    axes.sort_by(|&a, &b| ext[b].total_cmp(&ext[a]).then(a.cmp(&b)));
    let axes = [axes[0], axes[1]];
    let mut cache: BTreeMap<[usize; 2], GridEval> = BTreeMap::new();
    let mut solves = 0;
    let mut eval = |pitch: f64, solves: &mut usize| -> Result<([usize; 2], f64, f64), SimError> {
        let lines = axes.map(|a| ((ext[a] / pitch).round() as usize).max(1));
        if let Some(e) = cache.get(&lines) {
            return Ok((lines, e.volume, e.compliance));
        }
        let (volume, compliance) = grid_design(input, axes, lo, ext, lines)?;
        *solves += 1;
        cache.insert(
            lines,
            GridEval {
                pitch,
                volume,
                compliance,
            },
        );
        Ok((lines, volume, compliance))
    };
    let p_min = input.rules.min_spacing;
    let p_max = ext[axes[0]].max(p_min);
    let (_, v_min, c_min) = eval(p_min, &mut solves)?;
    if c_min > input.target {
        return Ok(GridBaseline {
            reached: false,
            pitch_mm: p_min,
            lines: axes.map(|a| ((ext[a] / p_min).round() as usize).max(1)),
            grid_volume_mm3: v_min,
            compliance: c_min,
            volume_mm3: None,
            solves,
        });
    }
    // Largest pitch that still reaches the target.
    let (mut reach, mut fail) = (p_min, p_max);
    let (_, _, c_max) = eval(p_max, &mut solves)?;
    if c_max <= input.target {
        reach = p_max;
    } else {
        for _ in 0..12 {
            let mid = (reach * fail).sqrt();
            let (_, _, c) = eval(mid, &mut solves)?;
            if c <= input.target {
                reach = mid;
            } else {
                fail = mid;
            }
            if fail / reach < 1.02 {
                break;
            }
        }
    }
    let (lr, vr, cr) = eval(reach, &mut solves)?;
    // The nearest coarser grid tried that misses, for interpolation.
    let coarser = cache
        .values()
        .filter(|e| e.compliance > input.target)
        .min_by(|a, b| a.compliance.total_cmp(&b.compliance));
    let volume = match coarser {
        Some(e) if e.compliance > cr => {
            let w = (e.compliance.ln() - input.target.ln()) / (e.compliance.ln() - cr.ln());
            e.volume + w * (vr - e.volume)
        }
        _ => vr,
    };
    let pitch = cache.get(&lr).map_or(reach, |e| e.pitch);
    Ok(GridBaseline {
        reached: true,
        pitch_mm: pitch,
        lines: lr,
        grid_volume_mm3: vr,
        compliance: cr,
        volume_mm3: Some(volume),
        solves,
    })
}

/// Cut the grid into a fresh copy of the wall and solve it: its volume
/// and compliance.
fn grid_design(
    input: &GridInput,
    axes: [usize; 2],
    lo: [f64; 3],
    ext: [f64; 3],
    lines: [usize; 2],
) -> Result<(f64, f64), SimError> {
    let r = input.rules;
    let mut polylines = Vec::new();
    for (k, &a) in axes.iter().enumerate() {
        for i in 0..lines[k] {
            let offset = lo[a] + (i as f64 + 0.5) * ext[a] / lines[k] as f64;
            for p in plane_section(input.surface, input.blocked, a, offset) {
                let p = simplify(&p, input.tolerance);
                let len: f64 = p
                    .windows(2)
                    .map(|w| crate::units::norm(sub(w[1], w[0])))
                    .sum();
                if len >= r.min_length {
                    polylines.push(p);
                }
            }
        }
    }
    let mut s = input.surface.clone();
    let ids: Vec<usize> = polylines
        .iter()
        .filter_map(|p| s.embed_polyline(p))
        .collect();
    let mut design = Vec::new();
    for id in ids {
        let chain = s.chains[id].clone();
        let caps = edge_caps(&s, &chain, input.tri_cap, r.max_height);
        if caps.iter().all(|&h| h < r.min_height) || s.chain_length(&chain) < r.min_length {
            continue;
        }
        let mut d = DRib::fixed(chain, r.max_height, r.width, r.profile);
        d.caps = caps;
        d.family = Family::Major;
        design.push(d);
    }
    let mesh = s.to_mesh();
    let holds = resolve_holds(&s, input.holds);
    let cases = remap_cases(&s, input.cases, input.surface.tris.len());
    let mut model = ShellModel::new(mesh, input.material, &holds, ShellOptions::default())?;
    let ribs = design.iter().flat_map(|d| d.solver_ribs(r.side)).collect();
    model.set_ribs(ribs)?;
    let res = model.solve_cases(&cases)?;
    let c: f64 = res.iter().map(|x| x.compliance).sum();
    Ok((network_volume(&s.pos, &design), c))
}

/// Where the plane `x[axis] = offset` cuts the surface, as polylines,
/// leaving out kept-clear triangles.
pub(crate) fn plane_section(
    s: &Surface,
    blocked: &[bool],
    axis: usize,
    offset: f64,
) -> Vec<Vec<[f64; 3]>> {
    // A vertex on the plane counts as just above it, the same for every
    // triangle it is in.
    let side = |v: u32| {
        let d = s.pos[v as usize][axis] - offset;
        if d.abs() < 1e-9 {
            1e-9
        } else {
            d
        }
    };
    type Key = (u32, u32);
    let mut segs: Vec<([Key; 2], [[f64; 3]; 2])> = Vec::new();
    for (t, tri) in s.tris.iter().enumerate() {
        if blocked[s.parent[t] as usize] {
            continue;
        }
        let mut cut: Vec<(Key, [f64; 3])> = Vec::new();
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            let (da, db) = (side(a), side(b));
            if (da > 0.0) != (db > 0.0) {
                let u = da / (da - db);
                let (pa, pb) = (s.pos[a as usize], s.pos[b as usize]);
                let key = if a < b { (a, b) } else { (b, a) };
                cut.push((key, add(pa, scale(sub(pb, pa), u))));
            }
        }
        if cut.len() == 2 {
            segs.push(([cut[0].0, cut[1].0], [cut[0].1, cut[1].1]));
        }
    }
    let mut at: HashMap<Key, Vec<usize>> = HashMap::new();
    for (i, (keys, _)) in segs.iter().enumerate() {
        for k in keys {
            at.entry(*k).or_default().push(i);
        }
    }
    let mut used = vec![false; segs.len()];
    let mut out = Vec::new();
    // Open chains first (from an end with one segment), then loops.
    let mut starts: Vec<(usize, usize)> = Vec::new();
    for (i, (keys, _)) in segs.iter().enumerate() {
        for (e, k) in keys.iter().enumerate() {
            if at[k].len() == 1 {
                starts.push((i, e));
            }
        }
    }
    let all: Vec<(usize, usize)> = (0..segs.len()).map(|i| (i, 0)).collect();
    for (i0, e0) in starts.into_iter().chain(all) {
        if used[i0] {
            continue;
        }
        let mut pts = vec![segs[i0].1[e0]];
        let mut i = i0;
        let mut e = e0;
        loop {
            used[i] = true;
            let other = 1 - e;
            pts.push(segs[i].1[other]);
            let key = segs[i].0[other];
            let Some(&j) = at[&key].iter().find(|&&j| !used[j]) else {
                break;
            };
            e = if segs[j].0[0] == key { 0 } else { 1 };
            i = j;
        }
        out.push(pts);
    }
    out
}
