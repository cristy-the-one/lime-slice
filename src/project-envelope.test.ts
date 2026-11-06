/**
 * The project envelope (./project-envelope.ts) reads a file without Model's tree code and keeps its Model sections as they
 * were. Every `.lime` in the repo: saved from the envelope alone it is the file a full read saves, its Model sections are
 * the file's own, and finishing the envelope with `readModelSections` gives exactly the full read. A file without Model
 * sections reads the same either way, and a damaged history is carried back as it was until Model reads it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultProfile } from "./profiles.ts";
import { DEFAULT_PRESET } from "./presets.ts";
import { meshRecord, readModelSections, type LimeProject } from "./project.ts";
import { decodeProject, decodeProjectEnvelope, encodeProject, plainDocument } from "./project-codec.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const sections = (doc: Record<string, unknown>) =>
  JSON.stringify({ trees: (doc.objects as Record<string, unknown>[]).map((row) => row.modelTree), tools: doc.modelTools, held: doc.heldPieces });

const fixtures = new URL("../mcp/fixtures/", import.meta.url);
const files = readdirSync(fileURLToPath(fixtures)).filter((name) => name.endsWith(".lime"));
check("the repo has .lime fixtures", files.length >= 2, String(files.length));
for (const name of files) {
  const text = readFileSync(fileURLToPath(new URL(name, fixtures)), "utf8");
  const full = await decodeProject(text);
  const envelope = await decodeProjectEnvelope(text);
  check(`${name} opens whole`, full.ok);
  check(`${name} opens as an envelope`, envelope.ok);
  if (!full.ok || !envelope.ok) continue;
  check(`${name}: the envelope keeps its Model sections`, !!envelope.project.modelSections);
  check(`${name}: a full read keeps none`, full.project.modelSections === undefined);
  const saved = await encodeProject(full.project);
  const carried = await encodeProject(envelope.project);
  check(`${name}: saved from the envelope alone, it is the file a full read saves`, carried === saved);
  check(`${name}: and its Model sections are the file's own`, sections(await plainDocument(carried)) === sections(await plainDocument(text)));
  const finished = readModelSections(envelope.project);
  check(`${name}: the envelope finished by readModelSections is the full read`, JSON.stringify(finished) === JSON.stringify(full.project));
  check(`${name}: and saves the same bytes`, (await encodeProject(finished)) === saved);
}

// A plate without Model sections: nothing is left to decode, and the envelope is the whole project.
const stl = new Uint8Array(84);
const placement = { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1] as LimeProject["placement"]["orient"], scale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, stepTolerance: 0.05 };
const object = (id: string) => ({ id, name: `${id}.stl`, mesh: meshRecord(`${id}.stl`, stl), placement, supportEdits: [] });
const plain: LimeProject = {
  version: 2,
  mesh: meshRecord("a.stl", stl),
  placement,
  settings: { ...DEFAULT_PRESET },
  preset: null,
  profile: defaultProfile(),
  level: "simple",
  supportEdits: [],
  objects: [object("a"), object("b")],
};
const plainText = await encodeProject(plain);
const plainFull = await decodeProject(plainText);
const plainEnvelope = await decodeProjectEnvelope(plainText);
check("a plate without Model sections reads the same as an envelope", plainFull.ok && plainEnvelope.ok && JSON.stringify(plainEnvelope.project) === JSON.stringify(plainFull.project));
check("and leaves nothing to decode", plainEnvelope.ok && plainEnvelope.project.modelSections === undefined);

// A damaged history and a kept tool no tree names: a full read leaves both out and says so; the envelope carries them
// back as they were, and readModelSections then reads them as the full read does.
const doc = await plainDocument(plainText);
(doc.objects as Record<string, unknown>[])[1]!.modelTree = { nodes: "damaged", current: 0 };
doc.modelTools = [{ id: "gone", name: "gone tool", modelTree: { nodes: [] } }];
const damaged = JSON.stringify(doc);
const damagedFull = await decodeProject(damaged);
const damagedEnvelope = await decodeProjectEnvelope(damaged);
check("a damaged history opens", damagedFull.ok && damagedEnvelope.ok);
if (damagedFull.ok && damagedEnvelope.ok) {
  check("a full read names it", JSON.stringify(damagedFull.project.unreadHistory) === JSON.stringify(["b.stl"]), JSON.stringify(damagedFull.project.unreadHistory));
  const back = await plainDocument(await encodeProject(damagedEnvelope.project));
  check("the envelope writes the damaged tree back as it was", JSON.stringify((back.objects as Record<string, unknown>[])[1]!.modelTree) === JSON.stringify({ nodes: "damaged", current: 0 }));
  check("and the kept tool", JSON.stringify(back.modelTools) === JSON.stringify(doc.modelTools));
  check("readModelSections reads them as a full read does", JSON.stringify(readModelSections(damagedEnvelope.project)) === JSON.stringify(damagedFull.project));
}

// One object whose only Model section is a damaged tree: the full read is a version 1 project, the envelope keeps the
// plate so the tree it carries is written back on its object.
const one = await plainDocument(plainText);
one.objects = [{ ...(one.objects as Record<string, unknown>[])[0]!, name: "a.stl", modelTree: { nodes: [] } }];
const oneText = JSON.stringify(one);
const oneFull = await decodeProject(oneText);
const oneEnvelope = await decodeProjectEnvelope(oneText);
if (oneFull.ok && oneEnvelope.ok) {
  check("one object with a damaged tree reads as version 1 whole", oneFull.project.version === 1);
  const back = await plainDocument(await encodeProject(oneEnvelope.project));
  check("the envelope writes its tree back", JSON.stringify((back.objects as Record<string, unknown>[])[0]!.modelTree) === JSON.stringify({ nodes: [] }));
  check("readModelSections gives the full read", JSON.stringify(readModelSections(oneEnvelope.project)) === JSON.stringify(oneFull.project));
} else {
  check("one object with a damaged tree opens", false);
}

if (failed > 0) {
  console.error(`project-envelope: ${failed} failed`);
  process.exit(1);
}
console.log(`project-envelope: ${files.length} repo .lime files round-trip through the envelope; plain, damaged and one-object cases ok`);
