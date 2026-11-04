import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";

// Text milestone 4 (docs/plan-text-on-curves-and-fonts.md): the person's own fonts on the Text card. Add font file…, the name drawn in
// the font itself, the font library that lists them for every project, removing one, a weight for a variable font, a collection's
// faces, the licence sentence for a font that forbids embedding, and the project that keeps the font (or only its letters) and gives
// it back to the engine when it opens. The engine is mocked; its side is crates/lime-model-occt/tests/lettering.rs and
// mcp/text-user-fonts.test.ts. The font files are the app's own bundled fonts (SIL OFL 1.1), with a marker on the end that the
// mock engine reads in place of a font reader, so no font of anyone's is in the repository.

type V = [number, number, number];

const fonts = fileURLToPath(new URL("../public/fonts/model/", import.meta.url));
const plex = fs.readFileSync(path.join(fonts, "IBMPlexMono-Regular.ttf"));
const inter = fs.readFileSync(path.join(fonts, "Inter-Bold.ttf"));
const marked = (bytes: Buffer, marker: string) => Buffer.concat([bytes, Buffer.from(marker, "latin1")]);
const PLAIN = marked(plex, "PLAIN....");
const RESTRICTED = marked(plex, "RESTRICTED");
const VARIABLE = marked(inter, "VARIABLE..");
const COLLECTION = marked(plex, "COLLECTION");

const shots = "test-results/text-user-fonts";

function boxSolid(volumeMm3 = 4000): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 20, y * 20, z * 10];
  const quads: V[][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  quads.forEach((q, face) => {
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      for (const i of tri) positions.push(...q[i]!);
      triangles.push(face);
    }
  });
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 400 })), edges: [] };
}

function layoutOf(request: Body): Body {
  const letters = [...String(request.text ?? "")].filter((ch) => ch.trim());
  return {
    ok: true,
    font: request.font,
    faces: letters.map((ch, index) => ({ ch, loops: [[[index * 6, 0], [index * 6 + 5, 0], [index * 6 + 5, 5], [index * 6, 5]]], thin: false })),
    widths: [letters.length * 6],
    bounds: [0, 0, letters.length * 6, 5],
    inkMm2: letters.length * 25,
    thin: [],
    thinNote: null,
  };
}

/** What the mock engine says of a font file: by the marker on its end. A pack is the JSON the mock's own pack call made. */
function fontAdd(request: Body): Body {
  const bytes = Buffer.from(String(request.dataB64), "base64");
  if (bytes[0] === 0x7b) {
    const pack = JSON.parse(bytes.toString("utf8")) as { id: string; sha256: string; name: string; family: string; letters: string };
    return { ok: true, id: pack.id, sha256: pack.sha256, name: pack.name, family: pack.family, style: "Regular", bold: false, italic: false, weight: null, restricted: true, pack: true, letters: pack.letters };
  }
  const marker = bytes.subarray(bytes.length - 10).toString("latin1");
  if (marker === "BROKEN....") return { error: "This file is not a font Lime Slice can read. Use a TrueType (.ttf) or OpenType (.otf) file." };
  const sha = createHash("sha256").update(bytes).digest("hex");
  const face = Number(request.face ?? 0);
  const id = `user:${sha.slice(0, 16)}${face > 0 ? `.${face}` : ""}`;
  const family = marker === "RESTRICTED" ? "Closed Mono" : marker === "VARIABLE.." ? "Flex Sans" : marker === "COLLECTION" ? "Family Pack" : "Plex Test Mono";
  const name = marker === "COLLECTION" ? (face === 1 ? "Family Pack Bold" : "Family Pack Regular") : `${family} Regular`;
  return {
    ok: true,
    id,
    sha256: sha,
    name,
    family,
    style: "Regular",
    bold: marker === "COLLECTION" && face === 1,
    italic: false,
    weight: marker === "VARIABLE.." ? { min: 300, default: 400, max: 800 } : null,
    restricted: marker === "RESTRICTED",
    ...(marker === "COLLECTION" && face === 0 && request.face === undefined ? { faces: [{ index: 0, name: "Family Pack Regular" }, { index: 1, name: "Family Pack Bold" }] } : {}),
  };
}

function fontPack(request: Body): Body {
  const letters = [...new Set((request.uses as { text: string }[]).flatMap((use) => [...use.text]).filter((ch) => ch.trim()))].sort().join("");
  const id = String(request.id);
  const pack = { id, sha256: (id.slice(5) + "0".repeat(64)).slice(0, 64), name: "Closed Mono Regular", family: "Closed Mono", letters };
  return { ok: true, id, dataB64: Buffer.from(JSON.stringify(pack)).toString("base64"), letters };
}

async function loadPlate(page: Page) {
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
}

async function openModel(page: Page): Promise<TreeMock> {
  const root = boxSolid();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  // The font library the desktop shell keeps, as a page test sees it: in this page's local storage, so a reload still has it.
  await page.addInitScript(() => {
    const key = "test-font-library";
    const read = (): { name: string; dataB64: string }[] => JSON.parse(localStorage.getItem(key) ?? "[]");
    (window as unknown as { __limeFontLibrary: unknown }).__limeFontLibrary = {
      invoke: async (command: string, args: { name?: string; dataB64?: string } = {}) => {
        const files = read();
        if (command === "font_library_list") return { dir: "~/.lime-slice/fonts", files };
        if (command === "font_library_add") {
          localStorage.setItem(key, JSON.stringify([...files.filter((file) => file.name !== args.name), { name: args.name, dataB64: args.dataB64 }]));
          return null;
        }
        if (command === "font_library_remove") {
          localStorage.setItem(key, JSON.stringify(files.filter((file) => file.name !== args.name)));
          return files.some((file) => file.name === args.name);
        }
        throw new Error(`no ${command}`);
      },
    };
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => root,
    apply: (_request: Body, parent: MockSolid) => boxSolid(parent.volumeMm3 + 12),
    probe: () => ({ ok: true }),
    textLayout: layoutOf,
    textFontAdd: fontAdd,
    textFontPack: fontPack,
  });
  await loadPlate(page);
  return tree;
}

async function pickFace(page: Page) {
  const [x, y, w, h] = ((await page.locator("#model").getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.click(box.x + x! + w! * 0.5, box.y + y! + h! * 0.5);
}

async function openText(page: Page) {
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelFeatureMenu [data-tool=text]").click();
  await expect(page.locator("#modelToolFeatures")).toHaveAttribute("data-tool", "text");
  await pickFace(page);
  await expect(page.locator("#modelApply")).toBeEnabled();
}

async function typeText(page: Page, text: string) {
  await page.locator("#modelFeatText").fill(text);
  await page.locator("#modelFeatText").dispatchEvent("input");
}

async function addFont(page: Page, name: string, buffer: Buffer) {
  await page.locator("#modelTextFontFile").setInputFiles({ name, mimeType: "font/ttf", buffer });
}

const userFonts = (page: Page) => page.locator("#modelTextUserFonts [data-font]");
const libraryFiles = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem("test-font-library") ?? "[]") as { name: string }[]).map((file) => file.name));

test("Add font file… lists the font by name drawn in itself, chooses it, and builds a step that names it", async ({ page }) => {
  const tree = await openModel(page);
  await openText(page);
  await expect(page.locator("#modelTextAddFont")).toHaveText("Add font file…");
  await addFont(page, "plex-test.ttf", PLAIN);
  await expect(userFonts(page)).toHaveCount(1);
  const font = userFonts(page).first();
  await expect(font).toHaveText("Plex Test Mono Regular");
  await expect(font).toHaveAttribute("aria-pressed", "true");
  const id = (await font.getAttribute("data-font"))!;
  expect(id).toMatch(/^user:[0-9a-f]{16}$/);
  // The name is drawn in the font itself: a face the page loaded from the file's own bytes.
  await expect.poll(() => font.evaluate((node) => getComputedStyle(node).fontFamily)).toContain("Lime User");
  const family = (await font.evaluate((node) => getComputedStyle(node).fontFamily)).replace(/["']/g, "").split(",")[0]!.trim();
  expect(await page.evaluate((name) => document.fonts.check(`16px "${name}"`), family)).toBe(true);
  expect(await page.evaluate((name) => [...document.fonts].some((face) => face.family.replace(/["']/g, "") === name && face.status === "loaded"), family)).toBe(true);
  // It has no bold of its own: the Bold the card started in goes back to Regular, and says why on the greyed button.
  await expect(page.locator("#modelTextStyle [data-style=regular]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelTextStyle [data-style=bold]")).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#modelTextStyle [data-style=bold]")).toHaveAttribute("data-tip", "Plex Test Mono Regular has no bold. Pick Regular, or another font.");
  await expect(page.locator("#modelTextStyle [data-style=italic]")).toHaveAttribute("data-tip", /slanted 12°/);
  // The sample line is drawn in it. A font that may be embedded has no licence sentence.
  await typeText(page, "LOT 42");
  expect(await page.locator("#modelTextSample").evaluate((node) => getComputedStyle(node).fontFamily)).toContain("Lime User");
  await expect(page.locator("#modelTextLicence")).toBeHidden();
  await expect(page.locator("#modelTextWeight")).toBeHidden();
  // The live preview asks the engine with its id.
  await expect.poll(() => tree.of("textLayout").at(-1)?.font).toBe(id);
  await page.screenshot({ path: `${shots}/card-added-font.png` });
  // Apply: one lettering step that names the font by id.
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelHistoryTree [role=treeitem]")).toHaveCount(2);
  const op = tree.of("apply").at(-1)!.op as { steps: Body[]; source: Body };
  expect(op.steps).toHaveLength(1);
  expect(op.steps[0]).toMatchObject({ kind: "lettering", text: "LOT 42", font: id });
  expect(op.steps[0]!.style, "regular is not written").toBeUndefined();
  expect(op.source).toMatchObject({ kind: "text", font: id });
  // Edit reopens the card on the same font.
  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelApply")).toHaveText("Update");
  await expect(userFonts(page).first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelFeatText")).toHaveValue("LOT 42");
  // Saved, the project holds the font file itself, byte for byte, under its SHA-256: it may be embedded. Nothing is packed.
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse(fs.readFileSync((await download.path())!).toString("utf8")) as { fonts?: Record<string, { name: string; encoding: string; data: string }> };
  expect(Object.keys(doc.fonts ?? {})).toEqual([createHash("sha256").update(PLAIN).digest("hex")]);
  const record = Object.values(doc.fonts!)[0]!;
  expect(record.encoding).toBe("gzip+base64");
  expect(zlib.gunzipSync(Buffer.from(record.data, "base64")).equals(PLAIN), "the file as it was").toBe(true);
  expect(tree.of("textFontPack"), "a font that may be embedded is not packed").toHaveLength(0);
});

test("a font stays listed for the next project and can be removed", async ({ page }) => {
  const tree = await openModel(page);
  await openText(page);
  await addFont(page, "plex-test.ttf", PLAIN);
  await expect(userFonts(page)).toHaveCount(1);
  const files = await libraryFiles(page);
  expect(files, "a copy goes to the person's font library").toHaveLength(1);
  expect(files[0]).toMatch(/^[0-9a-f]{16}-Plex-Test-Mono\.ttf$/);
  // A new page load, a new project: the font is in the picker without adding it again.
  await page.reload();
  await loadPlate(page);
  await openText(page);
  await expect(userFonts(page)).toHaveCount(1);
  await expect(userFonts(page).first()).toHaveText("Plex Test Mono Regular");
  expect(tree.of("textFontAdd").length, "the library's file is given to the engine").toBeGreaterThanOrEqual(2);
  // × takes it out of the picker and the library.
  await page.locator("#modelTextUserFonts [data-remove-font]").first().click();
  await expect(userFonts(page)).toHaveCount(0);
  expect(await libraryFiles(page)).toEqual([]);
  await expect(page.locator("#modelTextFont [data-font='sans@4.0']")).toHaveAttribute("aria-pressed", "true");
  // A font a step of the project uses stays in the project when it leaves the library.
  await addFont(page, "plex-test.ttf", PLAIN);
  await typeText(page, "KEEP");
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelHistoryTree [role=treeitem]")).toHaveCount(2);
  await page.keyboard.press("Shift+E");
  await page.locator("#modelTextUserFonts [data-remove-font]").first().click();
  await expect(page.getByText("is still used by this project, so it stays in the project.")).toBeVisible();
  expect(await libraryFiles(page)).toEqual([]);
  await expect(userFonts(page)).toHaveCount(1);
});

test("a file that is not a font is refused in one sentence, and a collection asks which font", async ({ page }) => {
  const tree = await openModel(page);
  await openText(page);
  await addFont(page, "broken.ttf", marked(plex, "BROKEN...."));
  await expect(page.getByText("This file is not a font Lime Slice can read. Use a TrueType (.ttf) or OpenType (.otf) file.")).toBeVisible();
  await expect(userFonts(page)).toHaveCount(0);
  expect(await libraryFiles(page), "nothing is kept").toEqual([]);
  await addFont(page, "family.ttc", COLLECTION);
  const faces = page.locator("#modelTextFace");
  await expect(faces).toBeVisible();
  await expect(faces.locator("option")).toHaveText(["Which font of this file?", "Family Pack Regular", "Family Pack Bold"]);
  await expect(userFonts(page)).toHaveCount(0);
  await faces.selectOption("1");
  await expect(userFonts(page)).toHaveCount(1);
  await expect(userFonts(page).first()).toHaveText("Family Pack Bold");
  await expect(faces).toBeHidden();
  expect(tree.of("textFontAdd").some((call) => call.face === 1), "the engine is told which face").toBe(true);
  // This face is bold: Bold is allowed, and is what the card had.
  await expect(page.locator("#modelTextStyle [data-style=bold]")).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#modelTextStyle [data-style=bold]")).toHaveAttribute("aria-pressed", "true");
});

test("a variable font has a weight field instead of Bold, and the step and Edit keep the weight", async ({ page }) => {
  const tree = await openModel(page);
  await openText(page);
  await expect(page.locator("#modelTextWeight")).toBeHidden();
  await addFont(page, "flex.ttf", VARIABLE);
  await expect(userFonts(page).first()).toHaveText("Flex Sans Regular");
  const weight = page.locator("#modelTextWeight");
  await expect(weight).toBeVisible();
  await expect(weight).toHaveValue("400");
  await expect(weight).toHaveAttribute("min", "300");
  await expect(weight).toHaveAttribute("max", "800");
  await expect(page.locator("#modelTextStyle [data-style=bold]")).toHaveAttribute("data-tip", "A variable font takes its weight from the Weight field.");
  await weight.fill("650");
  await weight.dispatchEvent("input");
  expect(await page.locator("#modelTextSample").evaluate((node) => getComputedStyle(node).fontWeight)).toBe("650");
  await expect.poll(() => tree.of("textLayout").at(-1)?.weight).toBe(650);
  await page.screenshot({ path: `${shots}/card-variable.png` });
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelHistoryTree [role=treeitem]")).toHaveCount(2);
  const op = tree.of("apply").at(-1)!.op as { steps: Body[]; source: Body };
  expect(op.steps[0]).toMatchObject({ kind: "lettering", weight: 650 });
  expect(op.source).toMatchObject({ weight: 650 });
  await page.keyboard.press("Shift+E");
  await expect(weight).toHaveValue("650");
});

test("a restricted font says so, the project keeps only its letters, and they come back when it opens", async ({ page }) => {
  const tree = await openModel(page);
  page.on("dialog", (dialog) => void dialog.accept());
  await openText(page);
  await addFont(page, "closed.ttf", RESTRICTED);
  const sentence = "‘Closed Mono Regular’ does not allow embedding, so this project keeps only the outlines of the letters you use.";
  await expect(page.locator("#modelTextLicence")).toHaveText(sentence);
  await expect(page.locator("#modelTextLicence")).toBeVisible();
  await typeText(page, "LOT 42");
  await page.screenshot({ path: `${shots}/card-restricted.png` });
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelHistoryTree [role=treeitem]")).toHaveCount(2);
  // Save: the project's copy is the pack of the letters the text uses, not the file.
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const saved = fs.readFileSync((await download.path())!);
  const doc = JSON.parse(saved.toString("utf8")) as { fonts?: Record<string, { name: string; encoding: string; data: string }> };
  const records = Object.entries(doc.fonts ?? {});
  expect(records, "one font in the project").toHaveLength(1);
  const body = zlib.gunzipSync(Buffer.from(records[0]![1].data, "base64"));
  expect(body.equals(RESTRICTED), "not the file").toBe(false);
  const packed = JSON.parse(body.toString("utf8")) as { letters: string; name: string };
  expect(packed.letters, "only the letters the text uses").toBe("24LOT");
  expect(packed.name).toBe("Closed Mono Regular");
  expect(tree.of("textFontPack").at(-1)!.uses).toEqual([{ text: "LOT 42" }]);
  // Start over with no library and no shelf, then open the project: its font is given to the engine, as the pack it holds.
  await page.evaluate(() => localStorage.removeItem("test-font-library"));
  await page.reload();
  await loadPlate(page);
  const before = tree.of("textFontAdd").length;
  await page.locator("#projectFile").setInputFiles({ name: "lettered.lime", mimeType: "application/json", buffer: saved });
  await expect.poll(() => tree.of("textFontAdd").length).toBe(before + 1);
  const given = Buffer.from(String(tree.of("textFontAdd").at(-1)!.dataB64), "base64");
  expect(given.equals(body), "the engine is given the project's record, whole").toBe(true);
  await page.locator("#tabModel").click();
  await openText(page);
  await expect(userFonts(page)).toHaveCount(1);
  await expect(userFonts(page).first()).toHaveText("Closed Mono Regular");
  await userFonts(page).first().click();
  await expect(page.locator("#modelTextLicence")).toHaveText("‘Closed Mono Regular’ is saved in this project with only the letters it was used for. Add the font file again to type others.");
  await page.screenshot({ path: `${shots}/card-reopened-pack.png` });
});
