# Making the README's pictures and clips

The pictures and clips in `README.md` are made by `tools/readme-media`, so they can be made again when the window changes. Every picture shows only parts that ship in the repository (`samples/`) or that the scripts model themselves.

| File | Made by | What it shows |
| --- | --- | --- |
| `preview-3d.png`, `prepare.png`, `clip-slice.gif`, `layer-estimate.png`, `settings-search.png` | `slice.media.ts` | `samples/overhang_ledge.stl` on the Lime 220, PLA, speed strategy, supports turned on from the banner |
| `belt-preview.png`, `clip-belt.gif` | `belt.media.ts` | the same sample on the Ideaformer IR3 V2 belt, supports on |
| `clip-model.gif`, `model-history.png` | `model.media.ts` | a sketch extruded, a hole cut through it, the first step edited from History |
| `model-text.png` | `model.media.ts` | a cylinder with text wrapped round it, built by `mcp-media.ts` |
| `model-split.png` | `model.media.ts` | Split to print on a 320 mm bar |
| `clip-gear-train.gif` | `pose.media.ts` | three gears built by `mcp-media.ts`, coupled in Pose and turned |
| `clip-escapement.gif` | `mcp-media.ts` | a Graham escapement run by `motion_run` and drawn by the MCP server |
| `stress-cantilever.png` | `stress.media.ts` | the Stress worked example, with the engine's recorded reply (`e2e/fixtures/sim-cantilever.json`) |
| `ribs-buckling.png` | `ribs.media.ts` | a 64 × 40 × 14 mm box, shelled to a 2 mm wall with the top open, then Auto ribs on the inner floor at Resist buckling (the default 3×) with a force along the floor. The card shows "Buckles at N× the load (was M×)." and the ideal-load warning |
| `model-parts.png` | `parts.media.ts` | the Part card with its kind select open on Fasteners, Fittings, Brackets and Pulleys, and three parts the script built: a Nut M6, a GT2 pulley of 20 teeth and an L-bracket 40 × 30 × 3, M4 |
| `prepare-phone.png`, `preview-phone.png`, `model-phone.png` | `phone.media.ts` | the compact layout at 390 × 844 |

The other files in `docs/screenshots` belong to other documents (`docs/step-modeler.md`, the tutorials and the reviews).

## What it needs

- A built window: `npm run build`. The specs serve `dist/` with `vite preview`, so a run before the build shows the old code.
- A release engine with the Open CASCADE bridge, for Model and for real slices:

  ```bash
  LIME_OCCT_BRIDGE=/path/to/lime_model_occt.dll target/release/lime-slice serve --port 43218
  ```

  `LIME_MEDIA_API` points the window at another engine (default `http://127.0.0.1:43218`).
- For `mcp-media.ts`: the MCP engine library (`LIME_MCP_ENGINE`, for example `target/release/lime_mcp_engine.dll`) and `LIME_OCCT_BRIDGE`. It uses a fresh workspace and an empty plugin library of its own.
- `ffmpeg` and ImageMagick's `magick` on `PATH` (or `FFMPEG` and `MAGICK`): ffmpeg encodes the GIFs, ImageMagick compresses the PNGs to 256 colours.

## Run

From the repository root, the MCP part first, since the Pose and lettering pictures open the projects it writes to `artifacts/readme-media/`:

```bash
node --experimental-strip-types --no-warnings tools/readme-media/mcp-media.ts
npx playwright test -c tools/readme-media/playwright.config.ts
```

One spec at a time: `npx playwright test -c tools/readme-media/playwright.config.ts slice.media`. `LIME_PW_PORT` moves the preview server, and `LIME_MEDIA_OUT` writes into another folder, to compare before replacing. Headless Chromium only, one worker.

The files go straight into `docs/screenshots` (a Playwright run empties `test-results/`). Open every picture and look at a few frames of every clip before committing: no empty view, no half-loaded panel, no error toast. Keep each clip under about 1.5 MB.

## How the clips are made

A clip is a series of screenshots taken step by step, each shown for a number of frame times, then encoded by ffmpeg with one palette for the clip (`Clip` in `media.ts`). Taking the pictures step by step rather than in real time keeps a clip the same on a slow machine. The escapement clip is the GIF `motion_run` writes itself, cropped and re-encoded with fewer colours.
