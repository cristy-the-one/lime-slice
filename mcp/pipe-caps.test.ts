/**
 * Round and point caps on both pipe-shell sweeps: a bending path with a profile, and sections along a spine.
 * The stand-in engine records the baked op. The kernel builds the dome and the tip (mcp/pipe-caps-occt.test.ts).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { validateTool } from "./schema.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-pipe-caps-"));

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}

type R = Record<string, unknown>;
const profile = [[-2, -2], [2, -2], [2, 2], [-2, 2]];
const bentPath = [[0, 0, 0], [15, 1, 0], [30, 4, 1], [45, 6, 1], [60, 4, 0]];
const callOf = (session: Session) => async (name: string, args: unknown = {}): Promise<R> => {
  try {
    return await session.call(name, args) as R;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
};

function opOf(session: Session, object: unknown, node: unknown): R | undefined {
  const obj = session.objects.find((row) => row.id === object);
  const id = typeof node === "string" ? Number(node.replace("node_", "")) : NaN;
  return obj?.tree?.nodes.get(id)?.op as R | undefined;
}

{
  const engine = fakeEngine();
  const session = new Session(engine);
  const call = callOf(session);
  const part = await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  const bent = await call("model_apply", {
    object: part.object,
    probe: true,
    op: { kind: "sweep", path: bentPath, profile, caps: "round", steps: 1 },
  });
  const stored = opOf(session, part.object, bent.node);
  const spine = stored?.spine as { kind?: string } | undefined;
  const reason = String(bent.reason ?? "");
  check(
    "a bending path with caps round builds, with no refusal",
    bent.ok === true && stored?.kind === "sweep" && spine?.kind === "spline" && stored?.capStart === "round" && stored?.capEnd === "round" && !reason.includes("cannot close"),
    { ok: bent.ok, reason: bent.reason, kind: stored?.kind, spine: spine?.kind, capStart: stored?.capStart, capEnd: stored?.capEnd },
  );
}

{
  const engine = fakeEngine();
  const session = new Session(engine);
  const call = callOf(session);
  const part = await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  const spine = { kind: "polyline", points: [[0, 0, 0], [40, 0, 0], [40, 40, 0]] };
  const sections = [{ origin: [0, 0, 0], turn: [0, 90, 0], radius: 3 }];
  const base = { kind: "sweep", sections, spine, transition: "round" };
  const both = await call("model_apply", { object: part.object, probe: true, op: { ...base, caps: "round" } });
  const start = await call("model_apply", { object: part.object, probe: true, op: { ...base, capStart: "point" } });
  const end = await call("model_apply", { object: part.object, probe: true, op: { ...base, capEnd: "round" } });
  const bothOp = opOf(session, part.object, both.node);
  const startOp = opOf(session, part.object, start.node);
  const endOp = opOf(session, part.object, end.node);
  const schemaOk = [ { ...base, caps: "round" }, { ...base, capStart: "point" }, { ...base, capEnd: "flat" } ]
    .every((op) => validateTool("model_apply", { object: "part_1", op }) === null);
  check(
    "a spine sweep accepts caps, capStart and capEnd",
    schemaOk && both.ok === true && bothOp?.capStart === "round" && bothOp?.capEnd === "round"
      && start.ok === true && startOp?.capStart === "point" && startOp?.capEnd === undefined
      && end.ok === true && endOp?.capEnd === "round" && endOp?.capStart === undefined,
    { schemaOk, both, start, end, bothOp, startOp, endOp },
  );
}

{
  const session = new Session(fakeEngine());
  const call = callOf(session);
  const part = await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  const bad = await call("model_apply", {
    object: part.object,
    probe: true,
    op: { kind: "sweep", path: bentPath, profile, caps: "dome", steps: 1 },
  });
  const reason = String(bad.reason ?? "");
  check(
    "a bad cap value is refused naming flat, round and point",
    bad.ok === false && reason.includes("flat") && reason.includes("round") && reason.includes("point"),
    bad,
  );
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("pipe caps: ok");
