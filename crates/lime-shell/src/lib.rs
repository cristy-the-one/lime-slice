//! Explorer thumbnail, preview, and property handler for `.lime` files.
//!
//! The COM glue is Windows-only. Linux builds this crate so the workspace
//! still tests and lints; it does not register anything.

mod keys;

#[cfg(windows)]
pub mod win;

pub use keys::{registry_values, CLSID, PROGID};

/// The CLSID of the one handler that implements thumbnail, preview, and properties.
pub const HANDLER_CLSID: &str = CLSID;
/// ProgID Tauri already associates with `.lime`.
pub const HANDLER_PROGID: &str = PROGID;

#[cfg(test)]
mod tests {
    use super::keys::{registry_values, CLSID};

    #[test]
    fn registration_uses_the_documented_clsid() {
        let rows = registry_values(r"C:\Lime Slice\lime_shell.dll");
        let joined = rows
            .iter()
            .map(|row| format!("{}={}={}", row.key, row.name, row.data))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(crate::keys::registry_deletes()
            .iter()
            .any(|key| key.contains(CLSID)));
        assert!(joined.contains(CLSID));
        assert!(joined.contains("e357fccd-a995-4576-b01f-234630154e96"));
        assert!(joined.contains("8895b1c6-b41f-4c1c-a562-0d564250836f"));
        assert!(joined.contains("com.limeslice.slicer.lime"));
        assert!(joined.contains("6d2b5079-2f0b-48dd-ab7f-97cec514d30b"));
        assert!(rows
            .iter()
            .any(|row| row.data.contains("lime_shell.dll") && row.name.is_empty()));
        assert!(rows
            .iter()
            .any(|row| row.name == "ThreadingModel" && row.data == "Apartment"));
        assert!(rows
            .iter()
            .any(|row| row.key.ends_with(r"PropertyHandlers\.lime")));
    }
}
