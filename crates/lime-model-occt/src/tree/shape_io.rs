//! Reading and writing a shape as STEP or as Open CASCADE binary (`LIMEBREP`).

use std::ffi::CString;
use std::os::raw::{c_char, c_int};
use std::ptr::NonNull;

use super::{brep_order, occt_version, temp_step, BREP_FORMAT, BREP_MAGIC, BREP_ORDER};
use super::ffi::{
    lime_model_occt_string_free,
    lime_tree_read_brep,
    lime_tree_read_step,
    lime_tree_read_step_named,
    lime_tree_write_brep,
    lime_tree_write_step,
    lime_tree_write_step_many,
    RawShape,
};
use super::shape::{c_path, take_text, Shape};
use super::step_solids::STEP_SOLIDS_MAX;

impl Shape {
    /// --- Split to print (D12). These solids as one STEP file, each a product of its own named by the same place in
    /// `names`. Every shape in `raw` is held by a node until this returns.
    /// --- Assemblies M9: `places`, empty or twelve numbers a solid (`Affine::placement`), is where each is written.
    pub(super) fn step_bytes_of(
        raw: &[*const RawShape],
        names: &[String],
        places: &[f64],
    ) -> Result<Vec<u8>, String> {
        if !places.is_empty() && places.len() != 12 * raw.len() {
            return Err("Each solid needs a pose".into());
        }
        let path = temp_step("export");
        let c = c_path(&path)?;
        let count = c_int::try_from(raw.len()).map_err(|_| "Too many solids".to_string())?;
        let named = names
            .iter()
            .map(|name| CString::new(name.as_str()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "A piece's name is not a C string".to_string())?;
        let pointers: Vec<*const c_char> = named.iter().map(|name| name.as_ptr()).collect();
        let mut error: *mut c_char = std::ptr::null_mut();
        // SAFETY: `raw` holds `count` live shapes, `pointers` as many NUL-terminated names, `places` is null or twelve
        // numbers a shape, and `c` is a NUL-terminated path.
        let ok = unsafe {
            lime_tree_write_step_many(
                raw.as_ptr(),
                pointers.as_ptr(),
                if places.is_empty() {
                    std::ptr::null()
                } else {
                    places.as_ptr()
                },
                count,
                c.as_ptr(),
                &mut error,
            )
        };
        let message = take_text(error);
        let bytes = if ok == 0 {
            Err(message.unwrap_or_else(|| "Open CASCADE did not write these solids".into()))
        } else {
            std::fs::read(&path).map_err(|err| err.to_string())
        };
        let _ = std::fs::remove_file(&path);
        bytes
    }

    /// --- Split to print (D12). The free shapes of a STEP file with their product names, in the file's order, at most
    /// `STEP_SOLIDS_MAX`.
    pub(super) fn read_step_named(path: &std::path::Path) -> Result<Vec<(String, Shape)>, String> {
        const MAX_SOLIDS: usize = STEP_SOLIDS_MAX;
        let path = c_path(path)?;
        let mut out = vec![std::ptr::null_mut::<RawShape>(); MAX_SOLIDS];
        let mut names: *mut c_char = std::ptr::null_mut();
        let mut error: *mut c_char = std::ptr::null_mut();
        // SAFETY: `out` has room for `MAX_SOLIDS` shapes, and `path` is NUL-terminated.
        let made = unsafe {
            lime_tree_read_step_named(
                path.as_ptr(),
                out.as_mut_ptr(),
                MAX_SOLIDS as c_int,
                &mut names,
                &mut error,
            )
        };
        let message = take_text(error);
        let names = take_text(names).unwrap_or_default();
        let made = usize::try_from(made).map_err(|_| {
            message.unwrap_or_else(|| "Open CASCADE could not read this STEP file".into())
        })?;
        Ok(names
            .lines()
            .map(str::to_string)
            .zip(
                out[..made]
                    .iter()
                    .filter_map(|solid| NonNull::new(*solid).map(Shape)),
            )
            .collect())
    }

    pub(super) fn read_step(path: &std::path::Path) -> Result<Shape, String> {
        let path = c_path(path)?;
        Shape::made(|error| unsafe { lime_tree_read_step(path.as_ptr(), error) })
    }

    /// A solid `brep_bytes` wrote: the same faces and edges, in the same order, as the step it was saved from.
    /// Bytes another Open CASCADE wrote are read as well; BinTools reads every older format. As a `step` it keeps the
    /// edges its step made, for a blend that picks them; as a root it made every edge it has.
    pub(super) fn read_brep(bytes: &[u8], step: bool) -> Result<Shape, String> {
        let damaged = || "This saved solid is damaged".to_string();
        let end = bytes.iter().position(|&b| b == b'\n').ok_or_else(damaged)?;
        let header = std::str::from_utf8(&bytes[..end]).map_err(|_| damaged())?;
        let fields: Vec<&str> = header.split(' ').collect();
        let [_, format, occt, volume, created] = fields[..] else {
            return Err(damaged());
        };
        if format != BREP_FORMAT {
            return Err(format!(
                "This solid was saved in format {format}, which this modeler does not read"
            ));
        }
        let volume: f64 = volume.parse().map_err(|_| damaged())?;
        // `*` is every edge (a root, or a solid read from a file); else the edges its step made, by index.
        let created: Option<Vec<c_int>> = match created {
            "*" => None,
            "" | "-" => Some(Vec::new()),
            list => Some(
                list.split(',')
                    .map(|index| index.parse().map_err(|_| damaged()))
                    .collect::<Result<_, _>>()?,
            ),
        };
        let (made, count) = match created.as_ref().filter(|_| step) {
            Some(list) => (list.as_ptr(), list.len() as c_int),
            None => (std::ptr::null(), -1),
        };
        let (data, order) = brep_order(&bytes[end + 1..]);
        Shape::made(|error| unsafe {
            lime_tree_read_brep(
                data.as_ptr(),
                data.len(),
                volume,
                made,
                count,
                order.as_ptr(),
                order.len() as c_int,
                error,
            )
        })
        .map_err(|message| {
            let ours = occt_version();
            if occt == ours {
                message
            } else {
                format!("{message} (saved by Open CASCADE {occt}, this modeler has {ours})")
            }
        })
    }

    /// The solid as a project keeps it: a header line with the volume its step integrated, so a read
    /// integrates nothing and its fingerprint is the step's, then Open CASCADE's binary format.
    pub(super) fn brep_bytes(&self) -> Result<Vec<u8>, String> {
        let mut size = 0usize;
        let mut error: *mut c_char = std::ptr::null_mut();
        let raw = unsafe { lime_tree_write_brep(self.raw(), &mut size, &mut error) };
        let message = take_text(error);
        let Some(raw) = NonNull::new(raw) else {
            return Err(message.unwrap_or_else(|| "Open CASCADE did not write this solid".into()));
        };
        let created = self.created_indexes();
        let created = if created.len() == self.fingerprint().edges as usize
            && created
                .iter()
                .enumerate()
                .all(|(i, &index)| i as c_int == index)
        {
            "*".to_string()
        } else if created.is_empty() {
            "-".to_string()
        } else {
            created
                .iter()
                .map(c_int::to_string)
                .collect::<Vec<_>>()
                .join(",")
        };
        let header = format!(
            "{}{BREP_FORMAT} {} {} {created}\n",
            std::str::from_utf8(BREP_MAGIC).expect("ASCII"),
            occt_version(),
            self.fingerprint().volume_mm3
        );
        let mut out = Vec::with_capacity(header.len() + size);
        out.extend_from_slice(header.as_bytes());
        // SAFETY: the kernel wrote `size` bytes there; they are copied before the buffer is freed.
        out.extend_from_slice(unsafe {
            std::slice::from_raw_parts(raw.as_ptr().cast::<u8>(), size)
        });
        unsafe { lime_model_occt_string_free(raw.as_ptr()) };
        let order = self.mesh_order();
        if !order.is_empty() {
            out.extend_from_slice(BREP_ORDER);
            let list: Vec<String> = order.iter().map(c_int::to_string).collect();
            out.extend_from_slice(list.join(",").as_bytes());
            out.push(b'\n');
        }
        Ok(out)
    }

    pub(super) fn step_bytes(&self) -> Result<Vec<u8>, String> {
        let path = temp_step("export");
        let c = c_path(&path)?;
        let mut error: *mut c_char = std::ptr::null_mut();
        let ok = unsafe { lime_tree_write_step(self.raw(), c.as_ptr(), &mut error) };
        let message = take_text(error);
        let bytes = if ok == 0 {
            Err(message.unwrap_or_else(|| "Open CASCADE did not write this solid".into()))
        } else {
            std::fs::read(&path).map_err(|err| err.to_string())
        };
        let _ = std::fs::remove_file(&path);
        bytes
    }
}
