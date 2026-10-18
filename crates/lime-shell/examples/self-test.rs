//! Load the shell DLL and ask it for a thumbnail. Console program, run by hand.
//! The installer does not start this.

fn main() {
    #[cfg(windows)]
    windows_main();
    #[cfg(not(windows))]
    println!("lime-shell self-test runs on Windows");
}

#[cfg(windows)]
fn windows_main() {
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::process::ExitCode;

    let mut args = env::args().skip(1);
    let path = args.next().map(PathBuf::from).unwrap_or_else(sample);
    let dll = dll_beside_example();
    println!("file {}", path.display());
    println!("dll  {}", dll.display());
    if !dll.exists() {
        eprintln!("lime_shell.dll was not next to the example. Build the crate first.");
        std::process::exit(1);
    }
    unsafe {
        let lib = windows::Win32::System::LibraryLoader::LoadLibraryW(windows::core::PCWSTR(
            wide(&dll.to_string_lossy()).as_ptr(),
        ));
        let Ok(lib) = lib else {
            eprintln!("LoadLibrary failed");
            std::process::exit(1);
        };
        let _ = lib;
    }
    match lime_shell::win::thumbnail_bitmap(&path, 256) {
        Ok(pixels) => {
            let out = path.with_extension("thumb.bin");
            if fs::write(&out, &pixels).is_ok() {
                println!("wrote {} ({} bytes)", out.display(), pixels.len());
            }
            if pixels.iter().any(|b| *b != 0) {
                println!("thumbnail has pixels");
            } else {
                eprintln!("thumbnail was empty");
                std::process::exit(1);
            }
        }
        Err(err) => {
            eprintln!("thumbnail failed: {err}");
            std::process::exit(1);
        }
    }
    let _ = ExitCode::SUCCESS;
}

#[cfg(windows)]
fn sample() -> std::path::PathBuf {
    let path = std::env::temp_dir().join("lime-shell-sample.lime");
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAC0lEQVR4nGNgQAcAABIAAXfx+gAAAAAASUVORK5CYII=";
    let text = format!(
        r#"{{
  "thumbnail": {{"format":"png","width":2,"height":2,"data":"{png}","meshHash":"e55a0c3d9becba93","generatedBy":"lime-slice/2.7.0","createdAt":"2026-10-18T09:00:00.000Z"}},
  "summary": {{"name":"bracket.stl","printer":"Voron 2.4","objectCount":1,"layerHeight":0.2}},
  "version": 1,
  "mesh": {{"name":"bracket.stl","bytesBase64":"c3RsAQIDBAk=","byteLength":8,"hash":"eaa27901f3139a05"}},
  "placement": {{"orient":[1,0,0,0,1,0,0,0,1],"scale":1,"centered":true,"offset":{{"x":0,"y":0,"z":0}},"stepTolerance":0.05}},
  "settings": {{"layerHeight":0.2}},
  "preset": null,
  "profile": {{"name":"Voron 2.4"}},
  "level": "simple",
  "supportEdits": []
}}"#
    );
    let _ = std::fs::write(&path, text);
    path
}

#[cfg(windows)]
fn dll_beside_example() -> std::path::PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent()
        .and_then(|dir| dir.parent())
        .map(|dir| dir.join("lime_shell.dll"))
        .unwrap_or_else(|| std::path::PathBuf::from("lime_shell.dll"))
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}
