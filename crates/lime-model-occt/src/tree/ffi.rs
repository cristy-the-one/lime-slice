//! The C++ kernel boundary: the raw handles and every `lime_tree_*` function.

use std::os::raw::{c_char, c_int};

#[repr(C)]
pub(super) struct RawShape {
    _opaque: [u8; 0],
}

#[repr(C)]
pub(super) struct RawMesh {
    _opaque: [u8; 0],
}

#[repr(C)]
pub(super) struct RawSurfaceInspect {
    _opaque: [u8; 0],
}

/// `LimeMeshView` in tree.cpp: a mesh's arrays as bytes, until the mesh is freed, and the shape's
/// description as JSON, for as long as the shape lives.
#[repr(C)]
pub(super) struct MeshView {
    pub(super) positions: *const u8,
    pub(super) positions_bytes: usize,
    pub(super) normals: *const u8,
    pub(super) normals_bytes: usize,
    pub(super) triangles: *const u8,
    pub(super) triangles_bytes: usize,
    pub(super) edge_points: *const u8,
    pub(super) edge_points_bytes: usize,
    pub(super) edge_offsets: *const u8,
    pub(super) edge_offsets_bytes: usize,
    pub(super) meta: *const c_char,
}

/// `LimeSurfaceInspectView` in tree.cpp: lazy curvature & isoparm arrays plus JSON continuity & surface health.
#[repr(C)]
pub(super) struct SurfaceInspectView {
    pub(super) min_radius_mm: *const u8,
    pub(super) min_radius_bytes: usize,
    pub(super) gaussian: *const u8,
    pub(super) gaussian_bytes: usize,
    pub(super) mean: *const u8,
    pub(super) mean_bytes: usize,
    pub(super) iso_points: *const u8,
    pub(super) iso_points_bytes: usize,
    pub(super) meta: *const c_char,
}

extern "C" {
    pub(super) fn lime_tree_free(shape: *mut RawShape);
    pub(super) fn lime_tree_primitive(
        kind: *const c_char,
        p: *const f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_read_step(path: *const c_char, error: *mut *mut c_char) -> *mut RawShape;
    pub(super) fn lime_tree_read_brep(
        data: *const u8,
        size: usize,
        volume: f64,
        created: *const c_int,
        count: c_int,
        order: *const c_int,
        faces: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_mesh_order(shape: *const RawShape, out: *mut c_int, capacity: c_int) -> c_int;
    pub(super) fn lime_tree_write_brep(
        shape: *const RawShape,
        size: *mut usize,
        error: *mut *mut c_char,
    ) -> *mut c_char;
    pub(super) fn lime_tree_occt_version() -> *const c_char;
    pub(super) fn lime_tree_set_deadline(budget_ms: i64);
    pub(super) fn lime_tree_boolean(
        from: *const RawShape,
        op: *const c_char,
        primitive: *const c_char,
        p: *const f64,
        merge: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_join(
        from: *const RawShape,
        tool: *const RawShape,
        op: *const c_char,
        place: *const f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_hole(
        from: *const RawShape,
        p: *const f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_blend(
        from: *const RawShape,
        edges: *const c_int,
        count: c_int,
        size: f64,
        chamfer: c_int,
        max_mm: *mut f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    /// --- Organic surfaces S3: variable-radius, G2 curvature-continuous, and conic-rho fillets.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lime_tree_fillet_v2(
        from: *const RawShape,
        edges: *const c_int,
        count: c_int,
        size: f64,
        continuity: c_int,
        rho: f64,
        variable: *const f64,
        variable_len: c_int,
        max_mm: *mut f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    /// A chamfer by two distances (`mode` 1) or a distance and an angle in degrees (`mode` 2). `faces[i]` is the face
    /// edge `i`'s first distance runs along.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lime_tree_chamfer2(
        from: *const RawShape,
        edges: *const c_int,
        faces: *const c_int,
        count: c_int,
        size: f64,
        second: f64,
        mode: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    // --- Print transitions.
    pub(super) fn lime_tree_transition_chamfer(
        from: *const RawShape,
        edges: *const c_int,
        faces: *const c_int,
        sizes: *const f64,
        angles: *const f64,
        count: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_wedges(
        from: *const RawShape,
        points: *const f64,
        along: *const f64,
        count: c_int,
        cut: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lime_tree_lip_gusset(
        from: *const RawShape,
        onto: *const RawShape,
        face: c_int,
        at: *const f64,
        keep: *const f64,
        build: *const f64,
        depth: f64,
        inside: *const f64,
        out: *mut f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_face_span(
        shape: *mut RawShape,
        index: c_int,
        origin: *const f64,
        dir: *const f64,
        out: *mut f64,
    ) -> c_int;
    /// What an edge is, apart from where: `out` gets the curve (0 line, 1 circle, 2 other), its direction or axis, the
    /// number of faces it bounds (0 to 2), and for each of the first two its index, surface kind (0 plane, 1 cylinder,
    /// 2 cone, 3 sphere, 4 torus, 5 other), and outward normal at the edge's middle: 15 numbers.
    pub(super) fn lime_tree_edge_sig(shape: *mut RawShape, index: c_int, flat: f64, out: *mut f64) -> c_int;
    /// --- Print transitions, step 6: `count` stations along an edge, 12 numbers each.
    pub(super) fn lime_tree_edge_stations(
        shape: *mut RawShape,
        edge: c_int,
        face_a: c_int,
        face_b: c_int,
        count: c_int,
        out: *mut f64,
    ) -> c_int;
    pub(super) fn lime_tree_face_distances(
        shape: *mut RawShape,
        face: c_int,
        points: *const f64,
        count: c_int,
        out: *mut f64,
    ) -> c_int;
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lime_tree_transition_tools(
        from: *const RawShape,
        count: c_int,
        edges: *const c_int,
        straight: *const c_int,
        section_counts: *const c_int,
        sections: *const f64,
        ext: *const f64,
        mitres: *const f64,
        binormal: *const f64,
        cut: c_int,
        touched: *mut c_int,
        out: *mut f64,
        tools: *mut *mut RawShape,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_edge_end_faces(shape: *mut RawShape, edge: c_int, out: *mut c_int, capacity: c_int) -> c_int;
    pub(super) fn lime_tree_inside(shape: *mut RawShape, point: *const f64) -> c_int;
    pub(super) fn lime_tree_edge_chain(
        shape: *mut RawShape,
        edge: c_int,
        max_deg: f64,
        out: *mut c_int,
        capacity: c_int,
        closed: *mut c_int,
    ) -> c_int;
    pub(super) fn lime_tree_split(
        from: *const RawShape,
        p: *const f64,
        other: *mut *mut RawShape,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    #[allow(clippy::too_many_arguments)]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lime_tree_partition(
        from: *const RawShape,
        p: *const f64,
        count: c_int,
        us: *const f64,
        stroke_counts: *const c_int,
        digit_count: c_int,
        strokes: *const f64,
        sizes: *const f64,
        joints: *const f64,
        joint_count: c_int,
        up: *const f64,
        profiles: *const f64,
        profile_count: c_int,
        chains: *const f64,
        chain_count: c_int,
        out: *mut *mut RawShape,
        placed: *mut *mut c_char,
        pins: *mut *mut RawShape,
        joined: *mut *mut c_char,
        error: *mut *mut c_char,
    ) -> c_int;
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lime_tree_fit_coupon(
        size: *const f64,
        holes: *const f64,
        hole_count: c_int,
        strokes: *const f64,
        stroke_count: c_int,
        engrave: *const f64,
        pins: *const f64,
        pin_count: c_int,
        plate: *mut *mut RawShape,
        pins_out: *mut *mut RawShape,
        engraved: *mut f64,
        error: *mut *mut c_char,
    ) -> c_int;
    pub(super) fn lime_tree_write_step_many(
        shapes: *const *const RawShape,
        names: *const *const c_char,
        places: *const f64,
        count: c_int,
        path: *const c_char,
        error: *mut *mut c_char,
    ) -> c_int;
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lime_tree_write_step_assembly(
        assembly_name: *const c_char,
        parts: *const *const RawShape,
        part_names: *const *const c_char,
        part_count: c_int,
        member_names: *const *const c_char,
        parents: *const c_int,
        part_ids: *const c_int,
        places: *const f64,
        has_colors: *const c_int,
        colors: *const f64,
        member_count: c_int,
        path: *const c_char,
        error: *mut *mut c_char,
    ) -> c_int;
    pub(super) fn lime_tree_read_step_assembly(
        path: *const c_char,
        error: *mut *mut c_char,
    ) -> *mut c_char;
    pub(super) fn lime_tree_read_step_named(
        path: *const c_char,
        out: *mut *mut RawShape,
        max: c_int,
        names: *mut *mut c_char,
        error: *mut *mut c_char,
    ) -> c_int;
    pub(super) fn lime_tree_solids(shape: *const RawShape, out: *mut *mut RawShape, max: c_int) -> c_int;
    pub(super) fn lime_tree_check(shape: *const RawShape, out: *mut c_int);
    pub(super) fn lime_tree_surfaces(shape: *const RawShape) -> *mut c_char;
    pub(super) fn lime_tree_bounds(shape: *const RawShape, out: *mut f64) -> c_int;
    pub(super) fn lime_tree_scale(
        from: *const RawShape,
        factor: f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_unify(from: *const RawShape, error: *mut *mut c_char) -> *mut RawShape;
    pub(super) fn lime_tree_extrude(
        from: *const RawShape,
        op: *const c_char,
        p: *const f64,
        points: *const f64,
        count: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    // K3. `flags` bit 0 depth2, bit 1 draft, bit 2 up to `face`.
    pub(super) fn lime_tree_extrude_extent(
        from: *const RawShape,
        op: *const c_char,
        p: *const f64,
        points: *const f64,
        count: c_int,
        depth2: f64,
        draft_deg: f64,
        face: c_int,
        flags: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_revolve(
        from: *const RawShape,
        op: *const c_char,
        p: *const f64,
        points: *const f64,
        count: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_loft(
        from: *const RawShape,
        op: *const c_char,
        head: *const f64,
        count: c_int,
        data: *const f64,
        ruled: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    // K1 profile v2. The three functions above stay for a point profile.
    pub(super) fn lime_tree_extrude_loops(
        from: *const RawShape,
        op: *const c_char,
        p: *const f64,
        loops: *const f64,
        loops_len: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    // K3 on K1 loops. `flags` matches lime_tree_extrude_extent.
    pub(super) fn lime_tree_extrude_loops_extent(
        from: *const RawShape,
        op: *const c_char,
        p: *const f64,
        loops: *const f64,
        loops_len: c_int,
        depth2: f64,
        draft_deg: f64,
        face: c_int,
        flags: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_revolve_loops(
        from: *const RawShape,
        op: *const c_char,
        p: *const f64,
        loops: *const f64,
        loops_len: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_loft_loops(
        from: *const RawShape,
        op: *const c_char,
        head: *const f64,
        count: c_int,
        data: *const f64,
        ruled: c_int,
        loop_at: *const c_int,
        loops: *const f64,
        loops_len: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    // --- K2 feature root. The same ops, built against no solid. ---
    pub(super) fn lime_tree_feature_extrude(
        op: *const c_char,
        p: *const f64,
        points: *const f64,
        count: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    // K3 on a feature root. `flags` matches lime_tree_extrude_extent. There is no face to stop at.
    pub(super) fn lime_tree_feature_extrude_extent(
        op: *const c_char,
        p: *const f64,
        points: *const f64,
        count: c_int,
        depth2: f64,
        draft_deg: f64,
        flags: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_feature_revolve(
        op: *const c_char,
        p: *const f64,
        points: *const f64,
        count: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_feature_loft(
        op: *const c_char,
        head: *const f64,
        count: c_int,
        data: *const f64,
        ruled: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    // K1 loops on a K2 feature root. The point-profile feature functions above stay as they are.
    pub(super) fn lime_tree_feature_extrude_loops(
        op: *const c_char,
        p: *const f64,
        loops: *const f64,
        loops_len: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    // K3 on K1 loops as a feature root. There is no face to stop at.
    pub(super) fn lime_tree_feature_extrude_loops_extent(
        op: *const c_char,
        p: *const f64,
        loops: *const f64,
        loops_len: c_int,
        depth2: f64,
        draft_deg: f64,
        flags: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_feature_revolve_loops(
        op: *const c_char,
        p: *const f64,
        loops: *const f64,
        loops_len: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_feature_loft_loops(
        op: *const c_char,
        head: *const f64,
        count: c_int,
        data: *const f64,
        ruled: c_int,
        loop_at: *const c_int,
        loops: *const f64,
        loops_len: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_pieces(from: *const RawShape, built: *const RawShape) -> *mut c_char;
    pub(super) fn lime_tree_shell(
        from: *const RawShape,
        faces: *const c_int,
        count: c_int,
        thickness: f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    // K4.
    pub(super) fn lime_tree_face_extrude(
        from: *const RawShape,
        face: c_int,
        distance: f64,
        draft_deg: f64,
        up_to: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_move_faces(
        from: *const RawShape,
        indexes: *const c_int,
        distances: *const f64,
        count: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_draft(
        from: *const RawShape,
        faces: *const c_int,
        count: c_int,
        angle_deg: f64,
        pull: *const f64,
        neutral_face: c_int,
        plane: *const f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_face_loops(
        shape: *const RawShape,
        face: c_int,
        error: *mut *mut c_char,
    ) -> *mut c_char;
    // --- Recipe reads and lattices (I5–I7, I19–I20). Keep this block together. ---
    pub(super) fn lime_tree_face_region(
        shape: *const RawShape,
        face: c_int,
        frame: *const f64,
        inset: f64,
        chord: f64,
        error: *mut *mut c_char,
    ) -> *mut c_char;
    pub(super) fn lime_tree_section(
        shape: *const RawShape,
        plane: *const f64,
        frame: *const f64,
        chord: f64,
        error: *mut *mut c_char,
    ) -> *mut c_char;
    pub(super) fn lime_tree_extrude_cells(
        from: *const RawShape,
        op: *const c_char,
        p: *const f64,
        loops: *const f64,
        loops_len: c_int,
        clip: *const f64,
        clip_len: c_int,
        depth2: f64,
        draft_deg: f64,
        flags: c_int,
        counts: *mut f64,
        note: *mut *mut c_char,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_combine(
        from: *const RawShape,
        op: *const c_char,
        tools: *const *const RawShape,
        count: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_combine_checked(
        from: *const RawShape,
        op: *const c_char,
        tools: *const *const RawShape,
        count: c_int,
        merge: c_int,
        missed: *mut c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    #[cfg(lime_occt_test_hooks)]
    pub(super) fn lime_tree_test_fault(shape: *const RawShape, error: *mut *mut c_char) -> c_int;
    #[cfg(lime_occt_test_hooks)]
    pub(super) fn lime_tree_test_place(
        shape: *const RawShape,
        mirror: c_int,
        offset: *const f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    #[cfg(lime_occt_test_hooks)]
    pub(super) fn lime_tree_test_last_fill() -> *mut c_char;
    #[cfg(lime_occt_test_hooks)]
    pub(super) fn lime_tree_test_nurbs(shape: *const RawShape, error: *mut *mut c_char) -> *mut RawShape;
    #[cfg(lime_occt_test_hooks)]
    pub(super) fn lime_tree_test_mesh(shape: *mut RawShape, chord: f64, error: *mut *mut c_char) -> *mut c_char;
    #[cfg(lime_occt_test_hooks)]
    pub(super) fn lime_tree_test_text(
        shape: *const RawShape,
        point: *const f64,
        error: *mut *mut c_char,
    ) -> *mut c_char;
    #[cfg(lime_occt_test_hooks)]
    pub(super) fn lime_tree_eval_nurbs_curve(
        poles: *const f64,
        npoles: c_int,
        weights: *const f64,
        degree: c_int,
        knots: *const f64,
        mults: *const c_int,
        nknots: c_int,
        periodic: c_int,
        params: *const f64,
        nparams: c_int,
        out: *mut f64,
        error: *mut *mut c_char,
    ) -> c_int;
    #[cfg(lime_occt_test_hooks)]
    pub(super) fn lime_tree_eval_nurbs_surface(
        poles: *const f64,
        nu: c_int,
        nv: c_int,
        weights: *const f64,
        degree_u: c_int,
        degree_v: c_int,
        knots_u: *const f64,
        mults_u: *const c_int,
        nknots_u: c_int,
        knots_v: *const f64,
        mults_v: *const c_int,
        nknots_v: c_int,
        params: *const f64,
        nparams: c_int,
        out: *mut f64,
        error: *mut *mut c_char,
    ) -> c_int;
    #[cfg(lime_occt_test_hooks)]
    pub(super) fn lime_tree_eval_built_nurbs_surface(
        blob: *const f64,
        len: c_int,
        params: *const f64,
        nparams: c_int,
        out: *mut f64,
        error: *mut *mut c_char,
    ) -> c_int;
    pub(super) fn lime_tree_created(shape: *const RawShape, out: *mut *const c_int) -> c_int;
    // --- A10.
    pub(super) fn lime_tree_face_from(shape: *const RawShape, out: *mut *const c_int) -> c_int;
    pub(super) fn lime_tree_set_face_from(shape: *mut RawShape, indexes: *const c_int, count: c_int);
    pub(super) fn lime_tree_edge_kinds(
        shape: *const RawShape,
        edges: *const c_int,
        count: c_int,
        out: *mut c_int,
    ) -> c_int;
    pub(super) fn lime_tree_counts(shape: *const RawShape, solids: *mut c_int, shells: *mut c_int);
    pub(super) fn lime_tree_face(shape: *mut RawShape, index: c_int, mid: *mut f64, area: *mut f64)
        -> c_int;
    pub(super) fn lime_tree_editable(shape: *const RawShape, error: *mut *mut c_char) -> c_int;
    pub(super) fn lime_tree_fingerprint(
        shape: *const RawShape,
        volume: *mut f64,
        faces: *mut c_int,
        edges: *mut c_int,
    );
    pub(super) fn lime_tree_edge(shape: *mut RawShape, index: c_int, mid: *mut f64, length: *mut f64)
        -> c_int;
    pub(super) fn lime_tree_mesh(
        shape: *mut RawShape,
        chord: f64,
        display: c_int,
        view: *mut MeshView,
        error: *mut *mut c_char,
    ) -> *mut RawMesh;
    pub(super) fn lime_tree_mesh_free(mesh: *mut RawMesh);
    pub(super) fn lime_tree_surface_inspect(
        shape: *mut RawShape,
        chord: f64,
        want_curvature: c_int,
        want_isoparms: c_int,
        iso_count: c_int,
        display: c_int,
        view: *mut SurfaceInspectView,
        error: *mut *mut c_char,
    ) -> *mut RawSurfaceInspect;
    pub(super) fn lime_tree_surface_inspect_free(inspect: *mut RawSurfaceInspect);
    /// --- Organic surfaces S2: real kernel sweep (`BRepOffsetAPI_MakePipeShell`), standalone when `from` is null.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lime_tree_sweep(
        from: *const RawShape,
        op: *const c_char,
        head: *const f64,
        section_count: c_int,
        data: *const f64,
        loop_blob: *const f64,
        loop_count: c_int,
        loop_at: *const c_int,
        spine_blob: *const f64,
        spine_count: c_int,
        aux_blob: *const f64,
        aux_count: c_int,
        mode: c_int,
        binormal: *const f64,
        transition: c_int,
        scale_stations: *const f64,
        scale_count: c_int,
        twist_deg: f64,
        cap_start: c_int,
        cap_end: c_int,
        cap_length: f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    /// --- Organic surfaces S3: controlled Loft v2 (apex caps, guide rails, boundary tangency/curvature, closed periodic, degree cap).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lime_tree_loft_v2(
        from: *const RawShape,
        op: *const c_char,
        head: *const f64,
        section_count: c_int,
        data: *const f64,
        loop_blob: *const f64,
        loop_count: c_int,
        loop_at: *const c_int,
        apex_flags: *const c_int,
        ruled: c_int,
        closed: c_int,
        smoothing: c_int,
        max_degree: c_int,
        conds: *const f64,
        guides_blob: *const f64,
        guides_len: c_int,
        guide_count: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    /// --- Organic surfaces S4: Open Sheets & Surface-to-Solid Workflow.
    pub(super) fn lime_tree_sheet(
        from: *const RawShape,
        mode: c_int,
        params: *const f64,
        curves_blob: *const f64,
        curves_len: c_int,
        curve_count: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lime_tree_sew(
        from: *const RawShape,
        extra_tools: *const *const RawShape,
        places: *const f64,
        extra_count: c_int,
        tolerance: f64,
        make_solid: c_int,
        cap_planar: c_int,
        out_promoted: *mut c_int,
        out_naked: *mut c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_thicken(
        from: *const RawShape,
        thickness: f64,
        direction: c_int,
        tolerance: f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lime_tree_trim_split(
        from: *const RawShape,
        tool_shape: *const RawShape,
        place: *const f64,
        sheet_mode: c_int,
        sheet_params: *const f64,
        curves_blob: *const f64,
        curves_len: c_int,
        curve_count: c_int,
        keep_mode: c_int,
        other_out: *mut *mut RawShape,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lime_tree_replace_face(
        from: *const RawShape,
        face_index: c_int,
        tool_shape: *const RawShape,
        place: *const f64,
        sheet_mode: c_int,
        sheet_params: *const f64,
        curves_blob: *const f64,
        curves_len: c_int,
        curve_count: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lime_tree_split_face(
        from: *const RawShape,
        face_indexes: *const c_int,
        face_count: c_int,
        curve_blob: *const f64,
        curve_len: c_int,
        has_dir: c_int,
        dir: *const f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    /// --- Organic surfaces S5: fill an opening, or bridge two open edges.
    pub(super) fn lime_tree_patch(
        from: *const RawShape,
        blob: *const f64,
        len: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_blend_surface(
        from: *const RawShape,
        blob: *const f64,
        len: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    /// S6: one NURBS sheet from an M by N pole grid. `from` is null when the surface starts a part.
    pub(super) fn lime_tree_nurbs_surface(
        from: *const RawShape,
        blob: *const f64,
        len: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    pub(super) fn lime_tree_distance(
        shape: *const RawShape,
        a_kind: *const c_char,
        a_index: c_int,
        b_kind: *const c_char,
        b_index: c_int,
        out: *mut f64,
        error: *mut *mut c_char,
    ) -> c_int;
    pub(super) fn lime_tree_write_step(
        shape: *const RawShape,
        path: *const c_char,
        error: *mut *mut c_char,
    ) -> c_int;
    pub(super) fn lime_model_occt_string_free(text: *mut c_char);
}
