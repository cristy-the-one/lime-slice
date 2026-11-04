# Fonts that ship with Lime Slice

These fonts are the ones the Model tab's Text tool builds letters from (`docs/plan-text-on-curves-and-fonts.md`, decision D2). Every
file is used unmodified, as a static TrueType file, and is distributed under the SIL Open Font License, Version 1.1. The licence texts
are in this folder; the same files are served to the app's font picker from `public/fonts/model/` and compiled into the modelling
engine (`crates/lime-model-occt/src/text/fonts.rs`).

| Id | Font | Files | Source | Licence text |
|---|---|---|---|---|
| `sans@4.0` | Inter 4.0 | Regular, Bold, Italic, Bold Italic | rsms/inter release v4.0 (`extras/ttf`) | `OFL-Inter.txt` |
| `mono@1` | IBM Plex Mono 2.5 | Regular, Bold | `@ibm/plex-mono` 2.5.0 (WOFF files repacked as sfnt, glyph data unchanged) | `OFL-IBM-Plex.txt` |
| `serif@1` | IBM Plex Serif 2.0 | Regular, Bold | `@ibm/plex-serif` 2.0.0 (WOFF files repacked as sfnt, glyph data unchanged) | `OFL-IBM-Plex.txt` |
| `stencil@1` | Allerta Stencil | Regular | google/fonts `ofl/allertastencil` | `OFL-Allerta-Stencil.txt` |

A font is versioned and never replaced in place: a newer release of Inter is `sans@4.1`, so a project made with `sans@4.0` rebuilds from
the bytes it was made with.

`crates/lime-model-occt/tests/fonts/SourceCodePro-Regular.otf` (SIL Open Font License 1.1, `OFL-Source-Code-Pro.txt` beside it) is a
test fixture, never shipped: it is an OpenType font with cubic (CFF) outlines, for the tests that read one.

Reserved font names (Inter, Plex, Allerta, Source) are kept: no font here is renamed or modified.
