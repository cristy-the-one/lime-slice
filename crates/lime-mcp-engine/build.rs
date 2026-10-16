fn main() {
    // N-API symbols are provided by the Node process that loads this cdylib.
    // The undefined symbols are in this crate's objects, so the link has to
    // allow them. Node defines them when it loads the file.
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("msvc") {
        println!("cargo:rustc-link-arg-cdylib=/FORCE:UNRESOLVED");
    } else if target.contains("apple") {
        println!("cargo:rustc-link-arg-cdylib=-undefined");
        println!("cargo:rustc-link-arg-cdylib=dynamic_lookup");
    } else {
        println!("cargo:rustc-link-arg-cdylib=-Wl,--unresolved-symbols=ignore-all");
    }
}
