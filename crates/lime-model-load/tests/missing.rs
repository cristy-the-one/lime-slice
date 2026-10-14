#[test]
fn a_missing_bridge_stays_an_error() {
    unsafe { std::env::set_var("LIME_OCCT_BRIDGE", "/no/such/lime_model_occt.so") };
    let text = lime_model_load::tree(r#"{"call":"open","key":"missing","box":[1,1,1]}"#)
        .expect_err("bridge should be absent");
    assert!(text.contains("Open CASCADE bridge was not found"), "{text}");
}
