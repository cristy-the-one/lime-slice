import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";

/** The engine the window talks to: `lime-slice serve --port 43218` with LIME_OCCT_BRIDGE set (docs/readme-media.md). */
export const ENGINE = process.env.LIME_MEDIA_API ?? "http://127.0.0.1:43218";
/** The repository root. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Where the README's pictures live. Pictures are written here directly: a Playwright run empties test-results/. */
export const OUT = resolve(process.env.LIME_MEDIA_OUT ?? join(ROOT, "docs/screenshots"));
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const MAGICK = process.env.MAGICK ?? "magick";

/** Open the app in the dark theme against the engine. `query` adds to the URL, for example `layout=compact`. */
export async function openApp(page: Page, query = "") {
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-theme", "dark");
    localStorage.setItem("lime-slice-settings-level", "expert");
  });
  await page.goto(`/?api=${encodeURIComponent(ENGINE)}${query ? `&${query}` : ""}`);
  await expect(page.locator("#tabPrepare")).toBeAttached();
  await page.waitForTimeout(500);
  // Tooltips follow the pointer and the keyboard focus; in a picture they only cover what it shows.
  await page.addStyleTag({ content: ".lime-tip { display: none !important; }" });
}

/** A sample from File > Samples, by its button name ("20 mm cube", "Overhang ledge", ...). */
export async function loadSample(page: Page, name: string) {
  await page.locator("#fileMenu > summary").click();
  const samples = page.locator("#samples");
  if (!(await samples.evaluate((el) => (el as HTMLDetailsElement).open))) await page.locator("#samples > summary").click();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
}

/** A file from the repository, opened through the window's file input. */
export async function openFile(page: Page, file: string) {
  await page.locator("#file").setInputFiles(resolve(ROOT, file));
}

/** Compress a PNG written by Playwright into OUT (256 colours keep the dark UI clean and the file small). */
function compressPng(from: string, name: string, colors = 256) {
  mkdirSync(OUT, { recursive: true });
  execFileSync(MAGICK, [from, "-strip", "-colors", String(colors), "-define", "png:compression-level=9", `PNG8:${join(OUT, name)}`]);
}

/** A still of the page (or of one element) into docs/screenshots. */
export async function still(page: Page, name: string, target?: Locator) {
  const dir = mkdtempSync(join(tmpdir(), "lime-media-"));
  const raw = join(dir, "raw.png");
  if (target) await target.screenshot({ path: raw });
  else await page.screenshot({ path: raw });
  compressPng(raw, name);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * A clip built from screenshots. `frame` takes one picture and shows it for `hold` frame times; the GIF plays at `fps`.
 * Taking pictures step by step, not in real time, keeps the clip even on a slow machine.
 */
export class Clip {
  private dir = mkdtempSync(join(tmpdir(), "lime-clip-"));
  private n = 0;
  constructor(private page: Page, private opts: { fps?: number; width?: number; colors?: number; clip?: { x: number; y: number; width: number; height: number } } = {}) {}

  async frame(hold = 1) {
    const first = join(this.dir, `${String(this.n).padStart(5, "0")}.png`);
    await this.page.screenshot({ path: first, clip: this.opts.clip });
    this.n += 1;
    for (let i = 1; i < hold; i += 1) copyFileSync(first, join(this.dir, `${String(this.n++).padStart(5, "0")}.png`));
  }

  /** Pictures while something moves on its own (an animation, a slice): one every `everyMs` for `ms`. */
  async record(ms: number, everyMs = 125) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = Date.now();
      await this.frame();
      const left = everyMs - (Date.now() - t);
      if (left > 0) await this.page.waitForTimeout(left);
    }
  }

  get frames() { return this.n; }

  /** Encode the GIF into docs/screenshots and return its size in bytes. */
  save(name: string) {
    const fps = this.opts.fps ?? 8, width = this.opts.width ?? 960, colors = this.opts.colors ?? 128;
    mkdirSync(OUT, { recursive: true });
    const out = join(OUT, name);
    const filter = `scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(this.dir, "%05d.png"), "-vf", filter, "-loop", "0", out]);
    const size = statSync(out).size;
    rmSync(this.dir, { recursive: true, force: true });
    return size;
  }

  discard() { rmSync(this.dir, { recursive: true, force: true }); }
}

/** Every file in OUT, for a size report. */
export function outSizes() {
  return readdirSync(OUT).filter((f) => /\.(png|gif)$/.test(f)).map((f) => ({ file: f, bytes: statSync(join(OUT, f)).size }));
}
