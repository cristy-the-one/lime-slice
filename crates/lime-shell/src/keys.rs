//! The registry rows the installer and `DllRegisterServer` both write.
//! Kept free of Windows types so the list can be checked on Linux.

/// `{A344EC17-8764-5F01-9C73-FFE2DA751916}` — UUID v5 of `lime-slice.shell.handler`.
pub const CLSID: &str = "{A344EC17-8764-5F01-9C73-FFE2DA751916}";
pub const PROGID: &str = "com.limeslice.slicer.lime";
/// Windows' 64-bit prevhost. A new AppID is not created.
pub const PREVHOST: &str = "{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}";
const THUMB: &str = "{e357fccd-a995-4576-b01f-234630154e96}";
const PREVIEW: &str = "{8895b1c6-b41f-4c1c-a562-0d564250836f}";

#[derive(Clone, Debug, PartialEq)]
pub struct RegValue {
    /// Under `Software\Classes` or the absolute Software path for property handlers.
    pub key: String,
    /// Empty string is the default value.
    pub name: String,
    pub data: String,
}

/// Rows relative to `HKEY_CURRENT_USER\Software` or the installer's `SHCTX\Software`.
pub fn registry_values(dll: &str) -> Vec<RegValue> {
    let clsid = format!(r"Classes\CLSID\{CLSID}");
    vec![
        RegValue {
            key: clsid.clone(),
            name: String::new(),
            data: "Lime Slice project".into(),
        },
        RegValue {
            key: format!(r"{clsid}\InprocServer32"),
            name: String::new(),
            data: dll.into(),
        },
        RegValue {
            key: format!(r"{clsid}\InprocServer32"),
            name: "ThreadingModel".into(),
            data: "Apartment".into(),
        },
        RegValue {
            key: format!(r"{clsid}\InprocServer32"),
            name: "AppID".into(),
            data: PREVHOST.into(),
        },
        RegValue {
            key: format!(r"Classes\{PROGID}\shellex\{THUMB}"),
            name: String::new(),
            data: CLSID.into(),
        },
        RegValue {
            key: format!(r"Classes\{PROGID}\shellex\{PREVIEW}"),
            name: String::new(),
            data: CLSID.into(),
        },
        RegValue {
            key: format!(r"Classes\SystemFileAssociations\.lime\ShellEx\{THUMB}"),
            name: String::new(),
            data: CLSID.into(),
        },
        RegValue {
            key: format!(r"Classes\.lime\ShellEx\{PREVIEW}"),
            name: String::new(),
            data: CLSID.into(),
        },
        RegValue {
            key: r"Microsoft\Windows\CurrentVersion\PreviewHandlers".into(),
            name: CLSID.into(),
            data: "Lime Slice project".into(),
        },
        RegValue {
            key: r"Microsoft\Windows\CurrentVersion\PropertySystem\PropertyHandlers\.lime".into(),
            name: String::new(),
            data: CLSID.into(),
        },
    ]
}

/// Keys removed on uninstall. Subkeys are deleted as a whole where that is our CLSID.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn registry_deletes() -> Vec<String> {
    registry_values("").into_iter().map(|row| row.key).collect()
}
