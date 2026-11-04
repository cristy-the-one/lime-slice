#![allow(dead_code)]
//! Test fonts built in code (debug and test builds only): a TrueType file with the glyphs, names, `OS/2` embedding bits and
//! variation axis a test asks for, so the reading, embedding and subsetting rules are tested on files that are ours to
//! commit (no font file of anyone's is copied). Letters are rectangles and rounded blobs: enough outline to measure.

/// One TrueType point: x, y and whether it lies on the curve (an off-curve point is a quadratic control point).
pub type Pt = (i16, i16, bool);

#[derive(Clone, Debug)]
pub struct Glyph {
    pub ch: char,
    pub advance: u16,
    pub contours: Vec<Vec<Pt>>,
    /// Point deltas at the weight axis's maximum, one per point, for a variable font. The four phantom points are added.
    pub heavy: Option<Vec<(i16, i16)>>,
}

#[derive(Clone, Debug)]
pub struct Synth {
    pub family: String,
    pub style: String,
    pub glyphs: Vec<Glyph>,
    pub fs_type: u16,
    pub bold: bool,
    pub italic: bool,
    /// False leaves out `glyf` and `loca`, as a bitmap-only font does.
    pub outlines: bool,
    /// The `wght` axis: minimum, default, maximum. Absent for a static font.
    pub weight_axis: Option<(f32, f32, f32)>,
    pub units_per_em: u16,
    pub cap_height: i16,
}

/// A box from (x0, y0) to (x1, y1), counter-clockwise (TrueType's outer loops run clockwise; the reader takes either).
pub fn rect(x0: i16, y0: i16, x1: i16, y1: i16) -> Vec<Pt> {
    vec![
        (x0, y0, true),
        (x1, y0, true),
        (x1, y1, true),
        (x0, y1, true),
    ]
}

/// A round blob of radius `r` about (cx, cy): four on-curve points and four off-curve corners, a rounded square.
pub fn blob(cx: i16, cy: i16, r: i16) -> Vec<Pt> {
    let k = (f32::from(r) * 0.41421357) as i16;
    let (x0, x1, y0, y1) = (cx - r, cx + r, cy - r, cy + r);
    vec![
        (cx + k, y0, false),
        (x1, y0, false),
        (x1, cy - k, false),
        (x1, cy + k, true),
        (x1, y1, false),
        (cx + k, y1, false),
        (cx - k, y1, true),
        (x0, y1, false),
        (x0, cy + k, false),
        (x0, cy - k, true),
        (x0, y0, false),
        (cx - k, y0, true),
    ]
}

impl Synth {
    /// A font of the letters H (a box), O (a ring: a box with a hole), I (a thin bar), - (a bar), and a space, with every
    /// field a test wants to change left to set.
    pub fn simple(family: &str) -> Synth {
        let glyphs = vec![
            Glyph {
                ch: ' ',
                advance: 500,
                contours: vec![],
                heavy: None,
            },
            Glyph {
                ch: 'H',
                advance: 1200,
                contours: vec![rect(100, 0, 1000, 1400)],
                heavy: Some(vec![(-40, -40), (40, -40), (40, 40), (-40, 40)]),
            },
            Glyph {
                ch: 'I',
                advance: 600,
                contours: vec![rect(200, 0, 400, 1400)],
                heavy: Some(vec![(-60, 0), (60, 0), (60, 0), (-60, 0)]),
            },
            Glyph {
                ch: 'O',
                advance: 1300,
                // Outer clockwise, inner counter-clockwise: a ring.
                contours: vec![
                    vec![
                        (100, 0, true),
                        (100, 1400, true),
                        (1100, 1400, true),
                        (1100, 0, true),
                    ],
                    vec![
                        (400, 400, true),
                        (800, 400, true),
                        (800, 1000, true),
                        (400, 1000, true),
                    ],
                ],
                heavy: None,
            },
            Glyph {
                ch: '-',
                advance: 700,
                contours: vec![rect(100, 500, 600, 700)],
                heavy: None,
            },
        ];
        Synth {
            family: family.into(),
            style: "Regular".into(),
            glyphs,
            fs_type: 0,
            bold: false,
            italic: false,
            outlines: true,
            weight_axis: None,
            units_per_em: 2000,
            cap_height: 1400,
        }
    }

    pub fn with_fs_type(mut self, fs_type: u16) -> Synth {
        self.fs_type = fs_type;
        self
    }

    pub fn without_outlines(mut self) -> Synth {
        self.outlines = false;
        self
    }

    pub fn bold(mut self) -> Synth {
        self.bold = true;
        self.style = "Bold".into();
        self
    }

    pub fn italic(mut self) -> Synth {
        self.italic = true;
        self.style = "Italic".into();
        self
    }

    /// A variable font with a `wght` axis from `min` to `max`, whose default is `min`.
    pub fn variable(mut self, min: f32, max: f32) -> Synth {
        self.weight_axis = Some((min, min, max));
        self
    }

    pub fn glyph(mut self, glyph: Glyph) -> Synth {
        self.glyphs.retain(|g| g.ch != glyph.ch);
        self.glyphs.push(glyph);
        self
    }

    /// The font file's bytes.
    pub fn bytes(&self) -> Vec<u8> {
        self.sfnt(0)
    }

    /// A collection of these fonts: `.ttc` bytes.
    pub fn collection(fonts: &[Synth]) -> Vec<u8> {
        let header = 12 + 4 * fonts.len();
        let mut bodies: Vec<Vec<u8>> = Vec::new();
        let mut offsets = Vec::new();
        let mut at = header;
        for font in fonts {
            let body = font.sfnt(at);
            offsets.push(at as u32);
            at += body.len();
            bodies.push(body);
        }
        let mut out = b"ttcf".to_vec();
        out.extend(0x0001_0000u32.to_be_bytes());
        out.extend((fonts.len() as u32).to_be_bytes());
        for offset in offsets {
            out.extend(offset.to_be_bytes());
        }
        for body in bodies {
            out.extend(body);
        }
        out
    }

    fn ordered(&self) -> Vec<&Glyph> {
        // Glyph 0 is .notdef (empty); the rest by character.
        let mut chars: Vec<&Glyph> = self.glyphs.iter().collect();
        chars.sort_by_key(|g| g.ch);
        chars
    }

    fn sfnt(&self, base: usize) -> Vec<u8> {
        let glyphs = self.ordered();
        let n = glyphs.len() + 1;
        let mut tables: Vec<([u8; 4], Vec<u8>)> = Vec::new();

        // head
        let mut head = Vec::new();
        head.extend(0x0001_0000u32.to_be_bytes());
        head.extend(0u32.to_be_bytes());
        head.extend(0u32.to_be_bytes());
        head.extend(0x5F0F_3CF5u32.to_be_bytes());
        head.extend(0u16.to_be_bytes());
        head.extend(self.units_per_em.to_be_bytes());
        head.extend([0u8; 16]);
        for v in [0i16, -400, 2000, self.cap_height] {
            head.extend(v.to_be_bytes());
        }
        let mac = u16::from(self.bold) | (u16::from(self.italic) << 1);
        head.extend(mac.to_be_bytes());
        head.extend(8u16.to_be_bytes());
        head.extend(2i16.to_be_bytes());
        head.extend(1i16.to_be_bytes()); // long loca
        head.extend(0i16.to_be_bytes());
        tables.push((*b"head", head));

        // hhea
        let mut hhea = Vec::new();
        hhea.extend(0x0001_0000u32.to_be_bytes());
        for v in [1600i16, -400, 0] {
            hhea.extend(v.to_be_bytes());
        }
        hhea.extend(2000u16.to_be_bytes());
        for v in [0i16, 0, 2000, 1, 0, 0] {
            hhea.extend(v.to_be_bytes());
        }
        hhea.extend([0u8; 8]);
        hhea.extend(0i16.to_be_bytes());
        hhea.extend((n as u16).to_be_bytes());
        tables.push((*b"hhea", hhea));

        // maxp 1.0
        let mut maxp = Vec::new();
        maxp.extend(0x0001_0000u32.to_be_bytes());
        maxp.extend((n as u16).to_be_bytes());
        for v in [64u16, 8, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0] {
            maxp.extend(v.to_be_bytes());
        }
        tables.push((*b"maxp", maxp));

        // hmtx
        let mut hmtx = Vec::new();
        hmtx.extend([0u8; 4]);
        for g in &glyphs {
            hmtx.extend(g.advance.to_be_bytes());
            hmtx.extend(0i16.to_be_bytes());
        }
        tables.push((*b"hmtx", hmtx));

        // cmap: one format 4 subtable, a segment per character.
        let segs = glyphs.len() + 1;
        let mut sub = Vec::new();
        sub.extend(4u16.to_be_bytes());
        sub.extend((16 + segs as u16 * 8).to_be_bytes());
        sub.extend(0u16.to_be_bytes());
        sub.extend((segs as u16 * 2).to_be_bytes());
        sub.extend([0u8; 6]);
        for g in &glyphs {
            sub.extend((g.ch as u16).to_be_bytes());
        }
        sub.extend(0xFFFFu16.to_be_bytes());
        sub.extend(0u16.to_be_bytes());
        for g in &glyphs {
            sub.extend((g.ch as u16).to_be_bytes());
        }
        sub.extend(0xFFFFu16.to_be_bytes());
        for (i, g) in glyphs.iter().enumerate() {
            sub.extend(
                ((i as i32 + 1) - g.ch as i32)
                    .rem_euclid(65536)
                    .to_be_bytes()[2..]
                    .to_vec(),
            );
        }
        sub.extend(1u16.to_be_bytes());
        for _ in 0..segs {
            sub.extend(0u16.to_be_bytes());
        }
        let mut cmap = Vec::new();
        cmap.extend(0u16.to_be_bytes());
        cmap.extend(1u16.to_be_bytes());
        cmap.extend(3u16.to_be_bytes());
        cmap.extend(1u16.to_be_bytes());
        cmap.extend(12u32.to_be_bytes());
        cmap.extend(sub);
        tables.push((*b"cmap", cmap));

        // name: family (1), subfamily (2), full name (4), postscript (6), as UTF-16.
        let full = format!("{} {}", self.family, self.style);
        let strings = [
            (1u16, self.family.clone()),
            (2, self.style.clone()),
            (4, full.clone()),
            (6, full.replace(' ', "-")),
        ];
        let mut name = Vec::new();
        name.extend(0u16.to_be_bytes());
        name.extend((strings.len() as u16).to_be_bytes());
        name.extend((6 + 12 * strings.len() as u16).to_be_bytes());
        let mut text = Vec::new();
        for (id, s) in &strings {
            let utf16: Vec<u8> = s.encode_utf16().flat_map(u16::to_be_bytes).collect();
            for v in [3u16, 1, 0x409, *id, utf16.len() as u16, text.len() as u16] {
                name.extend(v.to_be_bytes());
            }
            text.extend(utf16);
        }
        name.extend(text);
        tables.push((*b"name", name));

        // OS/2 version 2.
        let mut os2 = Vec::new();
        os2.extend(2u16.to_be_bytes());
        os2.extend(900i16.to_be_bytes());
        let weight_class: u16 = if self.bold { 700 } else { 400 };
        os2.extend(weight_class.to_be_bytes());
        os2.extend(5u16.to_be_bytes());
        os2.extend(self.fs_type.to_be_bytes());
        for _ in 0..10 {
            os2.extend(0i16.to_be_bytes());
        }
        os2.extend(0i16.to_be_bytes());
        os2.extend([0u8; 10]);
        os2.extend([0u8; 16]);
        os2.extend(*b"TEST");
        let selection: u16 = (u16::from(self.italic))
            | (u16::from(self.bold) << 5)
            | (u16::from(!self.bold && !self.italic) << 6);
        os2.extend(selection.to_be_bytes());
        os2.extend(0x20u16.to_be_bytes());
        os2.extend(0xFFFFu16.to_be_bytes());
        for v in [1600i16, -400, 0] {
            os2.extend(v.to_be_bytes());
        }
        os2.extend(1600u16.to_be_bytes());
        os2.extend(400u16.to_be_bytes());
        os2.extend([0u8; 8]);
        os2.extend(700i16.to_be_bytes());
        os2.extend(self.cap_height.to_be_bytes());
        os2.extend(0u16.to_be_bytes());
        os2.extend(0x20u16.to_be_bytes());
        os2.extend(0u16.to_be_bytes());
        tables.push((*b"OS/2", os2));

        if self.outlines {
            let mut glyf = Vec::new();
            let mut loca: Vec<u32> = vec![0];
            // .notdef
            loca.push(0);
            for g in &glyphs {
                if !g.contours.is_empty() {
                    glyf.extend(glyph_data(g));
                    while glyf.len() % 4 != 0 {
                        glyf.push(0);
                    }
                }
                loca.push(glyf.len() as u32);
            }
            let mut loca_bytes = Vec::new();
            for v in &loca {
                loca_bytes.extend(v.to_be_bytes());
            }
            tables.push((*b"glyf", glyf));
            tables.push((*b"loca", loca_bytes));
        }

        if let Some((min, def, max)) = self.weight_axis {
            let fixed = |v: f32| ((v * 65536.0).round() as i32).to_be_bytes();
            let mut fvar = Vec::new();
            fvar.extend(1u16.to_be_bytes());
            fvar.extend(0u16.to_be_bytes());
            fvar.extend(16u16.to_be_bytes());
            fvar.extend(2u16.to_be_bytes());
            fvar.extend(1u16.to_be_bytes());
            fvar.extend(20u16.to_be_bytes());
            fvar.extend(0u16.to_be_bytes());
            fvar.extend(8u16.to_be_bytes());
            fvar.extend(*b"wght");
            fvar.extend(fixed(min));
            fvar.extend(fixed(def));
            fvar.extend(fixed(max));
            fvar.extend(0u16.to_be_bytes());
            fvar.extend(256u16.to_be_bytes());
            tables.push((*b"fvar", fvar));
            if self.outlines {
                tables.push((*b"gvar", self.gvar(&glyphs)));
            }
        }

        tables.sort_by_key(|(tag, _)| *tag);
        let count = tables.len();
        let mut out = Vec::new();
        out.extend(0x0001_0000u32.to_be_bytes());
        out.extend((count as u16).to_be_bytes());
        out.extend([0u8; 6]);
        let mut at = base + 12 + 16 * count;
        let mut data = Vec::new();
        for (tag, bytes) in &tables {
            out.extend(tag);
            out.extend(0u32.to_be_bytes());
            out.extend((at as u32).to_be_bytes());
            out.extend((bytes.len() as u32).to_be_bytes());
            data.extend(bytes);
            while data.len() % 4 != 0 {
                data.push(0);
            }
            at = base + 12 + 16 * count + data.len();
        }
        out.extend(data);
        out
    }

    fn gvar(&self, glyphs: &[&Glyph]) -> Vec<u8> {
        // One tuple per varying glyph, peak at the axis maximum (1.0), private points = all points.
        let mut blocks: Vec<Vec<u8>> = vec![Vec::new()];
        for g in glyphs {
            let mut block = Vec::new();
            if let Some(deltas) = &g.heavy {
                let points: usize = g.contours.iter().map(Vec::len).sum();
                let mut all: Vec<(i16, i16)> = deltas.clone();
                // A glyph with fewer deltas than points repeats its last one; four phantom points follow.
                while all.len() < points {
                    all.push(*deltas.last().unwrap_or(&(0, 0)));
                }
                all.truncate(points);
                all.extend([(0, 0); 4]);
                let mut data = vec![0u8]; // point count 0: all points
                for axis in 0..2 {
                    for chunk in all.chunks(64) {
                        data.push(0x40 | (chunk.len() as u8 - 1));
                        for d in chunk {
                            let v = if axis == 0 { d.0 } else { d.1 };
                            data.extend(v.to_be_bytes());
                        }
                    }
                }
                block.extend(1u16.to_be_bytes());
                block.extend((4u16 + 4 + 2).to_be_bytes());
                block.extend((data.len() as u16).to_be_bytes());
                block.extend((0x8000u16 | 0x2000).to_be_bytes());
                block.extend(0x4000u16.to_be_bytes());
                block.extend(data);
                if block.len() % 2 != 0 {
                    block.push(0);
                }
            }
            blocks.push(block);
        }
        let n = blocks.len();
        let array_at = 20 + 2 * (n + 1);
        let mut out = Vec::new();
        out.extend(1u16.to_be_bytes());
        out.extend(0u16.to_be_bytes());
        out.extend(1u16.to_be_bytes());
        out.extend(0u16.to_be_bytes());
        out.extend((20u32).to_be_bytes());
        out.extend((n as u16).to_be_bytes());
        out.extend(0u16.to_be_bytes());
        out.extend((array_at as u32).to_be_bytes());
        let mut offset = 0usize;
        out.extend(0u16.to_be_bytes());
        for block in &blocks {
            offset += block.len();
            out.extend(((offset / 2) as u16).to_be_bytes());
        }
        for block in blocks {
            out.extend(block);
        }
        out
    }
}

fn glyph_data(g: &Glyph) -> Vec<u8> {
    let points: Vec<&Pt> = g.contours.iter().flatten().collect();
    let (mut x0, mut y0, mut x1, mut y1) = (i16::MAX, i16::MAX, i16::MIN, i16::MIN);
    for p in &points {
        x0 = x0.min(p.0);
        y0 = y0.min(p.1);
        x1 = x1.max(p.0);
        y1 = y1.max(p.1);
    }
    let mut out = Vec::new();
    out.extend((g.contours.len() as i16).to_be_bytes());
    for v in [x0, y0, x1, y1] {
        out.extend(v.to_be_bytes());
    }
    let mut end = 0u16;
    for c in &g.contours {
        end += c.len() as u16;
        out.extend((end - 1).to_be_bytes());
    }
    out.extend(0u16.to_be_bytes());
    for p in &points {
        out.push(u8::from(p.2));
    }
    let mut last = 0i16;
    for p in &points {
        out.extend((p.0 - last).to_be_bytes());
        last = p.0;
    }
    last = 0;
    for p in &points {
        out.extend((p.1 - last).to_be_bytes());
        last = p.1;
    }
    out
}
