//! The mesh of a flat face with many holes (`mesh_faces` in cpp/kernel.cpp).
//!
//! Open CASCADE's Watson inserts the face's points one at a time and takes time that grows with the square of the
//! face's holes: 3.18 s for the mesh of a plate with 1,000 holes on CI's Windows runner. Delabella, the sweep-line
//! mesher Open CASCADE ships for this, was fast (0.38 s) but its vendored source uses inexact predicates with its asserts
//! compiled out, and it corrupted the heap on a thin rectangle of ten points. This is spade's constrained Delaunay bulk
//! loader (MIT OR Apache-2.0, already in the workspace's lock file through truck-meshalgo), which decides every
//! orientation and circle test with Shewchuk's adaptive exact predicates (the `robust` crate), so a thin, cocircular or
//! gridded input cannot send it astray.
//!
//! The kernel hands over the face's points and the segments of its wires as Open CASCADE cut them, and gets back the
//! triangles inside the face. The answer is checked before it is used: every segment is an edge of the triangulation,
//! every triangle turns counterclockwise by the same exact predicate, and every boundary segment has the face on exactly
//! one side. An answer that fails any of those is refused, and the kernel meshes the face with Watson instead.

use spade::handles::{FixedFaceHandle, InnerTag};
use spade::{ConstrainedDelaunayTriangulation, DelaunayTriangulation, HasPosition, Point2, Triangulation};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy)]
struct Indexed {
    at: Point2<f64>,
    index: u32,
}

impl HasPosition for Indexed {
    type Scalar = f64;

    fn position(&self) -> Point2<f64> {
        self.at
    }
}

fn indexed(points: &[[f64; 2]]) -> Result<Vec<Indexed>, String> {
    let n = points.len();
    if n < 3 {
        return Err(format!("{n} points make no triangle"));
    }
    if n > (i32::MAX as usize) / 4 {
        return Err(format!("{n} points are too many"));
    }
    Ok(points
        .iter()
        .enumerate()
        .map(|(index, &[x, y])| Indexed { at: Point2::new(x, y), index: index as u32 })
        .collect())
}

fn orient(points: &[[f64; 2]], triangle: [u32; 3]) -> f64 {
    let at = |k: usize| {
        let [x, y] = points[triangle[k] as usize];
        robust::Coord { x, y }
    };
    robust::orient2d(at(0), at(1), at(2))
}

/// The Delaunay triangles of `points` as indices into it, each counterclockwise, or why there are none. Points that
/// repeat, all on one line, fewer than three, or not finite are refused. Never panics: a panic inside is an error.
pub fn flat_triangulate(points: &[[f64; 2]]) -> Result<Vec<[u32; 3]>, String> {
    std::panic::catch_unwind(|| {
        let vertices = indexed(points)?;
        let triangulation: DelaunayTriangulation<Indexed> =
            DelaunayTriangulation::bulk_load(vertices).map_err(|err| format!("a point was refused: {err:?}"))?;
        if triangulation.num_vertices() != points.len() {
            return Err(format!("{} of {} points are distinct", triangulation.num_vertices(), points.len()));
        }
        let triangles: Vec<[u32; 3]> = triangulation
            .inner_faces()
            .map(|face| face.vertices().map(|vertex| vertex.data().index))
            .collect();
        check(points, &triangles, triangulation.convex_hull_size())?;
        Ok(triangles)
    })
    .unwrap_or_else(|_| Err("the triangulation panicked".into()))
}

/// Whether `triangles` triangulate `points` with `hull` points on the convex hull: every corner a point, every triangle
/// counterclockwise by the exact predicate, no directed edge twice, every point used, and 2n - 2 - hull triangles.
pub fn check(points: &[[f64; 2]], triangles: &[[u32; 3]], hull: usize) -> Result<(), String> {
    let n = points.len();
    if hull < 3 || 2 * n < 2 + hull || triangles.len() != 2 * n - 2 - hull {
        return Err(format!("{} triangles for {n} points with {hull} on the hull", triangles.len()));
    }
    let mut used = vec![false; n];
    let mut edges: HashSet<(u32, u32)> = HashSet::with_capacity(triangles.len() * 3);
    for &triangle in triangles {
        if triangle.iter().any(|&index| index as usize >= n) {
            return Err(format!("triangle {triangle:?} names a point that is not there"));
        }
        if orient(points, triangle) <= 0.0 {
            return Err(format!("triangle {triangle:?} does not turn counterclockwise"));
        }
        for k in 0..3 {
            used[triangle[k] as usize] = true;
            if !edges.insert((triangle[k], triangle[(k + 1) % 3])) {
                return Err(format!("edge {} {} is used twice the same way", triangle[k], triangle[(k + 1) % 3]));
            }
        }
    }
    match used.iter().position(|&seen| !seen) {
        Some(index) => Err(format!("point {index} is no corner")),
        None => Ok(()),
    }
}

/// The triangles inside a flat face, as indices into `points`, each counterclockwise. `frontier` holds the segments of
/// the face's wires: the face lies on exactly one side of each. `inner` holds segments with the face on both sides (an
/// edge inside the face, or a wire of no area). Every segment must join two points, and no two may cross.
///
/// What is inside is read from the triangulation: the outside of its convex hull is outside the face, and crossing a
/// frontier segment goes from outside to inside or back. A triangulation where that does not hold everywhere is refused.
/// Never panics: a panic inside is an error.
pub fn flat_face_mesh(points: &[[f64; 2]], frontier: &[[u32; 2]], inner: &[[u32; 2]]) -> Result<Vec<[u32; 3]>, String> {
    std::panic::catch_unwind(|| face_mesh(points, frontier, inner))
        .unwrap_or_else(|_| Err("the triangulation panicked".into()))
}

fn face_mesh(points: &[[f64; 2]], frontier: &[[u32; 2]], inner: &[[u32; 2]]) -> Result<Vec<[u32; 3]>, String> {
    let n = points.len();
    let vertices = indexed(points)?;
    let mut boundary: HashSet<(u32, u32)> = HashSet::with_capacity(frontier.len());
    let mut edges: Vec<[usize; 2]> = Vec::with_capacity(frontier.len() + inner.len());
    for (list, is_frontier) in [(frontier, true), (inner, false)] {
        for &[a, b] in list {
            if a == b || a as usize >= n || b as usize >= n {
                return Err(format!("segment {a} {b} does not join two points"));
            }
            if is_frontier && !boundary.insert((a.min(b), a.max(b))) {
                return Err(format!("segment {a} {b} is on the boundary twice"));
            }
            edges.push([a as usize, b as usize]);
        }
    }
    let mut conflicts = 0usize;
    let cdt: ConstrainedDelaunayTriangulation<Indexed> =
        ConstrainedDelaunayTriangulation::try_bulk_load_cdt(vertices, edges, |_| conflicts += 1)
            .map_err(|err| format!("a point was refused: {err:?}"))?;
    if conflicts > 0 {
        return Err(format!("{conflicts} segments cross another"));
    }
    if cdt.num_vertices() != n {
        return Err(format!("{} of {n} points are distinct", cdt.num_vertices()));
    }
    // Each segment must be one edge of the triangulation: a point on a segment splits it, and the face's boundary
    // would then not be the one its neighbours mesh against.
    let handle = |index: u32| spade::handles::FixedVertexHandle::from_index(index as usize);
    for &[a, b] in frontier.iter().chain(inner) {
        if !cdt.exists_constraint(handle(a), handle(b)) {
            return Err(format!("segment {a} {b} is not an edge of the triangulation"));
        }
    }
    let index_of = |face: FixedFaceHandle<InnerTag>| face.index();
    let mut inside: Vec<Option<bool>> = vec![None; cdt.num_all_faces()];
    let mut queue: Vec<FixedFaceHandle<InnerTag>> = Vec::new();
    let crossing = |edge: spade::handles::DirectedEdgeHandle<'_, Indexed, (), spade::CdtEdge<()>, ()>| {
        let [from, to] = edge.vertices().map(|vertex| vertex.data().index);
        boundary.contains(&(from.min(to), from.max(to)))
    };
    for edge in cdt.convex_hull() {
        // One side of a hull edge is the outer face; the triangle on its other side is inside exactly when the edge is
        // a frontier segment.
        let Some(face) = edge.face().as_inner().or_else(|| edge.rev().face().as_inner()) else {
            return Err("a hull edge has no triangle".into());
        };
        let value = crossing(edge);
        let slot = &mut inside[index_of(face.fix())];
        match slot {
            Some(seen) if *seen != value => return Err("a triangle is both inside and outside".into()),
            Some(_) => {}
            None => {
                *slot = Some(value);
                queue.push(face.fix());
            }
        }
    }
    while let Some(fixed) = queue.pop() {
        let face = cdt.face(fixed);
        let value = inside[index_of(fixed)].unwrap_or(false);
        for edge in face.adjacent_edges() {
            let Some(next) = edge.rev().face().as_inner() else {
                continue;
            };
            let expected = value != crossing(edge);
            let slot = &mut inside[index_of(next.fix())];
            match slot {
                Some(seen) if *seen != expected => return Err("a triangle is both inside and outside".into()),
                Some(_) => {}
                None => {
                    *slot = Some(expected);
                    queue.push(next.fix());
                }
            }
        }
    }
    let mut triangles = Vec::new();
    let mut sides: HashMap<(u32, u32), u32> = HashMap::with_capacity(boundary.len());
    for face in cdt.inner_faces() {
        match inside[index_of(face.fix())] {
            None => return Err("a triangle was not reached".into()),
            Some(false) => continue,
            Some(true) => {}
        }
        let triangle = face.vertices().map(|vertex| vertex.data().index);
        if orient(points, triangle) <= 0.0 {
            return Err(format!("triangle {triangle:?} does not turn counterclockwise"));
        }
        for k in 0..3 {
            let (a, b) = (triangle[k], triangle[(k + 1) % 3]);
            let key = (a.min(b), a.max(b));
            if boundary.contains(&key) {
                *sides.entry(key).or_insert(0) += 1;
            }
        }
        triangles.push(triangle);
    }
    if triangles.is_empty() {
        return Err("no triangle is inside the face".into());
    }
    if sides.len() != boundary.len() || sides.values().any(|&count| count != 1) {
        return Err("a boundary segment does not have the face on exactly one side".into());
    }
    Ok(triangles)
}

/// What the kernel calls: `n` points as x, y pairs, `nf` frontier and `ni` inner segments as index pairs, and room for
/// `capacity` triangles of three indices. The number of triangles written, or -1 when there is no mesh or no room.
///
/// # Safety
/// `xy` holds `2 * n` doubles, `frontier` `2 * nf` ints, `inner` `2 * ni` ints (either may be null when its count is
/// 0), and `triangles` has room for `3 * capacity` ints.
#[cfg_attr(not(lime_occt), allow(dead_code))]
pub unsafe extern "C" fn flat_face_mesh_ffi(
    xy: *const f64,
    n: i32,
    frontier: *const i32,
    nf: i32,
    inner: *const i32,
    ni: i32,
    triangles: *mut i32,
    capacity: i32,
) -> i32 {
    let answer = std::panic::catch_unwind(|| {
        if xy.is_null() || triangles.is_null() || n < 0 || nf < 0 || ni < 0 || capacity < 0 {
            return -1;
        }
        if (nf > 0 && frontier.is_null()) || (ni > 0 && inner.is_null()) {
            return -1;
        }
        let coords = unsafe { std::slice::from_raw_parts(xy, 2 * n as usize) };
        let points: Vec<[f64; 2]> = coords.chunks_exact(2).map(|pair| [pair[0], pair[1]]).collect();
        let pairs = |data: *const i32, count: i32| -> Option<Vec<[u32; 2]>> {
            if count == 0 {
                return Some(Vec::new());
            }
            let flat = unsafe { std::slice::from_raw_parts(data, 2 * count as usize) };
            flat.chunks_exact(2)
                .map(|pair| Some([u32::try_from(pair[0]).ok()?, u32::try_from(pair[1]).ok()?]))
                .collect()
        };
        let (Some(frontier), Some(inner)) = (pairs(frontier, nf), pairs(inner, ni)) else {
            return -1;
        };
        let Ok(found) = flat_face_mesh(&points, &frontier, &inner) else {
            return -1;
        };
        if found.len() > capacity as usize {
            return -1;
        }
        let out = unsafe { std::slice::from_raw_parts_mut(triangles, 3 * found.len()) };
        for (slot, triangle) in out.chunks_exact_mut(3).zip(&found) {
            for (to, &index) in slot.iter_mut().zip(triangle) {
                *to = index as i32;
            }
        }
        found.len() as i32
    });
    answer.unwrap_or(-1)
}
