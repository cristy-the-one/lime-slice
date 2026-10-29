//! Export a G-code file of any length without the page holding it.
//!
//! The app stamps an exported file in TypeScript: the header Moonraker reads,
//! `M73` progress after each `;LAYER:` line, the footer estimates and grams,
//! and the printer's start and end text (`src/print-file.ts`). A long part's
//! file runs to hundreds of MB, and a browser string tops out near 536M
//! characters, with several copies made on the way.
//!
//! So the engine sends a skeleton instead: the file with every run of lines
//! the stamp never reads replaced by one placeholder line. The page stamps
//! the skeleton with the same code, and the engine writes the stamped
//! skeleton with each placeholder put back, straight to disk.
//!
//! The stamp reads only the lines [`stamp_reads`] keeps, all of the file up
//! to the first `;LAYER:` line and the first command, and the line breaks
//! around them. Each elided run is a whole line or more, none of them kept,
//! so every search the stamp makes finds the same lines at the same places,
//! and every insert lands between the same two lines. Keep [`stamp_reads`]
//! in step with `src/print-meta.ts`, `src/machine-gcode.ts`, and
//! `withFooterGrams` in `src/estimate.ts`.

use std::io::{self, Write};

/// Starts a placeholder line. G-code text never holds it.
const MARK: char = '\u{1}';

/// Whether the stamp may read or drop `line` (without its `\n`), so the
/// skeleton keeps it verbatim.
fn stamp_reads(line: &str) -> bool {
    line.is_empty()
        // A JavaScript `^` or `.` also stops at these.
        || line.contains(['\r', '\u{2028}', '\u{2029}'])
        // `;LAYER:` marks, where `M73` goes.
        || line.starts_with(";LAYER:")
        // The estimate line, found with `lastIndexOf("; TIME:")`.
        || line.contains("; TIME:")
        // The cooldown block `M106 S0\nM104 S0\nM140 S0\n`, found by `lastIndexOf`.
        || line.ends_with("M106 S0")
        // The final `M84`.
        || line == "M84"
        // Homing, and the preamble lines a start block that owns homing drops or restates.
        || line.starts_with("G28")
        || ["M140 S", "M104 S", "M190 S", "M109 S"]
            .iter()
            .any(|code| line.starts_with(code))
        || matches!(line, "G92 E0" | "G90" | "M82")
}

/// One piece of the source: a line the skeleton keeps, or a run of lines it
/// elides. Each piece's text ends with `\n` unless it ends the file.
enum Piece<'a> {
    Kept(&'a str),
    Run(&'a str),
}

/// The source in pieces, in order. Nothing is elided before the first
/// `;LAYER:` line and the first command, so the leading comment header and
/// the engine preamble stay whole.
fn pieces(text: &str) -> impl Iterator<Item = Piece<'_>> {
    let mut lines = text.split_inclusive('\n').peekable();
    let mut layered = false;
    let mut commanded = false;
    std::iter::from_fn(move || {
        let line = lines.next()?;
        let bare = line.strip_suffix('\n').unwrap_or(line);
        let open = layered && commanded;
        layered |= bare.starts_with(";LAYER:");
        commanded |= !bare.starts_with(';');
        if !open || stamp_reads(bare) {
            return Some(Piece::Kept(line));
        }
        let start = line.as_ptr() as usize - text.as_ptr() as usize;
        let mut end = start + line.len();
        while let Some(next) = lines.peek() {
            if stamp_reads(next.strip_suffix('\n').unwrap_or(next)) {
                break;
            }
            end += next.len();
            lines.next();
        }
        Some(Piece::Run(&text[start..end]))
    })
}

/// `text` with each elided run as one line, `\u{1}` and the run's index.
pub fn skeleton(text: &str) -> String {
    let mut out = String::new();
    let mut runs = 0usize;
    for piece in pieces(text) {
        match piece {
            Piece::Kept(line) => out.push_str(line),
            Piece::Run(run) => {
                out.push(MARK);
                out.push_str(&runs.to_string());
                if run.ends_with('\n') {
                    out.push('\n');
                }
                runs += 1;
            }
        }
    }
    out
}

/// Writes `stamped`, a stamped [`skeleton`] of `source`, with each
/// placeholder put back, and returns the bytes written. Fails before
/// writing anything when the placeholders are not each there once, in
/// order: a stamp that cut or doubled one would write the wrong file.
pub fn write_filled(source: &str, stamped: &str, out: &mut impl Write) -> io::Result<u64> {
    let total = filled_len(source, stamped)?;
    let mut runs = elided_runs(source);
    for line in stamped.split_inclusive('\n') {
        let bare = line.strip_suffix('\n').unwrap_or(line);
        if placeholder(bare).is_some() {
            let run = runs.next().expect("checked by filled_len");
            out.write_all(run.strip_suffix('\n').unwrap_or(run).as_bytes())?;
            out.write_all(&line.as_bytes()[bare.len()..])?;
        } else {
            out.write_all(line.as_bytes())?;
        }
    }
    Ok(total)
}

/// The length [`write_filled`] writes, after checking every placeholder.
pub fn filled_len(source: &str, stamped: &str) -> io::Result<u64> {
    let mut runs = elided_runs(source);
    let mut next = 0usize;
    let mut total = 0u64;
    for line in stamped.split_inclusive('\n') {
        let bare = line.strip_suffix('\n').unwrap_or(line);
        let Some(index) = placeholder(bare) else {
            total += line.len() as u64;
            continue;
        };
        let run = runs.next().filter(|_| index == next).ok_or_else(|| lost(next))?;
        next += 1;
        total += (run.strip_suffix('\n').unwrap_or(run).len() + line.len() - bare.len()) as u64;
    }
    match runs.next() {
        Some(_) => Err(lost(next)),
        None => Ok(total),
    }
}

fn lost(index: usize) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("the stamped G-code lost elided run {index}"),
    )
}

fn elided_runs(source: &str) -> impl Iterator<Item = &str> {
    pieces(source).filter_map(|piece| match piece {
        Piece::Run(run) => Some(run),
        Piece::Kept(_) => None,
    })
}

fn placeholder(line: &str) -> Option<usize> {
    let digits = line.strip_prefix(MARK)?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "; generated by Lime Slice — FDM strategy blender\n; layer height 0.2\nG21\nM140 S60\nM104 S210\nG28\nG92 E0\nG90\nM82\n;LAYER:0\n;TYPE:outer\nG1 X1 Y1 E0.1\nG1 X2 Y1 E0.2\nM106 S255\n;LAYER:1\nG92 E0\nG1 X1 Y2 E0.1\n;TYPE:inner\nG1 X3 Y2 E0.3\n\n;LAYER:2\nG1 X4 Y4 E0.4\nM106 S0\nM104 S0\nM140 S0\nG1 Z10\nM84\n; TIME:12.5s FILAMENT_MM:100.0 FILAMENT_G:0.300\n";

    fn filled(source: &str, stamped: &str) -> String {
        let mut out = Vec::new();
        let n = write_filled(source, stamped, &mut out).unwrap();
        assert_eq!(n as usize, out.len());
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn the_skeleton_fills_back_to_the_file() {
        let skel = skeleton(FILE);
        assert!(skel.len() < FILE.len());
        assert!(skel.contains(";LAYER:2\n\u{1}"), "{skel}");
        assert!(skel.contains("M106 S0\nM104 S0\nM140 S0\n"));
        assert!(skel.starts_with(&FILE[..FILE.find(";LAYER:0").unwrap()]));
        assert_eq!(filled(FILE, &skel), FILE);
        let unterminated = FILE.trim_end_matches('\n').replace("M84\n; TIME", "M84\nG1 X0\n; TIME") + "\nG1 X9";
        assert_eq!(filled(&unterminated, &skeleton(&unterminated)), unterminated);
    }

    #[test]
    fn inserts_between_kept_lines_land_in_the_file() {
        let skel = skeleton(FILE);
        let stamped = skel
            .replace(";LAYER:1\n", ";LAYER:1\nM73 P50 R1\n")
            .replace("M84\n", "; end\nM84\n");
        let want = FILE
            .replace(";LAYER:1\n", ";LAYER:1\nM73 P50 R1\n")
            .replace("M84\n", "; end\nM84\n");
        assert_eq!(filled(FILE, &stamped), want);
    }

    #[test]
    fn a_lost_or_doubled_placeholder_writes_nothing() {
        let skel = skeleton(FILE);
        let first = skel.find('\u{1}').unwrap();
        let line_end = first + skel[first..].find('\n').unwrap() + 1;
        let cut = format!("{}{}", &skel[..first], &skel[line_end..]);
        let doubled = format!("{}{}", &skel[..line_end], &skel[first..]);
        for bad in [cut, doubled] {
            let mut out = Vec::new();
            assert!(write_filled(FILE, &bad, &mut out).is_err());
            assert!(out.is_empty());
        }
    }

    #[test]
    fn nothing_is_elided_before_the_first_layer_and_command() {
        let comments = ";LAYER:0\n;TYPE:outer\n;TYPE:inner\nG1 X1\nG1 X2\n";
        let skel = skeleton(comments);
        assert!(skel.starts_with(";LAYER:0\n;TYPE:outer\n;TYPE:inner\nG1 X1\n\u{1}0\n"), "{skel:?}");
        assert_eq!(filled(comments, &skel), comments);
    }
}
