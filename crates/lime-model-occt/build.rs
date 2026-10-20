//! Link the modeling toolkits when `OCCT_ROOT` is set. The desktop shell does
//! not depend on this crate, so a missing library cannot stop the app starting.

use std::env;
use std::path::{Path, PathBuf};

const LIBS: &[&str] = &[
    "TKernel",
    "TKMath",
    "TKG2d",
    "TKG3d",
    "TKGeomBase",
    "TKBRep",
    "TKGeomAlgo",
    "TKTopAlgo",
    "TKPrim",
    "TKMesh",
    "TKShHealing",
    "TKBO",
    "TKFillet",
    "TKOffset",
    // K3: BRepFeat_MakePrism and the draft prism (LocOpe_DPrism, the body of BRepFeat_MakeDPrism).
    // K4: draft and up-to face extrudes (BRepFeat). TKBool is the boolean toolkit those call.
    "TKBool",
    "TKFeat",
];

const STEP_LIBS: &[&str] = &[
    "TKCDF",
    "TKLCAF",
    "TKCAF",
    "TKService",
    "TKV3d",
    "TKVCAF",
    "TKXCAF",
    "TKXSBase",
    "TKDE",
    "TKDESTEP",
];

fn main() {
    println!("cargo::rustc-check-cfg=cfg(lime_occt)");
    println!("cargo::rustc-check-cfg=cfg(lime_occt_step)");
    println!("cargo::rustc-check-cfg=cfg(lime_occt_test_hooks)");
    println!("cargo:rerun-if-env-changed=OCCT_ROOT");
    println!("cargo:rerun-if-changed=cpp/kernel.cpp");
    println!("cargo:rerun-if-changed=cpp/tree.cpp");
    println!("cargo:rerun-if-changed=cpp/fault.cpp");
    println!("cargo:rerun-if-changed=cpp/kernel.h");
    let Ok(root) = env::var("OCCT_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let include = include_dir(&root);
    let lib_dir = root.join("lib");
    require_shared(&root);
    println!("cargo:rustc-cfg=lime_occt");
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    let mut linked = LIBS.to_vec();
    if step_reader(&root) {
        println!("cargo:rustc-cfg=lime_occt_step");
        linked.extend_from_slice(STEP_LIBS);
    }
    for lib in &linked {
        println!("cargo:rustc-link-lib=dylib={lib}");
    }
    let target = env::var("TARGET").unwrap_or_default();
    if target.contains("linux") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
        // rustc emits shared libs before the C++ archive, and --as-needed then
        // drops them. A second group after that archive resolves Open CASCADE.
        println!("cargo:rustc-link-arg=-Wl,--no-as-needed");
        println!("cargo:rustc-link-arg=-Wl,--start-group");
        for lib in &linked {
            println!("cargo:rustc-link-arg=-l{lib}");
        }
        println!("cargo:rustc-link-arg=-Wl,--end-group");
    } else if target.contains("apple") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Resources/occt/lib");
    }

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++17")
        .file("cpp/kernel.cpp")
        .file("cpp/tree.cpp")
        .file("cpp/fault.cpp")
        .include(&include);
    if env::var("CARGO_CFG_TARGET_ENV").ok().as_deref() == Some("msvc") {
        // /EHa, as Open CASCADE itself is built: a hardware fault inside it is then thrown as a C++ exception
        // (cpp/fault.cpp), and every frame it unwinds runs its destructors.
        build.flag("/EHa");
    } else {
        // Open CASCADE's CMake defines this off MSVC. OCC_CATCH_SIGNALS turns a signal into an exception only with it.
        build.define("OCC_CONVERT_SIGNALS", None);
    }
    // A debug build (every `cargo test`) has the hook that faults on purpose. A release build, which ships, has not.
    if env::var("PROFILE").ok().as_deref() == Some("debug") {
        build.define("LIME_OCCT_TEST_HOOKS", None);
        println!("cargo:rustc-cfg=lime_occt_test_hooks");
    }
    if step_reader(&root) {
        build.define("LIME_OCCT_STEP", None);
    }
    build.compile("lime_occt_kernel");
}

fn include_dir(root: &Path) -> PathBuf {
    for rel in ["include/opencascade", "inc"] {
        let dir = root.join(rel);
        if dir.join("Standard_VersionInfo.hxx").is_file() {
            return dir;
        }
    }
    panic!(
        "OCCT_ROOT {} has no Standard_VersionInfo.hxx under include/opencascade or inc",
        root.display()
    );
}

fn shared_named(root: &Path, stem: &str) -> bool {
    [
        root.join(format!("lib/lib{stem}.so")),
        root.join(format!("lib/lib{stem}.dylib")),
        root.join(format!("bin/{stem}.dll")),
        root.join(format!("lib/{stem}.dll")),
    ]
    .iter()
    .any(|path| path.exists())
}

fn require_shared(root: &Path) {
    if root.join("lib/libTKernel.a").exists() {
        panic!(
            "OCCT_ROOT contains a static archive at {}",
            root.join("lib/libTKernel.a").display()
        );
    }
    for stem in ["TKernel", "TKPrim", "TKMesh", "TKTopAlgo"] {
        if !shared_named(root, stem) {
            panic!("OCCT_ROOT {} has no shared {stem} library", root.display());
        }
    }
}

fn step_reader(root: &Path) -> bool {
    shared_named(root, "TKDESTEP")
}
