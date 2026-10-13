//! The scaffold either reports OCCT 7.9 through a shared library, or it says
//! the library was not linked. `LIME_REQUIRE_OCCT=1` makes the second case a failure.

use lime_model::Kernel;
use std::path::Path;

#[test]
fn occt_is_dynamic_when_required() {
    match lime_model::open() {
        Ok(session) => {
            assert_eq!(session.name(), "occt");
            assert!(
                session.version().starts_with("7.9"),
                "version {}",
                session.version()
            );
            println!("linked {} {}", session.name(), session.version());
            assert_tkernel_is_shared();
        }
        Err(err) => {
            if std::env::var_os("LIME_REQUIRE_OCCT").is_some() {
                panic!("OCCT was required: {err}");
            }
        }
    }
}

fn assert_tkernel_is_shared() {
    let exe = std::env::current_exe().expect("test executable");
    let imports = shared_imports(&exe);
    let needle = tkernel_import_name();
    assert!(
        imports
            .iter()
            .any(|name| name.contains(&needle) && !name.contains("not found")),
        "TKernel is not a dynamic import of {}. imports: {}",
        exe.display(),
        imports.join(", ")
    );
}

fn tkernel_import_name() -> String {
    if cfg!(windows) {
        format!("{}Kernel.{}", "T", "dll")
    } else if cfg!(target_os = "macos") {
        format!("lib{}Kernel.", "T")
    } else {
        format!("lib{}Kernel.so", "T")
    }
}

fn shared_imports(exe: &Path) -> Vec<String> {
    #[cfg(windows)]
    {
        let bytes = std::fs::read(exe).expect("read test executable");
        return pe_import_dlls(&bytes).expect("PE imports");
    }
    #[cfg(not(windows))]
    {
        let tool = if cfg!(target_os = "macos") {
            "otool"
        } else {
            "ldd"
        };
        let mut cmd = std::process::Command::new(tool);
        if cfg!(target_os = "macos") {
            cmd.arg("-L");
        }
        let out = cmd.arg(exe).output().expect("list dynamic imports");
        assert!(
            out.status.success(),
            "{tool} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect()
    }
}

#[cfg(windows)]
fn pe_import_dlls(bytes: &[u8]) -> Result<Vec<String>, String> {
    if bytes.len() < 0x40 || &bytes[0..2] != b"MZ" {
        return Err("not a PE executable".into());
    }
    let e_lfanew = u32::from_le_bytes(bytes[0x3c..0x40].try_into().unwrap()) as usize;
    if bytes.len() < e_lfanew + 24 || &bytes[e_lfanew..e_lfanew + 4] != b"PE\0\0" {
        return Err("missing PE signature".into());
    }
    let coff = e_lfanew + 4;
    let sections = u16::from_le_bytes(bytes[coff + 2..coff + 4].try_into().unwrap()) as usize;
    let opt_size = u16::from_le_bytes(bytes[coff + 16..coff + 18].try_into().unwrap()) as usize;
    let opt = coff + 20;
    let magic = u16::from_le_bytes(bytes[opt..opt + 2].try_into().unwrap());
    let data_dir = match magic {
        0x20b => opt + 112,
        0x10b => opt + 96,
        _ => return Err("unknown PE optional header".into()),
    };
    let import_rva = u32::from_le_bytes(bytes[data_dir + 8..data_dir + 12].try_into().unwrap());
    if import_rva == 0 {
        return Err("PE has no import directory".into());
    }
    let sections_at = opt + opt_size;
    let mut table = Vec::with_capacity(sections);
    for index in 0..sections {
        let at = sections_at + index * 40;
        let virtual_size = u32::from_le_bytes(bytes[at + 8..at + 12].try_into().unwrap());
        let virtual_addr = u32::from_le_bytes(bytes[at + 12..at + 16].try_into().unwrap());
        let raw_size = u32::from_le_bytes(bytes[at + 16..at + 20].try_into().unwrap());
        let raw_ptr = u32::from_le_bytes(bytes[at + 20..at + 24].try_into().unwrap());
        table.push((virtual_addr, virtual_size.max(raw_size), raw_ptr));
    }
    let rva_to_off = |rva: u32| -> Result<usize, String> {
        for (va, span, raw) in &table {
            if rva >= *va && rva < va.saturating_add(*span) {
                return Ok((raw + (rva - va)) as usize);
            }
        }
        Err(format!("RVA {rva} is not in a section"))
    };
    let mut cursor = rva_to_off(import_rva)?;
    let mut names = Vec::new();
    loop {
        let name_rva = u32::from_le_bytes(bytes[cursor + 12..cursor + 16].try_into().unwrap());
        if name_rva == 0 {
            break;
        }
        let at = rva_to_off(name_rva)?;
        let end = bytes[at..]
            .iter()
            .position(|byte| *byte == 0)
            .ok_or("import name is not terminated")?;
        names.push(String::from_utf8_lossy(&bytes[at..at + end]).into_owned());
        cursor += 20;
    }
    Ok(names)
}
