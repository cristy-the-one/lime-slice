/**
 * Builds the four synthetic solids for docs/studies/volume-accuracy.md and writes each
 * current node as the engine's brep (LIMEBREP header, then BinTools). No production code. Geometry:
 *
 * - cylinder: solid_new cylinder, radius 12.5 mm, height 40 mm. Analytic volume pi*12.5^2*40.
 * - loft: the bare fuse-volume stand-in loft (mcp/fuse-volume-occt.test.ts), before the cuts.
 * - tub: that loft trimmed by the test's cockpit box and four side holes.
 * - sheet: a 6x6 degree-3 NURBS sheet (formula below), thickened 3 mm along its normal.
 *
 * Run from the repo root, after the debug engine and Open CASCADE 7.9.2 are built:
 *
 *   export OCCT_ROOT=...
 *   export LD_LIBRARY_PATH="$OCCT_ROOT/lib:${LD_LIBRARY_PATH:-}"
 *   cargo build -p lime-mcp-engine -p lime-model-occt --locked
 *   export LIME_OCCT_BRIDGE="$PWD/target/debug/liblime_model_occt.so"
 *   node --experimental-strip-types docs/studies/volume-accuracy-shapes.ts /tmp/volume-accuracy
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { exportRequest } from "../../src/model-request.ts";
import { engineCandidates, loadEngineWorker } from "../../mcp/engine.ts";
import { Session } from "../../mcp/session.ts";

const outDir = process.argv[2] ?? "/tmp/volume-accuracy";
const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("../..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
if (!bridge || !existsSync(bridge) || !addon) {
  console.error("volume-accuracy-shapes: set LIME_OCCT_BRIDGE and build lime-mcp-engine");
  process.exit(1);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-volume-accuracy-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "120";

type Reply = Record<string, unknown>;
const session = new Session(loadEngineWorker(root));
async function call(tool: string, args: Record<string, unknown>): Promise<Reply> {
  try {
    return await session.call(tool, args);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function brief(label: string, reply: Reply): void {
  const solid = reply.solid && typeof reply.solid === "object" ? (reply.solid as Reply) : undefined;
  const faces = Array.isArray(solid?.faces) ? solid.faces.length : undefined;
  console.log(
    `step ${label} ok=${String(reply.ok)} object=${String(reply.object ?? "")} volumeMm3=${String(reply.volumeMm3 ?? solid?.volumeMm3 ?? "")} faces=${String(faces ?? "")} reason=${String(reply.reason ?? "").replace(/\s+/g, " ").slice(0, 200)}`,
  );
}

/** The fuse-volume stand-in sections, copied from mcp/fuse-volume-occt.test.ts. */
const STATIONS = [-88, -86, -83, -76, -40, -5, 6];
const HALF_WIDTH = [14, 20, 25, 29, 30, 27, 22];
const HEIGHT = [30, 36, 40, 44, 46, 44, 38];
function section(x: number, w: number, h: number): Record<string, unknown> {
  const profile: number[][] = [];
  for (let i = 0; i < 16; i += 1) {
    const a = (i / 16) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // turn [0, 90, 0]: profile u runs along −Z and v along Y.
    profile.push([-((h / 2) * Math.sign(s) * Math.abs(s) ** 0.6 + h / 2), w * Math.sign(c) * Math.abs(c) ** 0.6]);
  }
  return { origin: [x, 0, 0], turn: [0, 90, 0], profile, smooth: true };
}

const loftFeature = { kind: "loft", sections: STATIONS.map((x, i) => section(x, HALF_WIDTH[i]!, HEIGHT[i]!)) };

/** 6 by 6 poles, degree left at the kernel default (3). z is a sum of sines over the unit square. */
function organicPoles(): number[][][] {
  const n = 6;
  const spanX = 80;
  const spanY = 60;
  const poles: number[][][] = [];
  for (let i = 0; i < n; i += 1) {
    const row: number[][] = [];
    const u = i / (n - 1);
    for (let j = 0; j < n; j += 1) {
      const v = j / (n - 1);
      const x = (u - 0.5) * spanX;
      const y = (v - 0.5) * spanY;
      const z = 12 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v) + 4 * Math.sin(2 * Math.PI * u) * Math.sin(3 * Math.PI * v);
      row.push([x, y, z]);
    }
    poles.push(row);
  }
  return poles;
}

let exitCode = 0;
try {
  const cylinder = await call("solid_new", { primitive: "cylinder", radius: 12.5, height: 40, name: "cylinder" });
  brief("cylinder", cylinder);
  if (cylinder.ok !== true) throw new Error("cylinder was refused");

  const loft = await call("solid_new", { name: "loft", feature: loftFeature });
  brief("loft", loft);
  if (loft.ok !== true) throw new Error(`loft was refused: ${String(loft.reason)}`);

  const tubMade = await call("solid_new", { name: "tub", feature: loftFeature });
  brief("tub-loft", tubMade);
  if (tubMade.ok !== true) throw new Error(`tub loft was refused: ${String(tubMade.reason)}`);
  const tub = String(tubMade.object);
  const cuts: Record<string, unknown>[] = [
    { kind: "boolean", op: "cut", primitive: "box", centre: [-30, 0, 46], dx: 50, dy: 40, dz: 20 },
    ...[-60, -50, -20, -10].map((x) => ({ kind: "boolean", op: "cut", primitive: "cylinder", centre: [x, 30, 20], radius: 3, height: 12, turn: [90, 0, 0] })),
  ];
  for (const [index, op] of cuts.entries()) {
    const cut = await call("model_apply", { object: tub, probe: true, op });
    brief(`tub-cut-${index}`, cut);
    if (cut.ok !== true) throw new Error(`tub cut ${index} was refused: ${String(cut.reason)}`);
  }

  const sheetMade = await call("solid_new", { name: "sheet", feature: { kind: "nurbsSurface", poles: organicPoles() } });
  brief("sheet", sheetMade);
  if (sheetMade.ok !== true) throw new Error(`sheet was refused: ${String(sheetMade.reason)}`);
  const thick = await call("model_apply", {
    object: String(sheetMade.object),
    probe: true,
    op: { kind: "thicken", thickness: 3, direction: "normal" },
  });
  brief("sheet-thicken", thick);
  if (thick.ok !== true) throw new Error(`thicken was refused: ${String(thick.reason)}`);

  // The plate commit refuses a mesh that does not close. The study measures the kernel solid, so each
  // current node is exported as brep directly (the same bytes a commit would store when the mesh closes).
  const engine = session as Session & {
    treeCall(body: Record<string, unknown>, label?: string): Promise<Reply>;
  };
  mkdirSync(outDir, { recursive: true });
  for (const obj of session.objects) {
    const volume = obj.solid?.volumeMm3;
    const faces = obj.solid?.faces?.length;
    console.log(
      `plate id=${obj.id} name=${obj.name} volumeMm3=${volume === undefined ? "" : volume.toPrecision(17)} faces=${String(faces ?? "")} editable=${String(obj.solid?.editable ?? "")}`,
    );
    const tree = obj.tree;
    if (!tree) throw new Error(`${obj.name} has no tree`);
    const reply = await engine.treeCall(exportRequest(tree.key, tree.current, "brep") as unknown as Record<string, unknown>, "export");
    if (typeof reply.bytesBase64 !== "string" || reply.bytesBase64 === "") {
      throw new Error(`${obj.name} brep export failed: ${String(reply.error ?? JSON.stringify(reply)).slice(0, 300)}`);
    }
    const bytes = Buffer.from(reply.bytesBase64, "base64");
    if (typeof reply.byteLength === "number" && bytes.length !== reply.byteLength) {
      throw new Error(`${obj.name} brep is ${bytes.length} bytes, export says ${reply.byteLength}`);
    }
    const headerEnd = bytes.indexOf(0x0a);
    const header = bytes.subarray(0, headerEnd).toString("utf8");
    if (!header.startsWith("LIMEBREP ")) throw new Error(`${obj.name} brep does not start with LIMEBREP: ${header.slice(0, 40)}`);
    const file = join(outDir, `${obj.name}.brep`);
    writeFileSync(file, bytes);
    console.log(`wrote ${file} bytes=${bytes.length} header=${header}`);
  }
  const analytic = Math.PI * 12.5 * 12.5 * 40;
  console.log(`cylinder analytic pi*12.5^2*40 = ${analytic.toPrecision(17)} mm3`);
} catch (err) {
  console.error(`FAIL ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
process.exit(exitCode);
