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

| `hershey-simplex@1`, `hershey-duplex@1`, `hershey-complex@1`, `hershey-script@1`, `hershey-gothic@1` | Hershey Simplex, Duplex, Complex, Script (Simplex) and Gothic English: single-stroke letters, ASCII only | the USENET distribution of the Hershey Fonts as packed in kamalmostafa/hershey-fonts (`hershey-fonts/futural`, `futuram`, `rowmand`, `scripts`, `gothiceng` `.jhf`), converted by `tools/hershey-convert.mjs` to `crates/lime-model-occt/src/text/hershey/*.hf` and compiled into the engine; no file is served to the UI | `NOTICE-Hershey.txt` (the Hershey usage notice, verbatim, with its acknowledgements) |

The Hershey fonts were originally created by Dr. A. V. Hershey while working at the U. S. National Bureau of Standards. The format of the font data in the distribution was originally created by James Hurt, Cognition, Inc. They may be used for any purpose if these acknowledgements travel with the data and the data is not converted to the NTIS distribution format; it is converted here to a format of our own. The full notice is in `NOTICE-Hershey.txt`, and a copy sits beside the data in `crates/lime-model-occt/src/text/hershey/`.

A font is versioned and never replaced in place: a newer release of Inter is `sans@4.1`, so a project made with `sans@4.0` rebuilds from
the bytes it was made with.

`crates/lime-model-occt/tests/fonts/SourceCodePro-Regular.otf` (SIL Open Font License 1.1, `OFL-Source-Code-Pro.txt` beside it) is a
test fixture, never shipped: it is an OpenType font with cubic (CFF) outlines, for the tests that read one.

Reserved font names (Inter, Plex, Allerta, Source) are kept: no font here is renamed or modified.
