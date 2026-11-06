//! The Hershey pen fonts (docs/plan-text-on-curves-and-fonts.md, "As built (Hershey)"): single-stroke letters digitised by Dr. A. V.
//! Hershey at the U.S. National Bureau of Standards, from the USENET distribution. The data is the glyph tables of five of its
//! typefaces, converted by `tools/hershey-convert.mjs` to the compact text in `hershey/*.hf` (a `cap` line, then one line per ASCII
//! character: code, advance, strokes). The notice that must travel with it is `hershey/NOTICE-Hershey.txt`, which is also in
//! `third_party/fonts/` and in the app's licence list.
//!
//! Each table is parsed once, on first use, and scaled so a capital is 6 grid units tall (the unit `pen.rs` lays out in).

use std::sync::OnceLock;

type P = [f64; 2];
pub(super) type Strokes = &'static [&'static [P]];

/// One bundled typeface. The name, the line about it and the source file are for tests and tools; the UI has its own copy.
#[allow(dead_code)]
pub struct Font {
    /// The id a step names it by, without a version: `hershey-simplex`.
    pub id: &'static str,
    pub version: &'static str,
    /// The id with its version, as a step stores it.
    pub stored: &'static str,
    pub name: &'static str,
    pub about: &'static str,
    /// The Hershey file it was made from, for the notice.
    pub source: &'static str,
    data: &'static str,
    table: OnceLock<Vec<Option<Glyph>>>,
}

#[derive(Clone, Copy)]
struct Glyph {
    advance: f64,
    strokes: Strokes,
}

macro_rules! font {
    ($id:literal, $name:literal, $about:literal, $source:literal) => {
        Font {
            id: $id,
            version: "1",
            stored: concat!($id, "@1"),
            name: $name,
            about: $about,
            source: $source,
            data: include_str!(concat!("hershey/", $id, ".hf")),
            table: OnceLock::new(),
        }
    };
}

pub static FONTS: [Font; 5] = [
    font!("hershey-simplex", "Hershey Simplex", "Hershey's plain single-stroke sans: the lightest and most legible at small sizes. Letters, digits and ASCII marks.", "futural"),
    font!("hershey-duplex", "Hershey Duplex", "A sans drawn with two strokes where it matters, so it reads heavier and rounder than Simplex.", "futuram"),
    font!("hershey-complex", "Hershey Complex", "A single-stroke Roman with serifs and some thick-and-thin, for engraved labels.", "rowmand"),
    font!("hershey-script", "Hershey Script", "A slanted single-stroke script (Script Simplex), for names and signatures. Large letters only.", "scripts"),
    font!("hershey-gothic", "Hershey Gothic", "Gothic English: blackletter drawn with strokes, for a decorative inscription. Large letters only.", "gothiceng"),
];

/// The typeface `name` (with or without `@version`) names, or None.
pub fn find(name: &str) -> Option<&'static Font> {
    let id = name.split('@').next()?;
    FONTS.iter().find(|font| font.id == id)
}

impl Font {
    /// The advance (grid units) and strokes of `ch`, if the typeface has it.
    pub(super) fn glyph(&self, ch: char) -> Option<(f64, Strokes)> {
        let code = ch as u32;
        if !(32..=126).contains(&code) {
            return None;
        }
        let table = self.table.get_or_init(|| parse(self.data));
        table
            .get((code - 32) as usize)
            .copied()
            .flatten()
            .map(|g| (g.advance, g.strokes))
    }

    #[allow(dead_code)]
    /// How many strokes (pen-down runs) the letter has; None when the typeface lacks it.
    pub fn stroke_count(&self, ch: char) -> Option<usize> {
        self.glyph(ch).map(|(_, strokes)| strokes.len())
    }

    #[allow(dead_code)]
    /// How many characters the typeface has (space included).
    pub fn glyph_count(&self) -> usize {
        (32u8..=126)
            .filter(|c| self.glyph(*c as char).is_some())
            .count()
    }
}

/// The table of `data`, leaked once: a font lives as long as the process, like the static tables of the stroke font.
fn parse(data: &'static str) -> Vec<Option<Glyph>> {
    let mut lines = data.lines();
    let cap: f64 = lines
        .next()
        .and_then(|l| l.strip_prefix("cap "))
        .and_then(|n| n.trim().parse().ok())
        .filter(|c: &f64| *c > 0.0)
        .unwrap_or(21.0);
    let k = super::pen::CAP_UNITS / cap;
    let mut table: Vec<Option<Glyph>> = vec![None; 95];
    for line in lines {
        let mut words = line.split(' ');
        let (Some(code), Some(advance)) = (words.next(), words.next()) else {
            continue;
        };
        let (Ok(code), Ok(advance)) = (code.parse::<usize>(), advance.parse::<f64>()) else {
            continue;
        };
        if !(32..=126).contains(&code) {
            continue;
        }
        let mut strokes: Vec<&'static [P]> = Vec::new();
        let mut run: Vec<P> = Vec::new();
        for word in words {
            if word == ";" {
                if !run.is_empty() {
                    strokes.push(Box::leak(std::mem::take(&mut run).into_boxed_slice()));
                }
                continue;
            }
            if let Some((x, y)) = word.split_once(',') {
                if let (Ok(x), Ok(y)) = (x.parse::<f64>(), y.parse::<f64>()) {
                    run.push([x * k, y * k]);
                }
            }
        }
        if !run.is_empty() {
            strokes.push(Box::leak(run.into_boxed_slice()));
        }
        table[code - 32] = Some(Glyph {
            advance: advance * k,
            strokes: Box::leak(strokes.into_boxed_slice()),
        });
    }
    table
}
