use lime_slice_core::{load_mesh, load_slice_mesh_tol, set_step_mesher};
use std::sync::atomic::{AtomicUsize, Ordering};

static CALLS: AtomicUsize = AtomicUsize::new(0);

#[test]
fn registered_mesher_is_shared_by_preview_and_load_and_never_silently_falls_back() {
    set_step_mesher(
        |bytes, tolerance| {
            CALLS.fetch_add(1, Ordering::SeqCst);
            assert_eq!(tolerance, 0.05);
            if bytes == b"bad" {
                return Err("kernel import failed".into());
            }
            Ok(vec![[[0.0, 0.0, 3.0], [1.0, 0.0, 3.0], [0.0, 1.0, 4.0]]])
        },
        "test-backend".into(),
    );
    let mesh = load_mesh("shape.step", b"shape").unwrap();
    assert_eq!(mesh.bounds().unwrap().0[2], 0.0);
    let preview = lime_slice_core::mesh_preview("shape.STP", b"shape").unwrap();
    assert_eq!(preview.seat_mm, 3.0);
    assert_eq!(preview.positions.len(), 9);
    let raw = load_slice_mesh_tol("shape.step", b"shape", true, 0.0).unwrap();
    assert_eq!(raw.bounds().unwrap().0[2], 3.0);
    assert_eq!(
        load_mesh("shape.step", b"bad").unwrap_err(),
        "kernel import failed"
    );
    assert!(load_slice_mesh_tol("shape.step", b"shape", false, f64::NAN).is_err());
    assert_eq!(CALLS.load(Ordering::SeqCst), 4);
    load_mesh(
        "cube.stl",
        include_bytes!("../../../samples/calibration_cube_20mm.stl"),
    )
    .unwrap();
    assert_eq!(CALLS.load(Ordering::SeqCst), 4);
}
