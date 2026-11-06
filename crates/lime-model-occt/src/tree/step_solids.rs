//! Reading the named solids of a STEP file, for the stateless `step_solids` calls.

use super::{lock, temp_step};
use super::shape::Shape;

/// --- Split to print (D12). The solids of a STEP file with their product names, each checked as a partition's piece, in
/// the file's order (see `named_solids_of`).
pub fn step_named_solids(step: &[u8]) -> Result<Vec<(String, crate::PartitionPiece)>, String> {
    let _store = lock();
    Ok(named_solids_of(step)?
        .into_iter()
        .map(|(name, shape)| (name, shape.check()))
        .collect())
}

/// The most solids a STEP file opens as pieces.
pub(super) const STEP_SOLIDS_MAX: usize = 256;

/// The solids of a STEP file in the file's order, each with the product name of the free shape it came from when that
/// shape is this one solid, and an empty name when the shape is an assembly that holds several or has no name. A named
/// simple shape that holds several solids is one piece, the compound under its name, as a split to print's pins are
/// written (`<source>-pins`). Read through the XCAF document reader, so a split to print's STEP export reads back as
/// its named pieces.
pub(super) fn named_solids_of(step: &[u8]) -> Result<Vec<(String, Shape)>, String> {
    let path = temp_step("read-named");
    std::fs::write(&path, step).map_err(|err| err.to_string())?;
    let read = Shape::read_step_named(&path);
    let _ = std::fs::remove_file(&path);
    let more = format!("This STEP file has more than {STEP_SOLIDS_MAX} solids");
    let mut out = Vec::new();
    for (flagged, shape) in read? {
        let (assembly, name) = flagged.split_at(flagged.chars().next().map_or(0, char::len_utf8));
        let solids = shape.solids_up_to(STEP_SOLIDS_MAX, &more)?;
        if assembly == "S" && solids.len() > 1 && !name.trim().is_empty() {
            if out.len() == STEP_SOLIDS_MAX {
                return Err(more);
            }
            out.push((name.trim().to_string(), shape));
            continue;
        }
        let name = if solids.len() == 1 { name.trim().to_string() } else { String::new() };
        for solid in solids {
            if out.len() == STEP_SOLIDS_MAX {
                return Err(more);
            }
            out.push((name.clone(), solid));
        }
    }
    Ok(out)
}

/// --- Split to print (D12). The solids a STEP file holds, each checked as a partition's piece, in the file's order.
pub fn step_solids(step: &[u8]) -> Result<Vec<crate::PartitionPiece>, String> {
    let _store = lock();
    let path = temp_step("read");
    std::fs::write(&path, step).map_err(|err| err.to_string())?;
    let read = Shape::read_step(&path);
    let _ = std::fs::remove_file(&path);
    Ok(read?.solids()?.iter().map(Shape::check).collect())
}
