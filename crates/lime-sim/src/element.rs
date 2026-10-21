//! Tetrahedra. TET10 is the element a study may ask for. TET4 stays for the
//! patch test and the locking regression; a study that names it is refused.

use faer::Mat;
use std::sync::LazyLock;

use crate::material::{MatState, MaterialContext, MaterialModel};

/// What a cell is. Later kinds are named so a file can say them, and the
/// study is refused with that name rather than dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElementKind {
    Tet4,
    Tet10,
    Hex8,
    Hex20,
    Wedge6,
    Wedge15,
    ShellQuad,
    Other,
}

impl ElementKind {
    pub fn parse(name: &str) -> (Self, String) {
        let kind = match name {
            "tet4" => Self::Tet4,
            "tet10" => Self::Tet10,
            "hex8" => Self::Hex8,
            "hex20" => Self::Hex20,
            "wedge6" => Self::Wedge6,
            "wedge15" => Self::Wedge15,
            "shell-quad" => Self::ShellQuad,
            _ => Self::Other,
        };
        (kind, name.to_string())
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Tet4 => "tet4",
            Self::Tet10 => "tet10",
            Self::Hex8 => "hex8",
            Self::Hex20 => "hex20",
            Self::Wedge6 => "wedge6",
            Self::Wedge15 => "wedge15",
            Self::ShellQuad => "shell-quad",
            Self::Other => "unknown",
        }
    }

    pub fn corner_nodes(self) -> usize {
        match self {
            Self::Tet4 | Self::Tet10 => 4,
            _ => 0,
        }
    }

    pub fn nodes(self) -> usize {
        match self {
            Self::Tet4 => 4,
            Self::Tet10 => 10,
            _ => 0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Shape {
    pub n: Vec<f64>,
    pub dn_dxi: Vec<[f64; 3]>,
}

#[derive(Clone, Copy, Debug)]
pub struct GaussPoint {
    pub xi: [f64; 3],
    pub weight: f64,
}

pub struct GaussContext<'a> {
    pub coords: &'a [[f64; 3]],
    pub displacement: &'a [f64],
    pub material: &'a dyn MaterialModel,
    pub mat_ctx: &'a MaterialContext,
    pub state: &'a mut MatState,
    /// Grams per cubic millimetre, already scaled by the region's fraction.
    pub density_g_per_mm3: f64,
}

pub struct ElementOut {
    pub ke: Mat<f64>,
    pub fe: Vec<f64>,
    pub me: Option<Mat<f64>>,
}

impl ElementOut {
    pub fn zeros(nd: usize) -> Self {
        Self {
            ke: Mat::zeros(nd, nd),
            fe: vec![0.0; nd],
            me: Some(Mat::zeros(nd, nd)),
        }
    }
}

pub trait Element {
    fn kind(&self) -> ElementKind;
    fn nodes(&self) -> usize;
    fn dofs_per_node(&self) -> usize;
    fn shape(&self, xi: [f64; 3]) -> Shape;
    fn quadrature(&self) -> &'static [GaussPoint];
    fn contribute(&self, at: &GaussPoint, ctx: &mut GaussContext, out: &mut ElementOut);
}

pub struct Tet4;

pub struct Tet10;

impl Element for Tet4 {
    fn kind(&self) -> ElementKind {
        ElementKind::Tet4
    }
    fn nodes(&self) -> usize {
        4
    }
    fn dofs_per_node(&self) -> usize {
        3
    }
    fn shape(&self, xi: [f64; 3]) -> Shape {
        tet4_shape(xi)
    }
    fn quadrature(&self) -> &'static [GaussPoint] {
        tet4_quadrature()
    }
    fn contribute(&self, at: &GaussPoint, ctx: &mut GaussContext, out: &mut ElementOut) {
        contribute(self, at, ctx, out);
    }
}

impl Element for Tet10 {
    fn kind(&self) -> ElementKind {
        ElementKind::Tet10
    }
    fn nodes(&self) -> usize {
        10
    }
    fn dofs_per_node(&self) -> usize {
        3
    }
    fn shape(&self, xi: [f64; 3]) -> Shape {
        tet10_shape(xi)
    }
    fn quadrature(&self) -> &'static [GaussPoint] {
        tet10_quadrature()
    }
    fn contribute(&self, at: &GaussPoint, ctx: &mut GaussContext, out: &mut ElementOut) {
        contribute(self, at, ctx, out);
    }
}

pub fn element(kind: ElementKind) -> Option<&'static dyn Element> {
    match kind {
        ElementKind::Tet4 => Some(&Tet4),
        ElementKind::Tet10 => Some(&Tet10),
        _ => None,
    }
}

pub fn tet4_shape(xi: [f64; 3]) -> Shape {
    let l1 = 1.0 - xi[0] - xi[1] - xi[2];
    Shape {
        n: vec![l1, xi[0], xi[1], xi[2]],
        dn_dxi: vec![
            [-1.0, -1.0, -1.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
    }
}

pub fn tet10_shape(xi: [f64; 3]) -> Shape {
    let (x, y, z) = (xi[0], xi[1], xi[2]);
    let l1 = 1.0 - x - y - z;
    let (l2, l3, l4) = (x, y, z);
    Shape {
        n: vec![
            l1 * (2.0 * l1 - 1.0),
            l2 * (2.0 * l2 - 1.0),
            l3 * (2.0 * l3 - 1.0),
            l4 * (2.0 * l4 - 1.0),
            4.0 * l1 * l2,
            4.0 * l2 * l3,
            4.0 * l3 * l1,
            4.0 * l1 * l4,
            4.0 * l2 * l4,
            4.0 * l3 * l4,
        ],
        dn_dxi: vec![
            [-(4.0 * l1 - 1.0), -(4.0 * l1 - 1.0), -(4.0 * l1 - 1.0)],
            [4.0 * l2 - 1.0, 0.0, 0.0],
            [0.0, 4.0 * l3 - 1.0, 0.0],
            [0.0, 0.0, 4.0 * l4 - 1.0],
            [4.0 * (l1 - l2), -4.0 * l2, -4.0 * l2],
            [4.0 * l3, 4.0 * l2, 0.0],
            [-4.0 * l3, 4.0 * (l1 - l3), -4.0 * l3],
            [-4.0 * l4, -4.0 * l4, 4.0 * (l1 - l4)],
            [4.0 * l4, 0.0, 4.0 * l2],
            [0.0, 4.0 * l4, 4.0 * l3],
        ],
    }
}

fn tet4_quadrature() -> &'static [GaussPoint] {
    static RULE: LazyLock<Vec<GaussPoint>> = LazyLock::new(|| {
        vec![GaussPoint {
            xi: [0.25, 0.25, 0.25],
            weight: 1.0 / 6.0,
        }]
    });
    &RULE
}

/// Four-point rule, exact for quadratics. The five-point rule is the one a
/// nonlinear material would ask the element for.
pub fn tet10_quadrature() -> &'static [GaussPoint] {
    static RULE: LazyLock<Vec<GaussPoint>> = LazyLock::new(|| {
        let sqrt5 = 5.0_f64.sqrt();
        let b = (5.0 - sqrt5) / 20.0;
        let a = (5.0 + 3.0 * sqrt5) / 20.0;
        let w = 1.0 / 24.0;
        vec![
            GaussPoint {
                xi: [b, b, b],
                weight: w,
            },
            GaussPoint {
                xi: [a, b, b],
                weight: w,
            },
            GaussPoint {
                xi: [b, a, b],
                weight: w,
            },
            GaussPoint {
                xi: [b, b, a],
                weight: w,
            },
        ]
    });
    &RULE
}

pub fn tet10_quadrature_cubic() -> &'static [GaussPoint] {
    static RULE: LazyLock<Vec<GaussPoint>> = LazyLock::new(|| {
        let w_c = -2.0 / 15.0;
        let w = 3.0 / 40.0;
        let s = 1.0 / 6.0;
        let a = 0.5;
        vec![
            GaussPoint {
                xi: [0.25, 0.25, 0.25],
                weight: w_c,
            },
            GaussPoint {
                xi: [a, s, s],
                weight: w,
            },
            GaussPoint {
                xi: [s, a, s],
                weight: w,
            },
            GaussPoint {
                xi: [s, s, a],
                weight: w,
            },
            GaussPoint {
                xi: [s, s, s],
                weight: w,
            },
        ]
    });
    &RULE
}

pub fn det3(m: &[[f64; 3]; 3]) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

pub fn inv3(m: &[[f64; 3]; 3]) -> Option<([[f64; 3]; 3], f64)> {
    let d = det3(m);
    if !d.is_finite() || d.abs() < 1e-30 {
        return None;
    }
    let s = 1.0 / d;
    Some((
        [
            [
                (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * s,
                (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * s,
                (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * s,
            ],
            [
                (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * s,
                (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * s,
                (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * s,
            ],
            [
                (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * s,
                (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * s,
                (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * s,
            ],
        ],
        d,
    ))
}

/// Physical gradients and |det J|. `None` when the element is flat.
pub fn gradients(dn_dxi: &[[f64; 3]], coords: &[[f64; 3]]) -> Option<(Vec<[f64; 3]>, f64)> {
    let n = dn_dxi.len();
    let mut jac = [[0.0; 3]; 3];
    for a in 0..n {
        for i in 0..3 {
            for k in 0..3 {
                jac[i][k] += dn_dxi[a][k] * coords[a][i];
            }
        }
    }
    let (inv, det) = inv3(&jac)?;
    let mut grad = vec![[0.0; 3]; n];
    for a in 0..n {
        for i in 0..3 {
            // dN/dx_i = sum_k inv(J)[k][i] * dN/dξ_k
            grad[a][i] =
                inv[0][i] * dn_dxi[a][0] + inv[1][i] * dn_dxi[a][1] + inv[2][i] * dn_dxi[a][2];
        }
    }
    Some((grad, det.abs()))
}

#[allow(clippy::erasing_op, clippy::identity_op)]
fn contribute(elem: &dyn Element, at: &GaussPoint, ctx: &mut GaussContext, out: &mut ElementOut) {
    let shape = elem.shape(at.xi);
    let Some((grad, det)) = gradients(&shape.dn_dxi, ctx.coords) else {
        return;
    };
    let scale = at.weight * det;
    let nnode = elem.nodes();
    let nd = nnode * 3;
    let mut strain = [0.0; 6];
    for a in 0..nnode {
        let g = grad[a];
        let u = &ctx.displacement[3 * a..3 * a + 3];
        strain[0] += g[0] * u[0];
        strain[1] += g[1] * u[1];
        strain[2] += g[2] * u[2];
        strain[3] += g[1] * u[0] + g[0] * u[1];
        strain[4] += g[2] * u[1] + g[1] * u[2];
        strain[5] += g[0] * u[2] + g[2] * u[0];
    }
    let (stress, tangent) = ctx.material.stress_tangent(&strain, ctx.state, ctx.mat_ctx);
    let mut b = vec![0.0; 6 * nd];
    for a in 0..nnode {
        let g = grad[a];
        let c0 = 3 * a;
        // xx, yy, zz, xy, yz, zx
        b[0 * nd + c0] = g[0];
        b[1 * nd + c0 + 1] = g[1];
        b[2 * nd + c0 + 2] = g[2];
        b[3 * nd + c0] = g[1];
        b[3 * nd + c0 + 1] = g[0];
        b[4 * nd + c0 + 1] = g[2];
        b[4 * nd + c0 + 2] = g[1];
        b[5 * nd + c0] = g[2];
        b[5 * nd + c0 + 2] = g[0];
    }
    let mut cb = vec![0.0; 6 * nd];
    for i in 0..6 {
        for j in 0..nd {
            let mut s = 0.0;
            for k in 0..6 {
                s += tangent.c[i][k] * b[k * nd + j];
            }
            cb[i * nd + j] = s;
        }
    }
    for i in 0..nd {
        let mut f = 0.0;
        for k in 0..6 {
            f += b[k * nd + i] * stress.v[k];
        }
        out.fe[i] += scale * f;
        for j in 0..nd {
            let mut s = 0.0;
            for k in 0..6 {
                s += b[k * nd + i] * cb[k * nd + j];
            }
            out.ke[(i, j)] += scale * s;
        }
    }
    if let Some(me) = out.me.as_mut() {
        let rho = ctx.density_g_per_mm3;
        for a in 0..nnode {
            for b in 0..nnode {
                let m = rho * shape.n[a] * shape.n[b] * scale;
                for d in 0..3 {
                    me[(3 * a + d, 3 * b + d)] += m;
                }
            }
        }
    }
}

/// Strain, stress and the integration weight at one point. Used by recovery.
pub struct Sample {
    pub xi: [f64; 3],
    pub weight_det: f64,
    pub stress: [f64; 6],
    pub strain: [f64; 6],
}

pub fn sample_element(
    kind: ElementKind,
    coords: &[[f64; 3]],
    displacement: &[f64],
    material: &dyn MaterialModel,
    mat_ctx: &MaterialContext,
) -> Vec<Sample> {
    let Some(elem) = element(kind) else {
        return Vec::new();
    };
    let mut state = MatState::default();
    let mut out = Vec::new();
    for gp in elem.quadrature() {
        let shape = elem.shape(gp.xi);
        let Some((grad, det)) = gradients(&shape.dn_dxi, coords) else {
            continue;
        };
        let nnode = elem.nodes();
        let mut strain = [0.0; 6];
        for a in 0..nnode {
            let g = grad[a];
            let u = &displacement[3 * a..3 * a + 3];
            strain[0] += g[0] * u[0];
            strain[1] += g[1] * u[1];
            strain[2] += g[2] * u[2];
            strain[3] += g[1] * u[0] + g[0] * u[1];
            strain[4] += g[2] * u[1] + g[1] * u[2];
            strain[5] += g[0] * u[2] + g[2] * u[0];
        }
        let (stress, _) = material.stress_tangent(&strain, &mut state, mat_ctx);
        out.push(Sample {
            xi: gp.xi,
            weight_det: gp.weight * det,
            stress: stress.v,
            strain,
        });
    }
    out
}

pub fn shape_of(kind: ElementKind, xi: [f64; 3]) -> Shape {
    match kind {
        ElementKind::Tet4 => tet4_shape(xi),
        _ => tet10_shape(xi),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_functions_partition_unity() {
        let xi = [0.2, 0.15, 0.25];
        for shape in [tet4_shape(xi), tet10_shape(xi)] {
            let sum: f64 = shape.n.iter().sum();
            assert!((sum - 1.0).abs() < 1e-12);
            let mut d = [0.0; 3];
            for g in &shape.dn_dxi {
                d[0] += g[0];
                d[1] += g[1];
                d[2] += g[2];
            }
            assert!(d[0].abs() < 1e-12 && d[1].abs() < 1e-12 && d[2].abs() < 1e-12);
        }
    }

    #[test]
    fn tet10_derivatives_match_a_finite_difference() {
        let xi = [0.22, 0.18, 0.27];
        let h = 1e-6;
        let base = tet10_shape(xi);
        for axis in 0..3 {
            let mut plus = xi;
            let mut minus = xi;
            plus[axis] += h;
            minus[axis] -= h;
            let sp = tet10_shape(plus);
            let sm = tet10_shape(minus);
            for a in 0..10 {
                let num = (sp.n[a] - sm.n[a]) / (2.0 * h);
                assert!(
                    (num - base.dn_dxi[a][axis]).abs() < 1e-6,
                    "node {a} axis {axis}: {num} vs {}",
                    base.dn_dxi[a][axis]
                );
            }
        }
    }

    #[test]
    fn four_point_rule_integrates_a_quadratic() {
        // ∫ ξ² dV over the reference tet is 1/60. The four-point rule is exact
        // for degree 2, so it has to land on that.
        let mut acc = 0.0;
        for gp in tet10_quadrature() {
            acc += gp.xi[0] * gp.xi[0] * gp.weight;
        }
        assert!((acc - 1.0 / 60.0).abs() < 1e-12);
        let mut vol = 0.0;
        for gp in tet10_quadrature() {
            vol += gp.weight;
        }
        assert!((vol - 1.0 / 6.0).abs() < 1e-15);
    }
}
