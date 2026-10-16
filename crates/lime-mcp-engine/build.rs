fn main() {
    // Unix leaves the napi_* imports undefined. Node fills them in when it
    // loads the file. Windows resolves the same symbols at run time from the
    // host process, so the DLL has no unbound napi imports.
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("apple") {
        println!("cargo:rustc-link-arg-cdylib=-undefined");
        println!("cargo:rustc-link-arg-cdylib=dynamic_lookup");
    } else if !target.contains("windows") {
        println!("cargo:rustc-link-arg-cdylib=-Wl,--unresolved-symbols=ignore-all");
    }
}
