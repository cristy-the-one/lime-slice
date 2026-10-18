/**
 * The optional thumbnail and summary on a version 3 project.
 * A bad picture is ignored. A picture of different geometry is not written back.
 */
import { deflateSync } from "node:zlib";

import { meshRecord, parseProject, serializeProject, PROJECT_VERSION, type LimeProject } from "./project.ts";
import { geometryHash, geometryPreimage, pngInfo, projectSummary } from "./project-thumb.ts";
import { defaultProfile } from "./profiles.ts";
import { DEFAULT_PRESET } from "./presets.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function tinyPng(width: number, height: number, colorType = 6): Uint8Array {
  const channels = colorType === 6 ? 4 : 3;
  const raw = new Uint8Array(height * (1 + width * channels));
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const head = new DataView(out.buffer);
    head.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    head.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

const bytes = new Uint8Array([0x73, 0x74, 0x6c, 1, 2, 3, 4, 9]);
const placement = {
  orient: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number],
  scale: 1,
  centered: true,
  offset: { x: 0, y: 0, z: 0 },
  stepTolerance: 0.05,
};
const project: LimeProject = {
  version: 1,
  mesh: meshRecord("bracket.stl", bytes),
  placement,
  settings: { ...DEFAULT_PRESET, layerHeight: 0.2 },
  preset: null,
  profile: { ...defaultProfile(), name: "Voron 2.4" },
  level: "simple",
  supportEdits: [],
};

const bare = serializeProject(project);
check("a project without a preview serializes as before", !bare.includes("thumbnail") && !bare.includes("summary") && bare.includes('"version": 1'));
const bareOpened = parseProject(bare);
check("that file opens", bareOpened.ok && !bareOpened.project.thumbnail && !bareOpened.project.summary);

const png = tinyPng(2, 2);
const hash = geometryHash(project);
check("the geometry hash is 16 hex digits", /^[0-9a-f]{16}$/.test(hash));
check("the pinned preimage starts with the version-1 id", geometryPreimage(project).startsWith("part\n"));
const data = Buffer.from(png).toString("base64");
const stamped = "2026-10-18T09:00:00.000Z";
const withPicture: LimeProject = {
  ...project,
  thumbnail: { format: "png", width: 2, height: 2, data, meshHash: hash, generatedBy: "lime-slice/2.7.0", createdAt: stamped },
  summary: { name: "bracket.stl", printer: "Voron 2.4", objectCount: 1, layerHeight: 0.2, slicedSeconds: 90, grams: 1.5 },
};
const text = serializeProject(withPicture);
check("the thumbnail is the first key", text.startsWith('{\n  "thumbnail": {'));
check("the summary is the second key", text.indexOf('"summary"') > 0 && text.indexOf('"summary"') < text.indexOf('"version"'));
const opened = parseProject(text);
check("the picture round-trips", opened.ok && opened.project.thumbnail?.data === data && opened.project.thumbnail.meshHash === hash && opened.project.thumbnail.createdAt === stamped);
check("the summary round-trips", opened.ok && opened.project.summary?.grams === 1.5 && opened.project.summary.slicedSeconds === 90 && opened.project.summary.printer === "Voron 2.4");
check("the version stays 1 for one object", opened.ok && opened.project.version === 1);
const again = opened.ok ? serializeProject(opened.project) : "";
check("a second save keeps the picture", again === text);

const moved = serializeProject({ ...withPicture, placement: { ...placement, offset: { x: 4, y: 0, z: 0 } } });
check("moving the part drops the picture", !moved.includes('"thumbnail"') && moved.includes('"summary"'));
const retintedProject = { ...withPicture, settings: { ...withPicture.settings, layerHeight: 0.28 } };
const retinted = serializeProject(retintedProject);
const retintedDoc = JSON.parse(retinted) as { thumbnail?: { meshHash?: string }; summary?: { layerHeight?: number } };
check("a settings change keeps the picture", retintedDoc.thumbnail?.meshHash === hash && geometryHash(retintedProject) === hash);
check("a writer rebuilds the summary from the new layer height", projectSummary(retintedProject).layerHeight === 0.28);

const damaged = JSON.parse(text) as Record<string, unknown>;
const cases: [string, Record<string, unknown>][] = [
  ["a JPEG is not a thumbnail", { ...damaged, thumbnail: { ...(damaged.thumbnail as object), format: "jpeg" } }],
  ["a huge claim is ignored", { ...damaged, thumbnail: { ...(damaged.thumbnail as object), data: "A".repeat(200_000) } }],
  ["a mismatched size is ignored", { ...damaged, thumbnail: { ...(damaged.thumbnail as object), width: 9 } }],
  ["a missing hash is ignored", { ...damaged, thumbnail: { format: "png", width: 2, height: 2, data } }],
  ["a string thumbnail is ignored", { ...damaged, thumbnail: "nope" }],
];
for (const [name, doc] of cases) {
  const parsed = parseProject(JSON.stringify(doc));
  check(name, parsed.ok && !parsed.project.thumbnail, parsed.ok ? "" : parsed.message);
  if (parsed.ok) check(`${name} is not written back`, !serializeProject(parsed.project).includes('"thumbnail"'));
}
const prose = parseProject("{");
check("truncated JSON is still not a project", !prose.ok);
const old = parseProject(JSON.stringify({ ...JSON.parse(bare), thumbnail: undefined }));
check("an explicit empty thumbnail opens", old.ok && !old.project.thumbnail);

const plate: LimeProject = {
  ...project,
  version: 2,
  objects: [
    { id: "a", name: "bracket.stl", mesh: project.mesh, placement, supportEdits: [] },
    { id: "b", name: "clip.stl", mesh: meshRecord("clip.stl", new Uint8Array([1, 2, 3, 4])), placement: { ...placement, offset: { x: 30, y: 0, z: 0 } }, supportEdits: [] },
  ],
};
const plateHash = geometryHash(plate);
const plateText = serializeProject({
  ...plate,
  thumbnail: { format: "png", width: 2, height: 2, data, meshHash: plateHash, generatedBy: "lime-mcp/2.7.0", createdAt: stamped },
  summary: { name: "bracket.stl", printer: "Voron 2.4", objectCount: 2, layerHeight: 0.2 },
});
const plateDoc = JSON.parse(plateText) as { version?: number; thumbnail?: { meshHash?: string } };
check("a plate is still version 3", plateDoc.version === PROJECT_VERSION && plateDoc.thumbnail?.meshHash === plateHash);
const plateOpened = parseProject(plateText);
check("a plate picture round-trips", plateOpened.ok && plateOpened.project.thumbnail?.meshHash === plateHash && plateOpened.project.summary?.objectCount === 2);
const plateLines = geometryPreimage(plate);
check("the plate preimage names both objects", plateLines.startsWith("a\n") && plateLines.includes("\nb\n"));

const info = pngInfo(png);
check("the sample PNG is RGBA", info?.width === 2 && info.height === 2 && info.colorType === 6);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("project-thumb: round trip, stale drop, and bad pictures ok");
