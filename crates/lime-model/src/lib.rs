//! Kernel boundary for STEP editing.
//!
//! `crates/lime-slice-core` does not depend on this crate. An unedited STEP
//! file is still read by truck. With `OCCT_ROOT` set at build time, [`open`]
//! dynamically links Open CASCADE and reports its version. Without it, [`open`]
//! returns an error and no OCCT header or library is used.

/// The swap point for a modeling kernel. OCCT is the first implementation.
pub trait Kernel {
    fn name(&self) -> &'static str;
    fn version(&self) -> &str;
}

/// A loaded kernel session. This scaffold only records the OCCT version.
pub struct Session {
    version: String,
}

impl Kernel for Session {
    fn name(&self) -> &'static str {
        "occt"
    }

    fn version(&self) -> &str {
        &self.version
    }
}

/// Load the OCCT shared library, or explain that it was not linked.
pub fn open() -> Result<Session, String> {
    #[cfg(lime_occt)]
    {
        occt::open()
    }
    #[cfg(not(lime_occt))]
    {
        Err("OCCT_ROOT is not set, so Open CASCADE is not linked".into())
    }
}

#[cfg(lime_occt)]
mod occt {
    use super::Session;

    extern "C" {
        fn lime_model_occt_version() -> *const std::ffi::c_char;
    }

    pub fn open() -> Result<Session, String> {
        let version = unsafe {
            let ptr = lime_model_occt_version();
            if ptr.is_null() {
                return Err("Open CASCADE returned an empty version".into());
            }
            std::ffi::CStr::from_ptr(ptr)
                .to_str()
                .map_err(|_| "Open CASCADE version is not UTF-8".to_string())?
                .to_string()
        };
        if !version.starts_with("7.9") {
            return Err(format!("Open CASCADE version {version} is not 7.9"));
        }
        Ok(Session { version })
    }
}
