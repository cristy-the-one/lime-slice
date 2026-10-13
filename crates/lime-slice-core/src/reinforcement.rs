//! Painted columns and box or cylinder volumes that raise infill density.
//!
//! A paint disk is a finite cylinder of the brush radius running inward along
//! the surface normal. Fill through keeps that cylinder until the ray leaves
//! the mesh. A box or a cylinder is axis-aligned in the mesh frame and is
//! posed with the part. On a layer the section is a polygon, and the planner
//! prints `max(strategy density, region density)` inside it.

use serde_json::{Map, Value};

use crate::mesh::Mesh;
use crate::poly::{boolean_union, drop_slivers, signed_area, Loop};

const MAX_REGIONS: usize = 64;
const MAX_DISKS: usize = 20_000;
const COORD_MM: f64 = 100_000.0;
const MIN_DEPTH_MM: f64 = 0.2;
const MAX_DEPTH_MM: f64 = 100.0;
const MIN_SIZE_MM: f64 = 0.2;
const MAX_SIZE_MM: f64 = 10_000.0;
const MIN_RADIUS_MM: f64 = 0.2;
const MAX_RADIUS_MM: f64 = 40.0;
/// A hit this close to the ray start is the surface the brush is already on.
const RAY_SKIP_MM: f64 = 0.02;
const SECTION_SIDES: usize = 96;

#[derive(Clone, Debug, PartialEq)]
pub struct Region {
    pub index: usize,
    pub density: f64,
    kind: Kind,
}

#[derive(Clone, Debug, PartialEq)]
enum Kind {
    Paint {
        disks: Vec<Disk>,
    },
    Box {
        center: [f64; 3],
        axes: [[f64; 3]; 3],
        half: [f64; 3],
    },
    Cylinder {
        center: [f64; 3],
        axis: [f64; 3],
        e1: [f64; 3],
        e2: [f64; 3],
        rx: f64,
        ry: f64,
        half_h: f64,
    },
}

#[derive(Clone, Debug, PartialEq)]
struct Disk {
    origin: [f64; 3],
    /// Unit direction inward, opposite the stored normal.
    dir: [f64; 3],
    radius: f64,
    depth: f64,
    fill_through: bool,
    /// Column length. Depth until [`resolve`] measures a fill-through ray.
    length: f64,
}

impl Region {
    pub(crate) fn pose(&mut self, rotation: &[f64; 9], pivot: [f64; 3], translation: [f64; 3]) {
        let point = |p: [f64; 3]| add(mul_rot(rotation, sub(p, pivot)), translation);
        let vector = |v: [f64; 3]| mul_rot(rotation, v);
        match &mut self.kind {
            Kind::Paint { disks } => {
                for disk in disks {
                    disk.origin = point(disk.origin);
                    disk.dir = unit(vector(disk.dir));
                }
            }
            Kind::Box { center, axes, .. } => {
                *center = point(*center);
                *axes = [vector(axes[0]), vector(axes[1]), vector(axes[2])];
            }
            Kind::Cylinder {
                center,
                axis,
                e1,
                e2,
                ..
            } => {
                *center = point(*center);
                *axis = unit(vector(*axis));
                *e1 = unit(vector(*e1));
                *e2 = unit(vector(*e2));
            }
        }
    }

    /// The outlines of this region on the plane `z`, in request order.
    pub(crate) fn sections(&self, z: f64) -> Vec<Loop> {
        let loops = match &self.kind {
            Kind::Paint { disks } => {
                let mut acc: Vec<Loop> = Vec::new();
                for disk in disks {
                    if let Some(loop_) = disk_section(disk, z) {
                        acc = boolean_union(&acc, &[loop_]);
                    }
                }
                acc
            }
            Kind::Box { center, axes, half } => {
                box_section(*center, *axes, *half, z).into_iter().collect()
            }
            Kind::Cylinder {
                center,
                axis,
                e1,
                e2,
                rx,
                ry,
                half_h,
            } => cylinder_section(*center, *axis, *e1, *e2, *rx, *ry, *half_h, z)
                .into_iter()
                .collect(),
        };
        drop_slivers(loops, 0.05)
            .into_iter()
            .filter(|loop_| signed_area(loop_) > 0.05)
            .collect()
    }
}

/// The far intersection of each fill-through ray. A miss uses the part diagonal.
pub(crate) fn resolve(regions: &mut [Region], mesh: &Mesh) {
    let diag = mesh
        .bounds()
        .map(|(min, max)| {
            let d = sub(max, min);
            dot(d, d).sqrt().max(1.0)
        })
        .unwrap_or(1.0);
    for region in regions {
        let Kind::Paint { disks } = &mut region.kind else {
            continue;
        };
        for disk in disks.iter_mut() {
            disk.length = if disk.fill_through {
                far_hit(mesh, disk.origin, disk.dir).unwrap_or(diag)
            } else {
                disk.depth
            };
        }
    }
}

/// `reinforcement` as the engine stores it. The error names the field, as
/// `reinforcement[0].density`.
pub(crate) fn parse(values: &[Value]) -> Result<Vec<Region>, String> {
    if values.len() > MAX_REGIONS {
        return Err(format!(
            "reinforcement: {} entries, at most {MAX_REGIONS} are allowed",
            values.len()
        ));
    }
    let mut disks = 0usize;
    let mut out = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let at = format!("reinforcement[{index}]");
        let obj = value
            .as_object()
            .ok_or_else(|| format!("{at} is not an object"))?;
        let kind = str_field(obj, &at, "kind")?;
        let density = density_field(obj, &at)?;
        let region = match kind {
            "paint" => {
                only_keys(
                    obj,
                    &at,
                    &["kind", "density", "depthMm", "fillThrough", "disks"],
                )?;
                let depth = range_field(obj, &at, "depthMm", MIN_DEPTH_MM, MAX_DEPTH_MM)?;
                let fill_through = bool_field(obj, &at, "fillThrough")?.unwrap_or(false);
                let list = obj
                    .get("disks")
                    .and_then(Value::as_array)
                    .ok_or_else(|| format!("{at}.disks is missing"))?;
                if list.is_empty() {
                    return Err(format!("{at}.disks is empty"));
                }
                disks += list.len();
                if disks > MAX_DISKS {
                    return Err(format!(
                        "reinforcement has {disks} disks, at most {MAX_DISKS} are allowed"
                    ));
                }
                let mut parsed = Vec::with_capacity(list.len());
                for (i, disk) in list.iter().enumerate() {
                    parsed.push(parse_disk(
                        disk,
                        &format!("{at}.disks[{i}]"),
                        depth,
                        fill_through,
                    )?);
                }
                Region {
                    index,
                    density,
                    kind: Kind::Paint { disks: parsed },
                }
            }
            "box" | "cylinder" => {
                only_keys(obj, &at, &["kind", "density", "center", "size"])?;
                let center = vec3(obj, &at, "center")?;
                let size = vec3(obj, &at, "size")?;
                for (axis, n) in size.iter().zip(["x", "y", "z"]) {
                    if !(MIN_SIZE_MM..=MAX_SIZE_MM).contains(axis) {
                        return Err(format!(
                            "{at}.size {axis} is outside {MIN_SIZE_MM} to {MAX_SIZE_MM} mm on {n}"
                        ));
                    }
                }
                let half = [size[0] * 0.5, size[1] * 0.5, size[2] * 0.5];
                let kind = if kind == "box" {
                    Kind::Box {
                        center,
                        axes: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                        half,
                    }
                } else {
                    Kind::Cylinder {
                        center,
                        axis: [0.0, 0.0, 1.0],
                        e1: [1.0, 0.0, 0.0],
                        e2: [0.0, 1.0, 0.0],
                        rx: half[0],
                        ry: half[1],
                        half_h: half[2],
                    }
                };
                Region {
                    index,
                    density,
                    kind,
                }
            }
            other => {
                return Err(format!(
                    "{at}.kind \"{other}\" is not paint, box, or cylinder"
                ))
            }
        };
        out.push(region);
    }
    Ok(out)
}

fn parse_disk(value: &Value, at: &str, depth: f64, fill_through: bool) -> Result<Disk, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| format!("{at} is not an object"))?;
    only_keys(obj, at, &["p", "n", "r"])?;
    let origin = vec3(obj, at, "p")?;
    let n = vec3(obj, at, "n")?;
    let len = dot(n, n).sqrt();
    if len < 1e-9 {
        return Err(format!("{at}.n has zero length"));
    }
    let radius = obj
        .get("r")
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("{at}.r is missing"))?;
    if !radius.is_finite() || !(MIN_RADIUS_MM..=MAX_RADIUS_MM).contains(&radius) {
        return Err(format!(
            "{at}.r {radius} is outside {MIN_RADIUS_MM} to {MAX_RADIUS_MM} mm"
        ));
    }
    Ok(Disk {
        origin,
        dir: scale(n, -1.0 / len),
        radius,
        depth,
        fill_through,
        length: depth,
    })
}

fn disk_section(disk: &Disk, z: f64) -> Option<Loop> {
    let len = disk.length;
    if disk.dir[2].abs() > 0.999 {
        let t = (z - disk.origin[2]) / disk.dir[2];
        if !(-1e-4..=len + 1e-4).contains(&t) {
            return None;
        }
        let c = [
            disk.origin[0] + disk.dir[0] * t,
            disk.origin[1] + disk.dir[1] * t,
        ];
        return clean(circle(c, disk.radius));
    }
    if disk.dir[2].abs() < 1e-4 {
        return horizontal_rect(disk.origin, disk.dir, len, disk.radius, z);
    }
    let inside =
        |p: [f64; 2]| in_cylinder([p[0], p[1], z], disk.origin, disk.dir, len, disk.radius);
    let seed = cylinder_seed(disk.origin, disk.dir, len, disk.radius, z, &inside)?;
    convex_loop(&inside, seed)
}

fn horizontal_rect(origin: [f64; 3], dir: [f64; 3], len: f64, radius: f64, z: f64) -> Option<Loop> {
    let h = z - origin[2];
    if h.abs() >= radius {
        return None;
    }
    let half = (radius * radius - h * h).sqrt();
    let dxy = unit2([dir[0], dir[1]]);
    let perp = [-dxy[1], dxy[0]];
    let start = [origin[0], origin[1]];
    let end = [origin[0] + dxy[0] * len, origin[1] + dxy[1] * len];
    clean(vec![
        [start[0] - perp[0] * half, start[1] - perp[1] * half],
        [end[0] - perp[0] * half, end[1] - perp[1] * half],
        [end[0] + perp[0] * half, end[1] + perp[1] * half],
        [start[0] + perp[0] * half, start[1] + perp[1] * half],
    ])
}

fn box_section(center: [f64; 3], axes: [[f64; 3]; 3], half: [f64; 3], z: f64) -> Option<Loop> {
    if aligned(axes) {
        let dz = (z - center[2]).abs();
        if dz > half[2] + 1e-6 {
            return None;
        }
        return clean(vec![
            [center[0] - half[0], center[1] - half[1]],
            [center[0] + half[0], center[1] - half[1]],
            [center[0] + half[0], center[1] + half[1]],
            [center[0] - half[0], center[1] + half[1]],
        ]);
    }
    let inside = |p: [f64; 2]| in_box([p[0], p[1], z], center, axes, half);
    let seed = if inside([center[0], center[1]]) {
        [center[0], center[1]]
    } else {
        return None;
    };
    convex_loop(&inside, seed)
}

#[allow(clippy::too_many_arguments)]
fn cylinder_section(
    center: [f64; 3],
    axis: [f64; 3],
    e1: [f64; 3],
    e2: [f64; 3],
    rx: f64,
    ry: f64,
    half_h: f64,
    z: f64,
) -> Option<Loop> {
    if axis[2].abs() > 0.999 {
        let t = z - center[2];
        if t.abs() > half_h + 1e-6 {
            return None;
        }
        return clean(ellipse([center[0], center[1]], rx, ry));
    }
    let inside = |p: [f64; 2]| in_elliptic([p[0], p[1], z], center, axis, e1, e2, rx, ry, half_h);
    let seed = if inside([center[0], center[1]]) {
        [center[0], center[1]]
    } else {
        cylinder_seed(center, axis, half_h * 2.0, rx.max(ry), z, &|p| {
            in_elliptic([p[0], p[1], z], center, axis, e1, e2, rx, ry, half_h)
        })?
    };
    convex_loop(&inside, seed)
}

fn cylinder_seed(
    origin: [f64; 3],
    dir: [f64; 3],
    len: f64,
    radius: f64,
    z: f64,
    inside: &impl Fn([f64; 2]) -> bool,
) -> Option<[f64; 2]> {
    if dir[2].abs() > 1e-6 {
        let t = (z - origin[2]) / dir[2];
        if (0.0..=len).contains(&t) {
            let p = add(origin, scale(dir, t));
            if inside([p[0], p[1]]) {
                return Some([p[0], p[1]]);
            }
        }
    }
    for i in 0..=16 {
        let t = len * i as f64 / 16.0;
        let p = add(origin, scale(dir, t));
        if (p[2] - z).abs() <= radius && inside([p[0], p[1]]) {
            return Some([p[0], p[1]]);
        }
    }
    None
}

fn convex_loop(inside: &impl Fn([f64; 2]) -> bool, seed: [f64; 2]) -> Option<Loop> {
    if !inside(seed) {
        return None;
    }
    let mut reach = 1.0;
    while reach < 1.0e5 {
        let covered = (0..8).all(|k| {
            let a = std::f64::consts::TAU * k as f64 / 8.0;
            inside([seed[0] + reach * a.cos(), seed[1] + reach * a.sin()])
        });
        if !covered {
            break;
        }
        reach *= 2.0;
    }
    let mut loop_ = Vec::with_capacity(SECTION_SIDES);
    for k in 0..SECTION_SIDES {
        let a = std::f64::consts::TAU * k as f64 / SECTION_SIDES as f64;
        let (dx, dy) = (a.cos(), a.sin());
        let mut lo = 0.0;
        let mut hi = reach;
        for _ in 0..20 {
            let mid = (lo + hi) * 0.5;
            if inside([seed[0] + dx * mid, seed[1] + dy * mid]) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        loop_.push([seed[0] + dx * lo, seed[1] + dy * lo]);
    }
    clean(loop_)
}

fn in_cylinder(q: [f64; 3], origin: [f64; 3], dir: [f64; 3], len: f64, radius: f64) -> bool {
    let v = sub(q, origin);
    let t = dot(v, dir);
    if t < -1e-4 || t > len + 1e-4 {
        return false;
    }
    let radial = sub(v, scale(dir, t));
    dot(radial, radial) <= radius * radius + 1e-4
}

fn in_box(q: [f64; 3], center: [f64; 3], axes: [[f64; 3]; 3], half: [f64; 3]) -> bool {
    let d = sub(q, center);
    (0..3).all(|i| dot(d, axes[i]).abs() <= half[i] + 1e-4)
}

#[allow(clippy::too_many_arguments)]
fn in_elliptic(
    q: [f64; 3],
    center: [f64; 3],
    axis: [f64; 3],
    e1: [f64; 3],
    e2: [f64; 3],
    rx: f64,
    ry: f64,
    half_h: f64,
) -> bool {
    let d = sub(q, center);
    let t = dot(d, axis);
    if t.abs() > half_h + 1e-4 {
        return false;
    }
    let radial = sub(d, scale(axis, t));
    let x = dot(radial, e1) / rx;
    let y = dot(radial, e2) / ry;
    x * x + y * y <= 1.0 + 1e-4
}

fn far_hit(mesh: &Mesh, origin: [f64; 3], dir: [f64; 3]) -> Option<f64> {
    let mut far = None;
    for tri in &mesh.triangles {
        if let Some(t) = ray_tri(origin, dir, *tri) {
            if t > RAY_SKIP_MM {
                far = Some(far.map_or(t, |b: f64| b.max(t)));
            }
        }
    }
    far
}

fn ray_tri(origin: [f64; 3], dir: [f64; 3], tri: [[f64; 3]; 3]) -> Option<f64> {
    let e1 = sub(tri[1], tri[0]);
    let e2 = sub(tri[2], tri[0]);
    let p = cross(dir, e2);
    let det = dot(e1, p);
    if det.abs() < 1e-8 {
        return None;
    }
    let inv = 1.0 / det;
    let tvec = sub(origin, tri[0]);
    let u = dot(tvec, p) * inv;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = cross(tvec, e1);
    let v = dot(dir, q) * inv;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = dot(e2, q) * inv;
    (t > 0.0).then_some(t)
}

fn aligned(axes: [[f64; 3]; 3]) -> bool {
    axes.iter().enumerate().all(|(i, axis)| {
        (0..3).all(|k| {
            let want = if k == i { 1.0 } else { 0.0 };
            (axis[k].abs() - want).abs() < 1e-6
        })
    })
}

fn circle(c: [f64; 2], r: f64) -> Loop {
    ellipse(c, r, r)
}

fn ellipse(c: [f64; 2], rx: f64, ry: f64) -> Loop {
    (0..SECTION_SIDES)
        .map(|i| {
            let a = std::f64::consts::TAU * i as f64 / SECTION_SIDES as f64;
            [c[0] + rx * a.cos(), c[1] + ry * a.sin()]
        })
        .collect()
}

fn clean(mut loop_: Loop) -> Option<Loop> {
    if loop_.len() < 3 || !loop_.iter().all(|p| p[0].is_finite() && p[1].is_finite()) {
        return None;
    }
    if signed_area(&loop_) < 0.0 {
        loop_.reverse();
    }
    (signed_area(&loop_) > 0.05).then_some(loop_)
}

fn only_keys(obj: &Map<String, Value>, at: &str, allow: &[&str]) -> Result<(), String> {
    for key in obj.keys() {
        if !allow.contains(&key.as_str()) {
            return Err(format!("{at}: unknown field `{key}`"));
        }
    }
    Ok(())
}

fn str_field<'a>(obj: &'a Map<String, Value>, at: &str, key: &str) -> Result<&'a str, String> {
    obj.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{at}.{key} is missing"))
}

fn density_field(obj: &Map<String, Value>, at: &str) -> Result<f64, String> {
    let n = obj
        .get("density")
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("{at}.density is missing"))?;
    if n.is_finite() && (0.0..=1.0).contains(&n) {
        Ok(n)
    } else {
        Err(format!("{at}.density {n} is outside 0 to 1"))
    }
}

fn range_field(
    obj: &Map<String, Value>,
    at: &str,
    key: &str,
    lo: f64,
    hi: f64,
) -> Result<f64, String> {
    let n = obj
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("{at}.{key} is missing"))?;
    if n.is_finite() && (lo..=hi).contains(&n) {
        Ok(n)
    } else {
        Err(format!("{at}.{key} {n} is outside {lo} to {hi} mm"))
    }
}

fn bool_field(obj: &Map<String, Value>, at: &str, key: &str) -> Result<Option<bool>, String> {
    match obj.get(key) {
        None => Ok(None),
        Some(Value::Bool(v)) => Ok(Some(*v)),
        Some(_) => Err(format!("{at}.{key} is not a boolean")),
    }
}

fn vec3(obj: &Map<String, Value>, at: &str, key: &str) -> Result<[f64; 3], String> {
    let arr = obj
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{at}.{key} is missing"))?;
    if arr.len() != 3 {
        return Err(format!("{at}.{key} is not a 3-vector"));
    }
    let mut out = [0.0; 3];
    for (i, slot) in out.iter_mut().enumerate() {
        let n = arr[i]
            .as_f64()
            .ok_or_else(|| format!("{at}.{key} is not a 3-vector"))?;
        if !n.is_finite() || n.abs() > COORD_MM {
            return Err(format!(
                "{at}.{key} {n} is not a finite coordinate within {COORD_MM} mm"
            ));
        }
        *slot = n;
    }
    Ok(out)
}

fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn scale(a: [f64; 3], k: f64) -> [f64; 3] {
    [a[0] * k, a[1] * k, a[2] * k]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn mul_rot(r: &[f64; 9], v: [f64; 3]) -> [f64; 3] {
    [
        r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
        r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
        r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
    ]
}

fn unit(v: [f64; 3]) -> [f64; 3] {
    let len = dot(v, v).sqrt();
    if len < 1e-12 {
        [0.0, 0.0, 1.0]
    } else {
        scale(v, 1.0 / len)
    }
}

fn unit2(v: [f64; 2]) -> [f64; 2] {
    let len = (v[0] * v[0] + v[1] * v[1]).sqrt();
    if len < 1e-12 {
        [1.0, 0.0]
    } else {
        [v[0] / len, v[1] / len]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::poly::point_in_loop;

    fn box_mesh(z1: f64) -> Mesh {
        let v = [
            [0.0, 0.0, 0.0],
            [10.0, 0.0, 0.0],
            [10.0, 10.0, 0.0],
            [0.0, 10.0, 0.0],
            [0.0, 0.0, z1],
            [10.0, 0.0, z1],
            [10.0, 10.0, z1],
            [0.0, 10.0, z1],
        ];
        let faces = [
            (0, 2, 1),
            (0, 3, 2),
            (4, 5, 6),
            (4, 6, 7),
            (0, 1, 5),
            (0, 5, 4),
            (3, 7, 6),
            (3, 6, 2),
            (0, 4, 7),
            (0, 7, 3),
            (1, 2, 6),
            (1, 6, 5),
        ];
        Mesh {
            triangles: faces
                .into_iter()
                .map(|(i, j, k)| [v[i], v[j], v[k]])
                .collect(),
        }
    }

    fn holds(loop_: &Loop, p: [f64; 2]) -> bool {
        point_in_loop(loop_, p[0], p[1])
    }

    #[test]
    fn a_vertical_column_stops_at_its_depth() {
        let disk = Disk {
            origin: [5.0, 5.0, 10.0],
            dir: [0.0, 0.0, -1.0],
            radius: 2.0,
            depth: 4.0,
            fill_through: false,
            length: 4.0,
        };
        let top = disk_section(&disk, 8.0).unwrap();
        assert!(holds(&top, [5.0, 5.0]));
        assert!(!holds(&top, [8.0, 5.0]));
        assert!(disk_section(&disk, 5.5).is_none());
    }

    #[test]
    fn a_side_column_runs_inward_not_down() {
        let disk = Disk {
            origin: [10.0, 5.0, 5.0],
            dir: [-1.0, 0.0, 0.0],
            radius: 2.0,
            depth: 4.0,
            fill_through: false,
            length: 4.0,
        };
        let cut = disk_section(&disk, 5.0).unwrap();
        assert!(holds(&cut, [8.0, 5.0]), "inward of the face");
        assert!(!holds(&cut, [5.0, 5.0]), "past the depth");
        assert!(disk_section(&disk, 8.0).is_none(), "above the brush");
    }

    #[test]
    fn a_tilted_column_holds_the_axis_and_not_the_side() {
        let dir = unit([0.0, 1.0, -1.0]);
        let disk = Disk {
            origin: [0.0, 0.0, 10.0],
            dir,
            radius: 2.0,
            depth: 6.0,
            fill_through: false,
            length: 6.0,
        };
        let mid = add(disk.origin, scale(dir, 3.0));
        let cut = disk_section(&disk, mid[2]).unwrap();
        assert!(holds(&cut, [mid[0], mid[1]]));
        assert!(!holds(&cut, [mid[0] + 4.0, mid[1]]));
    }

    #[test]
    fn fill_through_reaches_the_far_face() {
        let mesh = box_mesh(10.0);
        let hit = far_hit(&mesh, [5.0, 5.0, 10.0], [0.0, 0.0, -1.0]).unwrap();
        assert!((hit - 10.0).abs() < 1e-6, "{hit}");
    }

    #[test]
    fn a_box_section_is_its_rectangle() {
        let region = Region {
            index: 0,
            density: 1.0,
            kind: Kind::Box {
                center: [4.0, 5.0, 3.0],
                axes: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                half: [2.0, 1.5, 3.0],
            },
        };
        let cut = &region.sections(3.0)[0];
        assert!(holds(cut, [4.0, 5.0]));
        assert!(!holds(cut, [7.0, 5.0]));
        assert!(region.sections(7.0).is_empty());
    }
}
