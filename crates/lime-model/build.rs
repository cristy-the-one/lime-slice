//! Link Open CASCADE as shared libraries when `OCCT_ROOT` is set.
//!
//! A missing `OCCT_ROOT` compiles a stub and does not invoke the C++ compiler.
//! The link line is `dylib` only. A static archive is refused.

use std::env;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo::rustc-check-cfg=cfg(lime_occt)");
    println!("cargo:rerun-if-env-changed=OCCT_ROOT");
    println!("cargo:rerun-if-changed=cpp/bridge.cpp");
    let Ok(root) = env::var("OCCT_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let include = include_dir(&root);
    let lib_dir = lib_dir(&root);
    require_shared(&root);
    println!("cargo:rustc-cfg=lime_occt");
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=dylib=TKernel");
    let target = env::var("TARGET").unwrap_or_default();
    if target.contains("linux") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
    } else if target.contains("apple") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Resources/occt/lib");
    }

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++17")
        .file("cpp/bridge.cpp")
        .include(&include);
    if env::var("CARGO_CFG_TARGET_ENV").ok().as_deref() == Some("msvc") {
        build.flag("/EHsc");
    }
    build.compile("lime_occt_bridge");
}

fn include_dir(root: &Path) -> PathBuf {
    let unix = root.join("include/opencascade");
    if unix.join("Standard_VersionInfo.hxx").is_file() {
        return unix;
    }
    let win = root.join("inc");
    if win.join("Standard_VersionInfo.hxx").is_file() {
        return win;
    }
    panic!(
        "OCCT_ROOT {} has no Standard_VersionInfo.hxx under include/opencascade or inc",
        root.display()
    );
}

fn lib_dir(root: &Path) -> PathBuf {
    let lib = root.join("lib");
    if lib.is_dir() {
        return lib;
    }
    panic!("OCCT_ROOT {} has no lib directory", root.display());
}

fn require_shared(root: &Path) {
    let shared = [
        root.join("lib/libTKernel.so"),
        root.join("lib/libTKernel.dylib"),
        root.join("bin/TKernel.dll"),
        root.join("lib/TKernel.dll"),
    ];
    if shared.iter().any(|path| path.exists()) {
        let static_lib = root.join("lib/libTKernel.a");
        if static_lib.exists() {
            panic!(
                "OCCT_ROOT contains a static archive at {}",
                static_lib.display()
            );
        }
        return;
    }
    panic!(
        "OCCT_ROOT {} has no shared TKernel library (looked for libTKernel.so, libTKernel.dylib, TKernel.dll)",
        root.display()
    );
}
