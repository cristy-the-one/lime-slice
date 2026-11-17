//! A flat facet's frame and its 2D coordinates, and the quadratic
//! triangle's shape-function derivatives the membrane and the plate share.

use crate::units::{add, cross, dot, norm, scale, sub};

/// An element's local axes in global coordinates: `e1` along the facet's
/// first edge, `normal` by the right-hand rule over its corner order
/// (counter-clockwise seen from the normal), and `e2 = normal × e1`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub e1: [f64; 3],
    pub e2: [f64; 3],
    pub normal: [f64; 3],
}

impl Frame {
    /// Components of a global vector along `e1`, `e2` and `normal`.
    pub fn to_local(&self, v: [f64; 3]) -> [f64; 3] {
        [dot(self.e1, v), dot(self.e2, v), dot(self.normal, v)]
    }

    /// The global vector with components `v` along `e1`, `e2` and `normal`.
    pub fn to_global(&self, v: [f64; 3]) -> [f64; 3] {
        add(
            add(scale(self.e1, v[0]), scale(self.e2, v[1])),
            scale(self.normal, v[2]),
        )
    }

    /// Rows `e1`, `e2`, `normal`: `local = R global`.
    pub(crate) fn rows(&self) -> [[f64; 3]; 3] {
        [self.e1, self.e2, self.normal]
    }
}

/// One facet in its own plane: corner 0 at the origin, corner 1 on `e1`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Tri {
    pub frame: Frame,
    pub xy: [[f64; 2]; 3],
    pub area: f64,
}

/// The facet through three points, or `None` when it has no area.
pub(crate) fn triangle(p: [[f64; 3]; 3]) -> Option<Tri> {
    let a = sub(p[1], p[0]);
    let b = sub(p[2], p[0]);
    let c = sub(p[2], p[1]);
    let la = norm(a);
    let longest = la.max(norm(b)).max(norm(c));
    let nn = cross(a, b);
    let twice = norm(nn);
    // NaN-safe: a NaN length or area fails the finite checks.
    if !la.is_finite() || la <= 0.0 || !twice.is_finite() || twice <= 1e-12 * longest * longest {
        return None;
    }
    let e1 = scale(a, 1.0 / la);
    let normal = scale(nn, 1.0 / twice);
    let e2 = cross(normal, e1);
    Some(Tri {
        frame: Frame { e1, e2, normal },
        xy: [[0.0, 0.0], [la, 0.0], [dot(b, e1), dot(b, e2)]],
        area: 0.5 * twice,
    })
}

/// `b_i = y_j − y_k`, `c_i = x_k − x_j` over the cyclic corners, and twice
/// the area: `∂L_i/∂x = b_i / 2A`, `∂L_i/∂y = c_i / 2A`.
pub(crate) fn area_gradients(xy: &[[f64; 2]; 3]) -> ([f64; 3], [f64; 3], f64) {
    let mut b = [0.0; 3];
    let mut c = [0.0; 3];
    for i in 0..3 {
        let j = (i + 1) % 3;
        let k = (i + 2) % 3;
        b[i] = xy[j][1] - xy[k][1];
        c[i] = xy[k][0] - xy[j][0];
    }
    let two_a = (xy[1][0] - xy[0][0]) * (xy[2][1] - xy[0][1])
        - (xy[2][0] - xy[0][0]) * (xy[1][1] - xy[0][1]);
    (b, c, two_a)
}

/// The midside nodes of the quadratic triangle: node 3 on edge 0–1, node 4
/// on edge 1–2, node 5 on edge 2–0.
pub(crate) const EDGES: [(usize, usize); 3] = [(0, 1), (1, 2), (2, 0)];

/// x and y derivatives of the six quadratic shape functions at area
/// coordinates `l`: corners `L_i (2 L_i − 1)`, midsides `4 L_i L_j`.
pub(crate) fn quadratic_derivatives(xy: &[[f64; 2]; 3], l: [f64; 3]) -> ([f64; 6], [f64; 6]) {
    let (b, c, two_a) = area_gradients(xy);
    let mut dx = [0.0; 6];
    let mut dy = [0.0; 6];
    for i in 0..3 {
        dx[i] = (4.0 * l[i] - 1.0) * b[i] / two_a;
        dy[i] = (4.0 * l[i] - 1.0) * c[i] / two_a;
    }
    for (m, (i, j)) in EDGES.iter().enumerate() {
        dx[3 + m] = 4.0 * (l[*i] * b[*j] + l[*j] * b[*i]) / two_a;
        dy[3 + m] = 4.0 * (l[*i] * c[*j] + l[*j] * c[*i]) / two_a;
    }
    (dx, dy)
}

/// Three-point rule, exact for quadratics over a triangle: area coordinates
/// (2/3, 1/6, 1/6) and its permutations, each weighing a third of the area.
pub(crate) const GAUSS3: [[f64; 3]; 3] = [
    [2.0 / 3.0, 1.0 / 6.0, 1.0 / 6.0],
    [1.0 / 6.0, 2.0 / 3.0, 1.0 / 6.0],
    [1.0 / 6.0, 1.0 / 6.0, 2.0 / 3.0],
];

pub(crate) const CENTROID: [f64; 3] = [1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0];

/// `v ↦ e × v` as a matrix.
pub(crate) fn skew(e: [f64; 3]) -> [[f64; 3]; 3] {
    [[0.0, -e[2], e[1]], [e[2], 0.0, -e[0]], [-e[1], e[0], 0.0]]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_frame_is_right_handed_and_the_corners_sit_in_it() {
        let p = [[1.0, 2.0, 3.0], [4.0, 2.5, 3.2], [1.5, 5.0, 2.0]];
        let t = triangle(p).unwrap();
        let f = t.frame;
        assert!((dot(cross(f.e1, f.e2), f.normal) - 1.0).abs() < 1e-12);
        for (i, q) in p.iter().enumerate() {
            let local = f.to_local(sub(*q, p[0]));
            assert!((local[0] - t.xy[i][0]).abs() < 1e-12);
            assert!((local[1] - t.xy[i][1]).abs() < 1e-12);
            assert!(local[2].abs() < 1e-12);
        }
        assert!(t.xy[2][1] > 0.0);
        let (_, _, two_a) = area_gradients(&t.xy);
        assert!((0.5 * two_a - t.area).abs() < 1e-12);
    }

    #[test]
    fn quadratic_derivatives_reproduce_a_quadratic() {
        let xy = [[0.0, 0.0], [3.0, 0.0], [0.7, 2.1]];
        let f = |x: f64, y: f64| 1.0 + 2.0 * x - y + 0.5 * x * x + 0.3 * x * y - 0.8 * y * y;
        let fx = |x: f64, y: f64| 2.0 + x + 0.3 * y;
        let fy = |x: f64, y: f64| -1.0 + 0.3 * x - 1.6 * y;
        let mut nodes = vec![xy[0], xy[1], xy[2]];
        for (i, j) in EDGES {
            nodes.push([0.5 * (xy[i][0] + xy[j][0]), 0.5 * (xy[i][1] + xy[j][1])]);
        }
        let l = [0.2, 0.5, 0.3];
        let x = l[0] * xy[0][0] + l[1] * xy[1][0] + l[2] * xy[2][0];
        let y = l[0] * xy[0][1] + l[1] * xy[1][1] + l[2] * xy[2][1];
        let (dx, dy) = quadratic_derivatives(&xy, l);
        let gx: f64 = (0..6).map(|k| dx[k] * f(nodes[k][0], nodes[k][1])).sum();
        let gy: f64 = (0..6).map(|k| dy[k] * f(nodes[k][0], nodes[k][1])).sum();
        assert!((gx - fx(x, y)).abs() < 1e-12, "{gx}");
        assert!((gy - fy(x, y)).abs() < 1e-12, "{gy}");
    }
}
