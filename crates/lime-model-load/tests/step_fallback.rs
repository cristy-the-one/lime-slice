#[test]
fn absent_bridge_keeps_the_truck_loader() {
    // This integration test is its own process, so no other test sees this env.
    std::env::set_var("LIME_OCCT_BRIDGE", "missing-step-test-bridge");
    assert!(lime_model_load::step_mesher().is_none());
    let mesh = lime_slice_core::load_mesh(
        "cube.step",
        include_bytes!("../../lime-slice-core/tests/fixtures/cube.step"),
    )
    .unwrap();
    assert_eq!(mesh.bounds().unwrap(), ([0.0; 3], [10.0; 3]));
}
