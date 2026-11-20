/**
 * A ribs_plan with two load cases and a frequency goal, applied through the MCP stand-in (fakeEngine plus the
 * deterministic planner), saved as a project. The spec opens that project and reopens the History row.
 * The solid the wall is read on is the synthetic open box (face 6 is the inner floor), never a customer part.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePlanSource, type PlanJob } from "../src/auto-ribs-plan.ts";
import { fakeEngine } from "../mcp/engine.ts";
import { Session } from "../mcp/session.ts";

type V3 = [number, number, number];

/** The open box mcp/ribs-load-request.test.ts plans on. Face 6 is the inner floor. */
function openBox(): { positions: Float32Array; triangles: Uint32Array } {
  const pos: number[] = [];
  const face: number[] = [];
  const quad = (f: number, a: V3, b: V3, c: V3, d: V3, want: V3) => {
    const tri = (p: V3, q: V3, r: V3) => {
      const u: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const v: V3 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) [q, r] = [r, q];
      pos.push(...p, ...q, ...r);
      face.push(f);
    };
    tri(a, b, c);
    tri(a, c, d);
  };
  const X = 40;
  const Y = 24;
  const Z = 12;
  const t = 2;
  quad(0, [0, 0, 0], [X, 0, 0], [X, Y, 0], [0, Y, 0], [0, 0, -1]);
  quad(6, [t, t, t], [X - t, t, t], [X - t, Y - t, t], [t, Y - t, t], [0, 0, 1]);
  quad(2, [0, 0, 0], [0, Y, 0], [0, Y, Z], [0, 0, Z], [-1, 0, 0]);
  quad(3, [X, 0, 0], [X, Y, 0], [X, Y, Z], [X, 0, Z], [1, 0, 0]);
  quad(4, [0, 0, 0], [X, 0, 0], [X, 0, Z], [0, 0, Z], [0, -1, 0]);
  quad(5, [0, Y, 0], [X, Y, 0], [X, Y, Z], [0, Y, Z], [0, 1, 0]);
  quad(8, [t, t, t], [t, Y - t, t], [t, Y - t, Z], [t, t, Z], [1, 0, 0]);
  quad(9, [X - t, t, t], [X - t, Y - t, t], [X - t, Y - t, Z], [X - t, t, Z], [-1, 0, 0]);
  quad(10, [t, t, t], [X - t, t, t], [X - t, t, Z], [t, t, Z], [0, 1, 0]);
  quad(11, [t, Y - t, t], [X - t, Y - t, t], [X - t, Y - t, Z], [t, Y - t, Z], [0, -1, 0]);
  const up: V3 = [0, 0, 1];
  quad(1, [0, 0, Z], [X, 0, Z], [X - t, t, Z], [t, t, Z], up);
  quad(1, [X, 0, Z], [X, Y, Z], [X - t, Y - t, Z], [X - t, t, Z], up);
  quad(1, [X, Y, Z], [0, Y, Z], [t, Y - t, Z], [X - t, Y - t, Z], up);
  quad(1, [0, Y, Z], [0, 0, Z], [t, t, Z], [t, Y - t, Z], up);
  return { positions: Float32Array.from(pos), triangles: Uint32Array.from(face) };
}

/** fakeEngine has no rib planner. This one is the same stand-in the Auto ribs card uses in the browser. */
function withPlanner(engine: ReturnType<typeof fakeEngine>): ReturnType<typeof fakeEngine> {
  const jobs = new Map<number, { job: PlanJob; events: unknown[] }>();
  let next = 1;
  engine.ribPlanStart = (body: string) => {
    const id = next;
    next += 1;
    const events: unknown[] = [];
    const job = fakePlanSource(() => ({ tickMs: 0 })).start(JSON.parse(body) as never, (event) => {
      events.push(event);
    });
    jobs.set(id, { job, events });
    return JSON.stringify({ id });
  };
  engine.ribPlanPoll = async (id: string) => {
    const row = jobs.get(Number(id));
    if (!row) return JSON.stringify({ error: "That plan is not running." });
    const reply = await row.job.done;
    const events = row.events.splice(0);
    if (!reply.ok) return JSON.stringify({ status: "done", events, result: { ok: false, reason: reply.reason } });
    return JSON.stringify({ status: "done", events, fraction: 1, stage: "done", result: { ok: true, ...reply.plan } });
  };
  engine.ribPlanCancel = (id: string) => {
    jobs.get(Number(id))?.job.cancel();
    return JSON.stringify({ ok: true });
  };
  return engine;
}

export const REOPEN_CASES = ["spread", "point"] as const;
export const REOPEN_FREQUENCY = 1.3;

/** Plan, apply, and save. The History row's source.auto is the ribs_plan request. */
export async function plannedProject(): Promise<Buffer> {
  process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-ribs-reopen-"));
  const engine = withPlanner(fakeEngine());
  const box = openBox();
  // The stand-in builds a group without the rib mesh. Hand the wall's own mesh back, so the outside check
  // sees the part unchanged and the History row is kept. The request on that row is the one ribs_plan stored.
  const modelTree = engine.modelTree.bind(engine);
  engine.modelTree = async (body: string) => {
    const text = await modelTree(body);
    let call: { call?: string; op?: { kind?: string; source?: { kind?: string } } } = {};
    try {
      call = JSON.parse(body) as typeof call;
    } catch {
      return text;
    }
    if (call.call !== "apply" || call.op?.kind !== "group" || call.op.source?.kind !== "ribNet") return text;
    const reply = JSON.parse(text) as { positions?: string; triangles?: string; error?: string };
    if (reply.error) return text;
    reply.positions = Buffer.from(box.positions.buffer, box.positions.byteOffset, box.positions.byteLength).toString("base64");
    reply.triangles = Buffer.from(box.triangles.buffer, box.triangles.byteOffset, box.triangles.byteLength).toString("base64");
    return JSON.stringify(reply);
  };
  const session = new Session(engine);
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const reply = (await session.call(name, input)) as Record<string, unknown>;
    if (reply.ok === false) throw new Error(`${name}: ${JSON.stringify(reply)}`);
    return reply;
  };
  const made = await call("solid_new", { primitive: "box", dx: 40, dy: 24, dz: 12 });
  const id = String(made.object);
  const solid = session.find(id)?.solid;
  if (!solid) throw new Error("solid_new left no solid");
  solid.positions = box.positions;
  solid.triangles = box.triangles;
  const request = {
    object: id,
    wall: { faces: [6] },
    loadCases: [
      { name: "spread", weight: 1, loads: [{ kind: "pressure", faces: [6], magnitude: 0.01, direction: [0, 0, -1] }] },
      { name: "point", weight: 2, loads: [{ kind: "force", faces: [6], magnitude: 10, direction: [0, 0, -1] }] },
    ],
    goal: { frequency: REOPEN_FREQUENCY },
  };
  const planned = await call("ribs_plan", request);
  const job = String(planned.job);
  let done: Record<string, unknown> = planned;
  for (;;) {
    const reply = await call("slice_wait", { job, timeoutS: 5 });
    if (reply.status !== "running") {
      done = reply;
      break;
    }
  }
  if (done.ok !== true && done.status !== "done") throw new Error(`ribs_plan: ${JSON.stringify(done).slice(0, 500)}`);
  const applied = await call("ribs_apply", { job, object: id });
  if (applied.ok !== true) throw new Error(`ribs_apply: ${JSON.stringify(applied).slice(0, 500)}`);
  const saved = await call("project_save", { name: "ribs-reopen.lime" });
  return readFileSync(String(saved.path));
}
