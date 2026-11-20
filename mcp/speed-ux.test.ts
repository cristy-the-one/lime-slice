/**
 * MCP speed and LLM ergonomics:
 * - guide {query} stemming & CAD/slicer synonym discovery, edit-distance tool suggestions, comma-separated batch guide {tool} / {kind}
 * - slice_start {wait: true} one-shot slicing, immediate warnings in slice_wait, lazy parked G-code on demand
 * - plan_run missing reference reports available keys
 * - withMesh fast JSON splice preserves valid JSON
 * - headless lazy bridge materializes identical bridgeSnapshot on demand
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { nearestTools, search } from "./catalog.ts";
import { fakeEngine, withMesh } from "./engine.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-speed-ux-"));
delete process.env.LIME_MCP_BRIDGE;
delete process.env.LIME_MCP_BRIDGE_TOKEN;

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}` : ""}`);
}

// 1. Discovery search: silent-e stemming and everyday CAD/3D-printing synonyms.
check("search('slicing a mesh') finds slice_start", search("slicing a mesh", 5).some((h) => h.label === "slice_start"), search("slicing a mesh", 5).map((h) => h.label));
check("search('screenshot') finds render_view first", search("screenshot", 3)[0]?.label === "render_view", search("screenshot", 3).map((h) => h.label));
check("search('rotate part') finds object_place", search("rotate part", 5).some((h) => h.label === "object_place"), search("rotate part", 5).map((h) => h.label));
check("search('hollow a box') finds op shell", search("hollow a box", 3).some((h) => h.label === "op shell"), search("hollow a box", 3).map((h) => h.label));
check("search('bevel edges') finds op chamfer first", search("bevel edges", 3)[0]?.label === "op chamfer", search("bevel edges", 3).map((h) => h.label));
check("search('subtract a cylinder') finds op boolean first", search("subtract a cylinder", 3)[0]?.label === "op boolean", search("subtract a cylinder", 3).map((h) => h.label));
check("search('print time and weight') finds gcode_summary first", search("print time and weight", 3)[0]?.label === "gcode_summary", search("print time and weight", 3).map((h) => h.label));
check("search('filament weight') finds gcode_summary first", search("filament weight", 3)[0]?.label === "gcode_summary", search("filament weight", 3).map((h) => h.label));
check("search('infill density') finds settings_set or settings_schema", search("infill density", 5).some((h) => h.label === "settings_set" || h.label === "settings_schema"), search("infill density", 5).map((h) => h.label));

// 2. Edit-distance suggestions for misspelled tool names.
check("nearestTools('mesh_improt') suggests mesh_import first", nearestTools("mesh_improt")[0] === "mesh_import", nearestTools("mesh_improt"));
check("nearestTools('slice_strt') suggests slice_start first", nearestTools("slice_strt")[0] === "slice_start", nearestTools("slice_strt"));
check("nearestTools('model_aply') suggests model_apply first", nearestTools("model_aply")[0] === "model_apply", nearestTools("model_aply"));

// 3. Batch guide {tool: "a,b"} and guide {kind: "a,b"}.
{
  const session = new Session(fakeEngine());
  const tools = await session.call("guide", { tool: "mesh_import, slice_start" });
  const list = tools.tools as { tool?: string }[] | undefined;
  check("guide {tool:'a,b'} returns both tool docs in one call", tools.ok === true && list?.length === 2 && list[0]?.tool === "mesh_import" && list[1]?.tool === "slice_start", tools);
  const partial = await session.call("guide", { tool: "mesh_import,nope_tool" });
  check("guide {tool:'a,missing'} returns found docs and lists missing", partial.ok === true && (partial.tools as unknown[])?.length === 1 && JSON.stringify(partial.missing) === '["nope_tool"]', partial);
  const kinds = await session.call("guide", { kind: "hole,fillet" });
  const kindList = kinds.kinds as { kind?: string }[] | undefined;
  check("guide {kind:'a,b'} returns both op kind docs in one call", kinds.ok === true && kindList?.length === 2 && kindList[0]?.kind === "hole" && kindList[1]?.kind === "fillet", kinds);
}

// 4. One-shot slice_start {wait: true}, immediate warnings, and lazy parked G-code via slicePollWire + sliceGcode.
{
  const cube = fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url));
  const inner = fakeEngine();
  let gcodeCalls = 0;
  let wirePolls = 0;
  const gcodeById = new Map<string, string>();
  const engine = {
    ...inner,
    slicePollWire: (id: string) => {
      wirePolls += 1;
      const raw = JSON.parse(inner.slicePoll(id) as string) as { status?: string; stage?: string; fraction?: number; result?: string; error?: string };
      if (raw.status === "done" && raw.result) {
        const wire = JSON.parse(raw.result) as Record<string, unknown>;
        const gcode = String(wire.gcode ?? "");
        delete wire.gcode;
        wire.inAir = { islands: 1, overhangs: 2 };
        gcodeById.set(id, gcode);
        return JSON.stringify({ status: "done", stage: raw.stage, fraction: raw.fraction, hasParkedGcode: true, wire, error: null });
      }
      return JSON.stringify({ status: raw.status, stage: raw.stage, fraction: raw.fraction, hasParkedGcode: false, error: raw.error ?? null });
    },
    sliceGcode: (id: string) => {
      gcodeCalls += 1;
      return JSON.stringify({ ok: true, gcode: gcodeById.get(id) ?? "" });
    },
  };
  const session = new Session(engine);
  await session.call("mesh_import", { path: cube });
  // Headless lazy bridge materializes exact snapshot on demand.
  const snap = session.bridgeSnapshot() as { plate?: { object: string }[]; meshes?: Record<string, unknown> } | null;
  check("headless lazy bridgeSnapshot materializes plate and meshes", (snap?.plate?.length ?? 0) === 1 && Object.keys(snap?.meshes ?? {}).length === 1, snap);

  const sliced = await session.call("slice_start", { wait: true });
  check(
    "slice_start {wait: true} returns finished slice and warnings in one call without fetching G-code",
    sliced.ok === true && sliced.status === "done" && typeof sliced.seconds === "number" && wirePolls >= 1 && gcodeCalls === 0
      && Array.isArray(sliced.warnings) && sliced.warnings.some((w) => String(w).includes("1 island"))
      && typeof sliced.warningCount === "number" && sliced.warningCount >= 1
      && typeof sliced.unheldMm === "number" && sliced.unheldMm > 0,
    { sliced, wirePolls, gcodeCalls },
  );
  const summary = await session.call("gcode_summary", {});
  check("gcode_summary materializes lazy parked G-code once", summary.ok === true && gcodeCalls === 1, { summary, gcodeCalls });
  const read = await session.call("gcode_read", { fromLine: 1, count: 5 });
  check("gcode_read reuses cached G-code without calling sliceGcode again", read.ok === true && gcodeCalls === 1 && Array.isArray(read.lines) && read.lines.length > 0, { read, gcodeCalls });
}

// 5. plan_run reference error includes available keys to self-correct.
{
  const session = new Session(fakeEngine());
  const bad = await session.call("plan_run", {
    steps: [
      { tool: "solid_new", args: { primitive: "box", dx: 10, dy: 10, dz: 10 } },
      { tool: "faces_find", args: { object: "$1.wrongKey" } },
    ],
  });
  check(
    "plan_run missing reference reports available keys",
    bad.ok === false && bad.code === "plan-reference" && Array.isArray(bad.available) && (bad.available as string[]).includes("object"),
    bad,
  );
}

// 6. withMesh fast JSON splice matches full parse/stringify.
{
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const b64 = Buffer.from(bytes).toString("base64");
  const spliced = JSON.parse(withMesh('{"filename":"a.stl","stepToleranceMm":0.05}', bytes)) as Record<string, unknown>;
  const emptyObj = JSON.parse(withMesh("{}", bytes)) as Record<string, unknown>;
  const existing = JSON.parse(withMesh('{"filename":"a.stl","dataB64":"KEEP"}', bytes)) as Record<string, unknown>;
  check("withMesh splices dataB64 into non-empty JSON object", spliced.filename === "a.stl" && spliced.dataB64 === b64, spliced);
  check("withMesh splices dataB64 into empty JSON object", emptyObj.dataB64 === b64, emptyObj);
  check("withMesh preserves existing non-empty dataB64", existing.dataB64 === "KEEP", existing);
}

if (failed > 0) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("speed-ux: all checks passed");
