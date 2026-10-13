//! Start a helper process without a console window.
//!
//! The Open CASCADE bridge is loaded in-process, so it is not a sidecar and
//! does not get its own console. The release desktop binary hides its own
//! console with `windows_subsystem = "windows"`. Any helper this shell starts
//! still has to pass [`CREATE_NO_WINDOW`], or Windows opens a console for it.

#![allow(dead_code)]

use std::ffi::OsStr;
use std::process::Command;

/// Windows `CREATE_NO_WINDOW`. A console-subsystem child would otherwise flash a window.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn quiet_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    hide_window(&mut command);
    command
}

fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_desktop_binary_hides_its_console() {
        let main = include_str!("main.rs");
        assert!(
            main.contains("windows_subsystem = \"windows\""),
            "the release desktop binary must not open a console"
        );
        assert!(
            main.contains("not(debug_assertions)"),
            "debug builds may keep a console"
        );
    }

    #[test]
    fn a_sidecar_is_spawned_with_create_no_window() {
        let src = include_str!("quiet_process.rs");
        assert!(src.contains("CREATE_NO_WINDOW"));
        assert!(src.contains("0x0800_0000"));
        let command = quiet_command("lime-slice");
        assert_eq!(command.get_program(), "lime-slice");
    }
}
