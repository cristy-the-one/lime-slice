//! The fonts that ship with the app (docs/plan-text-on-curves-and-fonts.md D2), by id.
//!
//! Every file is compiled in, so the engine, the MCP server and the desktop app all read the same bytes with no path to
//! find. The files are versioned and never replaced in place: a new release of a font is a new id (`sans@4.1`), so a
//! project made with `sans@4.0` rebuilds from the bytes it was made with. The licence texts are in
//! `third_party/fonts/`; the same files are served to the UI from `public/fonts/model/`.

/// One style of a family: a static TrueType file.
#[derive(Debug)]
pub struct StyleFile {
    pub bold: bool,
    pub italic: bool,
    pub bytes: &'static [u8],
}

/// A bundled family.
#[derive(Debug)]
pub struct Family {
    /// The id a step names it by, without a version (`sans`).
    pub id: &'static str,
    /// The version of the files: `sans@4.0`.
    pub version: &'static str,
    /// What the picker shows.
    pub name: &'static str,
    /// A line for the picker and the guide.
    pub about: &'static str,
    pub styles: &'static [StyleFile],
}

macro_rules! file {
    ($name:literal) => {
        include_bytes!(concat!("../../../../public/fonts/model/", $name))
    };
}

pub static FAMILIES: &[Family] = &[
    Family {
        id: "sans",
        version: "4.0",
        name: "Inter",
        about: "A clear sans with even strokes. It prints small. The default.",
        styles: &[
            StyleFile { bold: false, italic: false, bytes: file!("Inter-Regular.ttf") },
            StyleFile { bold: true, italic: false, bytes: file!("Inter-Bold.ttf") },
            StyleFile { bold: false, italic: true, bytes: file!("Inter-Italic.ttf") },
            StyleFile { bold: true, italic: true, bytes: file!("Inter-BoldItalic.ttf") },
        ],
    },
    Family {
        id: "mono",
        version: "1",
        name: "IBM Plex Mono",
        about: "Every letter the same width: serial numbers, codes and labels that line up.",
        styles: &[
            StyleFile { bold: false, italic: false, bytes: file!("IBMPlexMono-Regular.ttf") },
            StyleFile { bold: true, italic: false, bytes: file!("IBMPlexMono-Bold.ttf") },
        ],
    },
    Family {
        id: "serif",
        version: "1",
        name: "IBM Plex Serif",
        about: "A serif with sturdy strokes. Still, thin ones show a warning at small sizes.",
        styles: &[
            StyleFile { bold: false, italic: false, bytes: file!("IBMPlexSerif-Regular.ttf") },
            StyleFile { bold: true, italic: false, bytes: file!("IBMPlexSerif-Bold.ttf") },
        ],
    },
    Family {
        id: "stencil",
        version: "1",
        name: "Allerta Stencil",
        about: "Letters with bridges, for text cut through a wall without losing the middle of O, A and 8. Regular only.",
        styles: &[StyleFile { bold: false, italic: false, bytes: file!("AllertaStencil-Regular.ttf") }],
    },
];

/// A CFF (OpenType, cubic) font for the tests, in debug builds only: no shipped build knows it. Source Code Pro, OFL 1.1
/// (tests/fonts/OFL-Source-Code-Pro.txt).
#[cfg(lime_occt_test_hooks)]
static TEST_CFF: Family = Family {
    id: "test-cff",
    version: "1",
    name: "Source Code Pro",
    about: "A test font.",
    styles: &[StyleFile {
        bold: false,
        italic: false,
        bytes: include_bytes!("../../tests/fonts/SourceCodePro-Regular.otf"),
    }],
};

/// The family `id` names, with or without its version (`sans`, `sans@4.0`), or a sentence.
pub fn family(id: &str) -> Result<&'static Family, String> {
    #[cfg(lime_occt_test_hooks)]
    if id.split('@').next() == Some("test-cff") {
        return Ok(&TEST_CFF);
    }
    let (name, version) = match id.split_once('@') {
        Some((name, version)) => (name, Some(version)),
        None => (id, None),
    };
    let found = FAMILIES.iter().find(|family| family.id == name);
    match (found, version) {
        (Some(family), None) => Ok(family),
        (Some(family), Some(version)) if family.version == version => Ok(family),
        (Some(family), Some(version)) => Err(format!(
            "This build has {}@{}, not {name}@{version}. Pick the font again.",
            family.id, family.version
        )),
        (None, _) => Err(format!(
            "There is no font called ‘{id}’. The fonts are {}.",
            FAMILIES
                .iter()
                .map(|family| family.id)
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// The id with its version, as a step stores it.
pub fn versioned(family: &Family) -> String {
    format!("{}@{}", family.id, family.version)
}

/// The file for a style and whether the outline must be slanted to make it, or a sentence. A family without an italic gets
/// a slant; one without a bold is refused for bold (D7).
pub fn style_file(
    family: &Family,
    bold: bool,
    italic: bool,
) -> Result<(&'static StyleFile, bool), String> {
    if let Some(exact) = family
        .styles
        .iter()
        .find(|file| file.bold == bold && file.italic == italic)
    {
        return Ok((exact, false));
    }
    if bold && !family.styles.iter().any(|file| file.bold) {
        return Err(format!(
            "‘{}’ has no bold. Pick Regular, or another font.",
            family.name
        ));
    }
    // No italic: the upright file of the same weight, slanted.
    match family
        .styles
        .iter()
        .find(|file| file.bold == bold && !file.italic)
    {
        Some(upright) => Ok((upright, italic)),
        None => Err(format!(
            "‘{}’ has no {}. Pick another style.",
            family.name,
            if bold { "bold" } else { "regular" }
        )),
    }
}

/// The slant of a made italic, degrees.
pub const SLANT_DEG: f64 = 12.0;

/// bold and italic from a style word: `regular`, `bold`, `italic`, `bold-italic`.
pub fn style_flags(style: Option<&str>) -> Result<(bool, bool), String> {
    match style.unwrap_or("regular") {
        "regular" | "" => Ok((false, false)),
        "bold" => Ok((true, false)),
        "italic" => Ok((false, true)),
        "bold-italic" | "bolditalic" => Ok((true, true)),
        other => Err(format!(
            "The style is regular, bold, italic or bold-italic, not ‘{other}’."
        )),
    }
}
