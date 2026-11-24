/**
 * E2 "tool coverage and one vocabulary" (docs/plan-agent-ergonomics.md §4): one check per item.
 * The stand-in engine records the open and accepts the baked op. Kernel volumes are in
 * mcp/one-vocabulary-occt.test.ts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { featureCopies } from "../src/modeling/compose.ts";
import { GLOBAL_WORKPLANE } from "../src/workplane.ts";
import { fakeEngine } from "./engine.ts";
import { validateTool } from "./schema.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-e2-ws-"));

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 3000)}`);
}

type R = Record<string, unknown>;
const square = [[-8, -8], [8, -8], [8, 8], [-8, 8]];
const callOf = (session: Session) => async (name: string, args: unknown = {}): Promise<R> => {
  try {
    return await session.call(name, args) as R;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
};

function redPixels(png: Uint8Array): number {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  const parts: Buffer[] = [];
  let width = 0;
  let height = 0;
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
    }
    if (type === "IDAT") parts.push(Buffer.from(png.subarray(offset + 8, offset + 8 + length)));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  let red = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const at = y * (width * 3 + 1) + 1 + x * 3;
    const r = raw[at]!;
    const g = raw[at + 1]!;
    const b = raw[at + 2]!;
    if (r > 80 && r > g + 40 && r > b + 40) red += 1;
  }
  return red;
}

function opOf(session: Session, object: unknown, node: unknown): R | undefined {
  const obj = session.objects.find((row) => row.id === object);
  const id = typeof node === "string" ? Number(node.replace("node_", "")) : NaN;
  return obj?.tree?.nodes.get(id)?.op as R | undefined;
}

// --- Item 1. solid_new {feature} opens from an extrude, a revolve, a loft or a sweep. No box underneath.
{
  const engine = fakeEngine();
  const session = new Session(engine);
  const call = callOf(session);
  const loft = { kind: "loft", sections: [{ origin: [0, 0, 0], profile: square }, { origin: [0, 0, 20], profile: square.map(([u, v]) => [u! * 0.6, v! * 0.6]) }] };
  const extrude = { kind: "extrude", profile: [[0, 0], [10, 0], [10, 10], [0, 10]], depth: 10 };
  const revolve = { kind: "revolve", profile: [[4, 0], [8, 0], [8, 6], [4, 6]] };
  const sweep = { kind: "sweep", sections: [{ origin: [0, 0, 0], radius: 3 }], spine: { kind: "spline", through: [[0, 0, 0], [0, 0, 20]] } };
  const made = await Promise.all([loft, extrude, revolve, sweep].map((feature) => call("solid_new", { feature })));
  const sent = engine.opens.slice(-4).map((row) => row.feature as { kind?: string } | undefined);
  const roots = made.map((reply) => {
    const obj = session.objects.find((row) => row.id === reply.object);
    return obj?.tree?.root.kind === "feature" ? obj.tree.root.op.kind : obj?.tree?.root.kind;
  });
  const noBox = engine.opens.slice(-4).every((row) => row.primitive === undefined && row.feature !== undefined);
  check(
    "item 1: solid_new {feature} opens from an extrude, a revolve, a loft or a sweep, with no box under it",
    made.every((reply, i) => reply.ok === true && reply.root === [loft, extrude, revolve, sweep][i]!.kind) && sent.map((row) => row?.kind).join() === "loft,extrude,revolve,sweep" && roots.join() === "loft,extrude,revolve,sweep" && noBox,
    { made: made.map((reply) => ({ ok: reply.ok, root: reply.root, reason: reply.reason })), sent: sent.map((row) => row?.kind), roots },
  );
}

// --- Item 2. centre is the bounding-box centre. With none, the solid stands on z = 0, centred in X and Y.
{
  const engine = fakeEngine();
  const session = new Session(engine);
  const call = callOf(session);
  const stood = await call("solid_new", { primitive: "box", dx: 30, dy: 20, dz: 16 });
  const stoodAt = (engine.opens.at(-1)?.primitive as { origin?: number[] } | undefined)?.origin;
  const placed = await call("solid_new", { primitive: "box", dx: 30, dy: 20, dz: 16, centre: [10, 20, 30] });
  const origin = (engine.opens.at(-1)?.primitive as { origin?: number[]; size?: number[] } | undefined);
  const mid = origin?.origin && origin.size ? origin.origin.map((value, i) => value + origin.size![i]! / 2) : [];
  const feature = await call("solid_new", { centre: [0, 0, 1], feature: { kind: "extrude", profile: [[0, 0], [1, 0], [0, 1]], depth: 1 } });
  check(
    "item 2: solid_new centre is the bounding-box centre, and a feature does not take one",
    stood.ok === true && JSON.stringify(stoodAt) === "[-15,-10,0]" && placed.ok === true && JSON.stringify(mid) === "[10,20,30]" && feature.ok === false && String(feature.reason).includes("centre"),
    { stoodAt, origin, mid, feature },
  );
}

// --- Item 3. A mirror repeats a sweep: the path and up are mirrored.
{
  const engine = fakeEngine();
  const session = new Session(engine);
  const call = callOf(session);
  const copies = featureCopies(
    { kind: "mirror", plane: "x", op: { kind: "sweep", path: [[10, 0, 5], [30, 0, 15]], up: [1, 0, 0], profile: [[0, 0], [4, 0], [0, 2]] } },
    GLOBAL_WORKPLANE,
    () => ({ origin: [0, 0, 0], turn: [0, 0, 0] }),
  );
  const image = Array.isArray(copies) ? copies[1] : undefined;
  const part = await call("solid_new", { primitive: "box", dx: 40, dy: 40, dz: 20 });
  const applied = await call("model_apply", { object: part.object, probe: true, op: { kind: "mirror", plane: "x", op: { kind: "sweep", path: [[0, 0, 10], [10, 0, 10]], radius: 1, steps: 1 } } });
  check(
    "item 3: a mirror repeats a sweep, with the path and up mirrored",
    Array.isArray(copies) && copies.length === 2 && JSON.stringify(image?.path) === "[[-10,0,5],[-30,0,15]]" && JSON.stringify(image?.up) === "[-1,0,0]" && JSON.stringify(image?.profile) === "[[0,0],[-4,0],[0,2]]" && applied.ok === true && !String(applied.reason ?? "").includes("repeats one of"),
    { copies, applied: { ok: applied.ok, reason: applied.reason } },
  );
}

// --- Item 4. A bending path and a profile use the pipe-shell. Round caps are refused with the spine form.
{
  const engine = fakeEngine();
  const session = new Session(engine);
  const call = callOf(session);
  const part = await call("solid_new", { primitive: "box", dx: 40, dy: 40, dz: 20 });
  const profile = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const bent = await call("model_apply", { object: part.object, probe: true, op: { kind: "sweep", path: [[0, 0, 10], [20, 0, 10], [20, 20, 10]], profile, steps: 1 } });
  const stored = opOf(session, part.object, bent.node);
  const straight = await call("model_apply", { object: part.object, probe: true, op: { kind: "sweep", path: [[0, 0, 10], [20, 0, 10]], profile, steps: 1 } });
  const chord = opOf(session, part.object, straight.node);
  const capped = await call("model_apply", { object: part.object, probe: true, op: { kind: "sweep", path: [[0, 0, 10], [20, 0, 10], [20, 20, 10]], profile, caps: "round", steps: 1 } });
  const spine = stored?.spine as { kind?: string; through?: unknown } | undefined;
  check(
    "item 4: a bending path and a profile are a pipe-shell, and round caps name the spine form",
    bent.ok === true && stored?.kind === "sweep" && spine?.kind === "spline" && JSON.stringify(spine?.through) === "[[0,0,10],[20,0,10],[20,20,10]]" && straight.ok === true && chord?.kind === "loft" && capped.ok === false && String(capped.reason).includes("spine") && String(capped.reason).includes("sections"),
    { bent: { ok: bent.ok, reason: bent.reason, kind: stored?.kind, spine }, straight: { ok: straight.ok, kind: chord?.kind }, capped },
  );
}

// --- Item 5. A one-element list is the scalar. A list of the wrong length is still refused.
{
  const session = new Session(fakeEngine());
  const call = callOf(session);
  const part = await call("solid_new", { primitive: "box", dx: 40, dy: 20, dz: 20 });
  const path = [[0, 0, 10], [30, 0, 10]];
  const radius = await call("model_apply", { object: part.object, probe: true, op: { kind: "sweep", path, radius: [2], steps: 1 } });
  const radiusV = await call("model_apply", { object: part.object, probe: true, op: { kind: "sweep", path, radius: 2, radiusV: [1], steps: 1 } });
  const scale = await call("model_apply", { object: part.object, probe: true, op: { kind: "sweep", path, profile: square, scale: [2], steps: 1 } });
  const wrong = await call("model_apply", { object: part.object, probe: true, op: { kind: "sweep", path, radius: [2, 3, 4], steps: 1 } });
  check(
    "item 5: sweep radius, radiusV and scale take a one-element list as the scalar",
    radius.ok === true && radiusV.ok === true && scale.ok === true && wrong.ok === false && String(wrong.reason).includes("2 path points"),
    { radius, radiusV, scale, wrong },
  );
}

// --- Item 6. colours and partColours are accepted, and a colour that cannot apply is a warning.
{
  const session = new Session(fakeEngine());
  const call = callOf(session);
  const arm = await call("solid_new", { primitive: "box", dx: 20, dy: 12, dz: 30, name: "Arm" });
  const body = await call("solid_new", { primitive: "box", dx: 16, dy: 16, dz: 16, name: "Body" });
  await call("model_apply", { object: arm.object, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [-2, -2, 28], dx: 4, dy: 4, dz: 4, label: "boss" }, probe: true });
  await call("model_place", { object: body.object, to: arm.object, x: 40 });
  const legendOf = (reply: R) => (reply.colours as { label?: string }[] | undefined)?.map((row) => row.label);
  const warnOf = (reply: R) => ((reply.warnings ?? []) as { reason?: string }[]).map((row) => row.reason ?? "").join(" ");
  const painted = await call("render_view", { object: arm.object, colours: { boss: "#ff0000", missing: "#00ff00" }, inline: false, longEdge: 48 });
  const assembly = await call("render_view", { object: arm.object, view: "assembly", colours: { boss: "#ff0000", missing: "#00ff00" }, inline: false, longEdge: 48 });
  const assemblyPng = assembly.path ? redPixels(await (await import("node:fs")).readFileSync(String(assembly.path))) : 0;
  const named = await call("render_view", { object: arm.object, partColours: { Arm: "#ff0000" }, inline: false, longEdge: 48 });
  const namedPng = named.path ? redPixels(await (await import("node:fs")).readFileSync(String(named.path))) : 0;
  const typo = await call("render_view", { object: arm.object, partColours: { arm: "#ff0000" }, inline: false });
  const unknown = await call("render_view", { object: arm.object, partColours: { Nope: "#112233" }, inline: false });
  const orange = await call("render_view", { object: arm.object, colours: { boss: "orange" }, inline: false });
  const shape = validateTool("pose_animate", { object: arm.object, source: "fn main(){}", colours: { boss: "#ff0000" }, partColours: { Arm: "#112233" } });
  const posed = await call("pose_animate", { object: arm.object, source: "fn main(){}", colours: { missing: "#ff0000" }, partColours: { Arm: "#112233" } });
  const posedTypo = await call("pose_animate", { object: arm.object, source: "fn main(){}", partColours: { arm: "#00ff00" }, out: { frames: "typo-frames" } });
  const posedNope = await call("pose_animate", { object: arm.object, source: "fn main(){}", partColours: { Nope: "#00ff00" }, out: { frames: "nope-frames" } });
  const posedWarn = warnOf(posed);
  const views = painted.ok === true && legendOf(painted)?.includes("boss") === true && warnOf(painted).includes("missing") && !String(painted.reason ?? "").includes("view draws several")
    && assembly.ok === true && assemblyPng > 0 && warnOf(assembly).includes("missing") && !String(assembly.reason ?? "").includes("view draws several")
    && named.ok === true && namedPng > 0 && !String(named.reason ?? "").includes("partColours needs")
    && typo.ok === false && String(typo.reason).includes("did you mean Arm")
    && unknown.ok === false && String(unknown.reason).includes('No part named "Nope"') && !String(unknown.reason).includes("did you mean")
    && orange.ok === false && String(orange.reason).includes("#")
    && shape === null
    && !String(posed.reason ?? "").includes("not a field") && !String(posed.reason ?? "").includes("partColours and fit say") && (posedWarn.includes("missing") || posedWarn.includes("not drawn"))
    && posedTypo.ok === false && String(posedTypo.reason).includes("did you mean Arm")
    && posedNope.ok === false && String(posedNope.reason).includes('no part named "Nope"') && !String(posedNope.reason).includes("did you mean");
  check("item 6: render_view and pose_animate take colours and partColours, and warn where one cannot apply", views, { painted: { ok: painted.ok, reason: painted.reason, legend: legendOf(painted), warnings: painted.warnings }, assembly: { ok: assembly.ok, reason: assembly.reason, warnings: assembly.warnings, red: assemblyPng }, named: { ok: named.ok, reason: named.reason, red: namedPng }, typo, unknown, orange, shape, posed: { ok: posed.ok, reason: posed.reason, warnings: posed.warnings }, posedTypo, posedNope });
}

// --- Item 7. A common alias is refused with the canonical field. It is not accepted.
{
  const rows: [string, R, string, string][] = [
    ["project_save", { path: "a.lime" }, "path", "name"],
    ["project_save", { file: "a.lime" }, "file", "name"],
    ["project_save", { filename: "a.lime" }, "filename", "name"],
    ["project_save", { filepath: "a.lime" }, "filepath", "name"],
    ["project_open", { name: "a.lime" }, "name", "path"],
    ["project_open", { file: "a.lime" }, "file", "path"],
    ["app_open", { filename: "a.lime" }, "filename", "path"],
    ["mesh_import", { name: "a.stl" }, "name", "path"],
    ["gcode_export", { path: "a.gcode" }, "path", "name"],
    ["export_3mf", { filepath: "a.3mf" }, "filepath", "name"],
    ["model_export_step", { file: "a.step" }, "file", "name"],
    ["render_view", { path: "a.png" }, "path", "name"],
    ["layer_image", { filename: "a.png" }, "filename", "name"],
    ["layer_paths", { path: "a.svg" }, "path", "name"],
    ["profile_save", { path: "a.json" }, "path", "name"],
    ["machine_save", { file: "a.json" }, "file", "name"],
    ["pose_export", { name: "a.step" }, "name", "path"],
    ["pose_export", { file: "a.step" }, "file", "path"],
    ["solid_new", { title: "Arm" }, "title", "name"],
    ["model_define", { title: "bracket" }, "title", "name"],
    ["object_select", { title: "Arm" }, "title", "name"],
    ["model_rename", { name: "Hole" }, "name", "label"],
    ["model_rename", { title: "Hole" }, "title", "label"],
    ["plugin", { name: "widget" }, "name", "id"],
    ["plugin", { path: "a.rs" }, "path", "from"],
    ["nugget", { name: "lesson" }, "name", "id"],
    ["nugget", { filename: "a.rs" }, "filename", "from"],
  ];
  const missed: { tool: string; got: string | null; want: string }[] = [];
  for (const [tool, args, alias, canonical] of rows) {
    const want = `\`${alias}\` is not a field of ${tool}; did you mean \`${canonical}\`?`;
    const got = validateTool(tool, args);
    if (got !== want) missed.push({ tool, got, want });
  }
  const both = validateTool("recipe_run", { file: "a.rs" });
  const poseFile = validateTool("pose_animate", { file: "a.rs" });
  const buildTitle = validateTool("model_build", { title: "bracket" });
  const fuse = validateTool("model_apply", { op: { kind: "boolean", op: "fuse", primitive: "box", dx: 2, dy: 2, dz: 2 } });
  const centre = validateTool("model_apply", { op: { kind: "boolean", op: "fuse", primitive: "box", center: [0, 0, 0], dx: 1, dy: 1, dz: 1 } });
  const ops: [string, string][] = [["union", "fuse"], ["subtract", "cut"], ["difference", "cut"], ["intersect", "common"], ["intersection", "common"]];
  const opMiss: { op: string; got: string | null }[] = [];
  for (const [alias, canonical] of ops) {
    const got = validateTool("model_apply", { op: { kind: "boolean", op: alias, primitive: "box", dx: 2, dy: 2, dz: 2 } });
    const want = `\`${alias}\` is not a boolean op; did you mean \`${canonical}\`?`;
    if (got !== want) opMiss.push({ op: alias, got });
  }
  const session = new Session(fakeEngine());
  const call = callOf(session);
  const made = await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
  const applied = await call("model_apply", { object: made.object, op: { kind: "boolean", op: "union", primitive: "box", dx: 2, dy: 2, dz: 2 } });
  check(
    "item 7: a file, part or plugin alias, and a boolean alias, is refused with the canonical name",
    missed.length === 0 && opMiss.length === 0 && applied.ok === false && String(applied.reason).includes("did you mean `fuse`") && fuse === null && String(centre).includes("Use centre.") && both !== null && !String(both).includes("did you mean") && poseFile !== null && !String(poseFile).includes("did you mean") && buildTitle !== null && !String(buildTitle).includes("did you mean"),
    { missed, opMiss, applied, fuse, centre, both, poseFile, buildTitle },
  );
}

if (failed > 0) {
  console.error(`one-vocabulary: ${failed} failed`);
  process.exit(1);
}
console.log("one-vocabulary: ok");
