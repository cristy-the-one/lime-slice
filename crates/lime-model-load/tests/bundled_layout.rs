//! Windows installs the bridge and the Open CASCADE DLLs in one folder
//! (`occt/lib`). That folder is not on `PATH`. Loading must still succeed.
//! Linux and macOS find those neighbours with rpath, so this test runs on Windows.

#[cfg(windows)]
mod windows {
    use std::path::{Path, PathBuf};

    #[test]
    fn bridge_loads_when_its_folder_is_not_on_path() {
        let require = std::env::var_os("LIME_REQUIRE_OCCT").is_some();
        let root = std::env::var_os("OCCT_ROOT")
            .map(PathBuf::from)
            .filter(|path| path.is_dir());
        let built = built_bridge();
        let (Some(root), Some(built)) = (root, built) else {
            if require {
                panic!(
                    "LIME_REQUIRE_OCCT is set, but the bundled layout cannot be built (OCCT_ROOT={}, bridge={})",
                    std::env::var("OCCT_ROOT").unwrap_or_else(|_| "<unset>".into()),
                    std::env::var("LIME_OCCT_BRIDGE_DLL").unwrap_or_else(|_| "<unset>".into())
                );
            }
            eprintln!("skipping bundled layout load: OCCT_ROOT or the bridge dll is absent");
            return;
        };
        load_bundled(&root, &built);
    }

    fn load_bundled(root: &Path, built: &Path) {
        let layout = std::env::temp_dir().join(format!("lime-occt-layout-{}", std::process::id()));
        let lib_dir = layout.join("occt").join("lib");
        std::fs::create_dir_all(&lib_dir).expect("layout directory");
        copy_occt_dlls(root, &lib_dir);
        let copied = dependency_dlls(&lib_dir);
        let bridge = lib_dir.join("lime_model_occt.dll");
        std::fs::copy(built, &bridge).expect("copy bridge dll");
        assert!(
            copied.len() >= 20,
            "expected the Open CASCADE dependency DLLs beside the bridge, found {} from {}: {}",
            copied.len(),
            root.display(),
            copied.join(", ")
        );
        for name in [
            "TKernel.dll",
            "TKMath.dll",
            "TKPrim.dll",
            "TKMesh.dll",
            "TKDESTEP.dll",
        ] {
            assert!(
                lib_dir.join(name).is_file(),
                "missing {name} in {}",
                lib_dir.display()
            );
        }

        let exe_dir = std::env::current_exe()
            .expect("test executable")
            .parent()
            .expect("test executable directory")
            .to_path_buf();
        assert!(
            !exe_dir.join("TKernel.dll").is_file(),
            "the test executable's folder contains TKernel.dll, so a default search would hide this bug"
        );
        let cwd = layout.join("cwd");
        std::fs::create_dir_all(&cwd).expect("cwd");
        std::env::set_current_dir(&cwd).expect("leave the dll folder");

        let mut forbidden = vec![
            lib_dir.clone(),
            root.to_path_buf(),
            root.join("bin"),
            root.join("lib"),
        ];
        forbidden.push(exe_dir);
        scrub_path(&forbidden);
        assert_folder_not_on_path(&lib_dir);

        let bridge = std::path::absolute(&bridge).unwrap_or(bridge);
        assert!(bridge.is_absolute(), "{}", bridge.display());
        unsafe { std::env::set_var("LIME_OCCT_BRIDGE", &bridge) };
        println!(
            "loading {} with {} Open CASCADE DLLs and that folder off PATH",
            bridge.display(),
            copied.len()
        );

        let json =
            lime_model_load::open_box(10.0, 20.0, 30.0).expect("dlopen from the bundled layout");
        assert!(!json.contains("\"error\""), "{json}");
        let volume = volume_of(&json);
        assert!((volume - 6000.0).abs() < 0.05, "{volume} from {json}");
    }

    fn built_bridge() -> Option<PathBuf> {
        if let Some(path) = std::env::var_os("LIME_OCCT_BRIDGE_DLL") {
            let path = PathBuf::from(path);
            return path.is_file().then_some(path);
        }
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut roots = Vec::new();
        if let Some(dir) = std::env::var_os("CARGO_TARGET_DIR") {
            roots.push(PathBuf::from(dir));
        }
        roots.push(manifest.join("../..").join("target"));
        for root in roots {
            for profile in ["debug", "release"] {
                let path = root.join(profile).join("lime_model_occt.dll");
                if path.is_file() {
                    return Some(path);
                }
            }
        }
        None
    }

    fn copy_occt_dlls(root: &Path, dest: &Path) {
        for folder in [root.join("bin"), root.join("lib")] {
            let Ok(entries) = std::fs::read_dir(&folder) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                let lower = name.to_ascii_lowercase();
                if !lower.ends_with(".dll")
                    || !(lower.starts_with("tk") || lower.starts_with("libtk"))
                {
                    continue;
                }
                std::fs::copy(&path, dest.join(name))
                    .unwrap_or_else(|err| panic!("copy {name} from {}: {err}", path.display()));
            }
        }
    }

    fn dependency_dlls(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .expect("layout listing")
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                let lower = name.to_ascii_lowercase();
                (lower.ends_with(".dll") && lower != "lime_model_occt.dll").then_some(name)
            })
            .collect();
        names.sort();
        names
    }

    fn scrub_path(forbidden: &[PathBuf]) {
        let original = std::env::var_os("PATH").unwrap_or_default();
        let mut kept = Vec::new();
        for dir in std::env::split_paths(&original) {
            if forbidden.iter().any(|ban| same_dir(&dir, ban)) {
                continue;
            }
            if dir.join("TKernel.dll").is_file() || dir.join("lime_model_occt.dll").is_file() {
                continue;
            }
            kept.push(dir);
        }
        let cleaned = std::env::join_paths(&kept).expect("cleaned PATH");
        unsafe { std::env::set_var("PATH", &cleaned) };
    }

    fn assert_folder_not_on_path(lib_dir: &Path) {
        let path = std::env::var("PATH").unwrap_or_default();
        let needle = normalize(lib_dir);
        assert!(
            !path
                .to_ascii_lowercase()
                .contains(&needle.to_ascii_lowercase()),
            "bundle folder is still on PATH: {lib_dir:?} in {path}"
        );
        for dir in std::env::split_paths(&path) {
            assert!(
                !dir.join("TKernel.dll").is_file(),
                "TKernel.dll is still on PATH at {}",
                dir.display()
            );
        }
        let cwd = std::env::current_dir().expect("cwd");
        assert!(!same_dir(&cwd, lib_dir), "cwd is the dll folder");
    }

    fn same_dir(left: &Path, right: &Path) -> bool {
        normalize(left).eq_ignore_ascii_case(&normalize(right))
    }

    fn normalize(path: &Path) -> String {
        let mut text = path.to_string_lossy().replace('/', "\\");
        while text.len() > 3 && text.ends_with('\\') {
            text.pop();
        }
        text
    }

    fn volume_of(json: &str) -> f64 {
        let key = "\"volumeMm3\":";
        let start = json
            .find(key)
            .unwrap_or_else(|| panic!("no volume in {json}"));
        let rest = &json[start + key.len()..];
        let end = rest
            .find(|ch: char| !(ch.is_ascii_digit() || ch == '.' || ch == '-' || ch == '+'))
            .unwrap_or(rest.len());
        rest[..end]
            .parse()
            .unwrap_or_else(|err| panic!("volume {err} in {json}"))
    }
}
