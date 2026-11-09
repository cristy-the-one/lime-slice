/**
 * Queued booleans in recipe_run (docs/plan-native-recipes.md 7.1, milestone 3), with real lust. Against the stand-in
 * engine: the same stored ops and solid with silent queuing on and off, a line that reads its reply builds in its place,
 * a read builds the queue first, `done` builds what is left, the explicit queue's refusals come back from `flush` with
 * their lines, and a tool refused inside a queued boolean makes the run build again one by one so the recipe sees the
 * refusal at its own line. Against real Open CASCADE when the bridge and the addon are here: fused and cut tools on a
 * sphere give the same fingerprint and History rows either way, and a cut whose box meets the sphere's but not the
 * sphere is refused at its own line after a replay. Skips without lust; LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, fakeEngine, loadEngineWorker } from "./engine.ts";
import { findLust } from "./recipe.ts";
import { Session } from "./session.ts";
import { pathTo, type ModelTree } from "../src/model-tree.ts";

const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("recipe-queue: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("recipe-queue: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-queue-"));

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
interface Internal {
  find(id: string): { tree?: ModelTree } | undefined;
}
function opsOf(session: Session, object: string): string[] {
  const tree = (session as unknown as Internal).find(object)?.tree;
  if (!tree) return [];
  return pathTo(tree, tree.current).map((id) => JSON.stringify(tree.nodes.get(id)?.op ?? null));
}
async function runBoth(make: () => Session, source: string, args: R = {}, before?: (call: (n: string, a?: unknown) => Promise<R>) => Promise<R>) {
  const out: { reply: R; ops: string[]; fingerprint: unknown; history: R[]; session: Session; object: string }[] = [];
  for (const off of [false, true]) {
    if (off) process.env.LIME_RECIPE_QUEUE = "0";
    try {
      const session = make();
      const call = (n: string, a: unknown = {}) => session.call(n, a) as Promise<R>;
      const extra = before ? await before(call) : {};
      const reply = await call("recipe_run", { source, name: "queued", timeoutS: 120, ...extra, ...args });
      const object = String(reply.object ?? extra.object ?? "");
      const described = object ? await call("model_describe", { object, limit: 1 }) : {};
      const history = object ? (((await call("model_history", { object })).nodes ?? []) as R[]) : [];
      out.push({ reply, ops: object ? opsOf(session, object) : [], fingerprint: described.fingerprint ?? null, history, session, object });
    } finally {
      delete process.env.LIME_RECIPE_QUEUE;
    }
  }
  return { on: out[0]!, off: out[1]! };
}

// --- Stand-in engine.
const fake = () => {
  const session = new Session(fakeEngine());
  session.clientName = "recipe-queue-test";
  return session;
};

// Line numbers matter below: keep the recipes' lines as they are.
const CUTS = `use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let p = s.solid_new(ops::cuboid(60.0, 20.0, 10.0)).unwrap();
    for i in 0..5 {
        s.apply(&p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [-24.0 + 12.0 * i as f64, 0.0, -5.0])).unwrap();
    }
    s.done_with(&p, Json::obj());
}
`;
{
  const { on, off } = await runBoth(fake, CUTS);
  check("five cuts whose reply is not read run with queuing on and off", on.reply.ok === true && off.reply.ok === true, { on: on.reply, off: off.reply });
  check("on: they were queued and built in one boolean", JSON.stringify(on.reply.queued) === JSON.stringify({ applies: 5, booleans: 1 }), on.reply.queued);
  check("off: nothing was queued", off.reply.queued === undefined, off.reply.queued);
  check("the same stored ops, one History step each, in the order sent", on.ops.length === 6 && JSON.stringify(on.ops) === JSON.stringify(off.ops), { on: on.ops, off: off.ops });
  check("the same solid", JSON.stringify(on.fingerprint) === JSON.stringify(off.fingerprint), { on: on.fingerprint, off: off.fingerprint });
  const marked = on.history.filter((row) => row.builtWith !== undefined);
  check("the steps built together carry builtWith, the first of them", marked.length === 5 && marked.every((row) => row.builtWith === marked[0]!.id) && off.history.every((row) => row.builtWith === undefined), on.history);
}

// The queue built at `done` is part of the run's time: runMs and the profile hold it, as the row `done`.
{
  const engine = fakeEngine();
  const inner = engine.modelTree.bind(engine);
  // The combined boolean takes 120 ms here, so the time is seen in the numbers.
  engine.modelTree = (body: string) => (body.includes('"call":"apply"') && body.includes('"kind":"group"') ? new Promise<string>((done) => setTimeout(() => done(inner(body) as string), 120)) : inner(body));
  const session = new Session(engine);
  const began = performance.now();
  const reply = (await session.call("recipe_run", { source: CUTS, name: "timed", profile: true })) as R;
  const wall = performance.now() - began;
  const profile = (reply.profile ?? {}) as { lines?: { tool: string; line: number; ms: number; calls: number }[]; split?: Record<string, number>; callsMs?: number };
  const row = profile.lines?.find((line) => line.tool === "done");
  check("the queue built at done has a profile row of its own", reply.ok === true && !!row && row.calls === 1 && row.line === 0 && row.ms >= 115, reply);
  check("runMs holds it, and stays inside the call's wall time", Number(reply.runMs) >= (row?.ms ?? Infinity) && Number(reply.runMs) <= wall + 1, { runMs: reply.runMs, wall, row });
  check("the profile's calls hold it", Number(profile.callsMs) >= (row?.ms ?? Infinity) - 1, profile);
  check("the split still adds up to runMs", Math.abs(Object.values(profile.split ?? {}).reduce((a, b) => a + b, 0) - Number(reply.runMs)) <= 1, { split: profile.split, runMs: reply.runMs });
  const plain = (await new Session(engine).call("recipe_run", { source: CUTS, name: "timed" })) as R;
  check("runMs holds it without a profile too", plain.ok === true && Number(plain.runMs) >= 115 && plain.profile === undefined, plain);
}

// A line that reads its apply's reply builds in its place; a read builds the queue first.
const READS = `use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let p = s.solid_new(ops::cuboid(60.0, 20.0, 10.0)).unwrap();
    let mut nodes = 0.0;
    for i in 0..4 {
        let r = s.apply(&p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [-24.0 + 12.0 * i as f64, 0.0, -5.0])).unwrap();
        if r.get("node").is_some() { nodes += 1.0; }
    }
    s.apply(&p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [24.0, 0.0, -5.0])).unwrap();
    let v = s.volume(&p).unwrap();
    s.done_with(&p, Json::obj().set("nodes", nodes).set("volume", v));
}
`;
{
  const { on, off } = await runBoth(fake, READS);
  check("a line that reads its reply gets its own answer", (on.reply.metrics as R | undefined)?.nodes === 4, on.reply);
  check("so its applies were built one by one, and the reply says so", (on.reply.queueHints as string[] | undefined)?.some((h) => h.startsWith("line 8 reads its apply's reply, so its 4 applies were built one by one")) === true, on.reply.queueHints);
  check("the unread apply at line 11 queued, and the volume read at line 12 saw it built", (on.reply.queued as R | undefined)?.applies === 1 && JSON.stringify(on.reply.metrics) === JSON.stringify(off.reply.metrics), { on: on.reply.metrics, off: off.reply.metrics });
  check("the same ops either way", JSON.stringify(on.ops) === JSON.stringify(off.ops));
}

// The explicit queue: apply_later holds, flush reports each refusal by its place and line; apply_now builds at once.
const EXPLICIT = `use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let p = s.solid_new(ops::cuboid(60.0, 20.0, 10.0)).unwrap();
    s.apply_later(&p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [-24.0, 0.0, -5.0])).unwrap();
    s.apply_later(&p, Json::obj().set("kind", "hole").set("origin", [0.0, 0.0, 10.0]).set("axis", [0.0, 0.0, -1.0]).set("diameterMm", 20.0).set("depth", 4.0)).unwrap();
    s.apply_later(&p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [24.0, 0.0, -5.0])).unwrap();
    let c = s.flush(&p).unwrap();
    let r = s.apply_now(&p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [12.0, 0.0, -5.0])).unwrap();
    let at = c.failures.first().map(|f| f.0 as f64).unwrap_or(-1.0);
    let line = c.lines().first().copied().unwrap_or(0) as f64;
    s.done_with(&p, Json::obj().set("applied", c.applied as f64).set("at", at).set("line", line).set("now", r.get("node").is_some()));
}
`;
{
  const session = fake();
  const r = await session.call("recipe_run", { source: EXPLICIT, name: "explicit" });
  const m = (r.metrics ?? {}) as R;
  check("flush reports the refused hole by its place among the queued ops and its line", r.ok === true && m.applied === 2 && m.at === 1 && m.line === 7, r);
  check("apply_now answers as apply does", m.now === true, m);
}

// A tool refused inside a queued boolean: the run is built again one by one, and the recipe sees it at its line.
const LATE = `use lime_recipe::{ops, Json, Session};

fn cut(s: &mut Session, p: &lime_recipe::Part, x: f64) -> bool {
    match s.apply(p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [x, 0.0, -5.0])) { Ok(_) => true, Err(e) => { s.log(&e.reason); false } }
}

fn main() {
    let mut s = Session::start();
    let p = s.solid_new(ops::cuboid(60.0, 20.0, 10.0)).unwrap();
    let mut made = 0.0;
    for x in [-24.0, -12.0, 0.0, 12.0] {
        if cut(&mut s, &p, x) { made += 1.0; }
    }
    s.done_with(&p, Json::obj().set("made", made));
}
`;
{
  process.env.LIME_MCP_FAKE_QUEUE_MISS = "-12";
  const { on, off } = await runBoth(fake, LATE).finally(() => { delete process.env.LIME_MCP_FAKE_QUEUE_MISS; });
  check("the run with a refusal inside a queued boolean still runs", on.reply.ok === true, on.reply);
  check("it was built again one by one, naming the line", JSON.stringify(on.reply.replayed) === JSON.stringify({ line: 4 }) && (on.reply.notes as string[] | undefined)?.some((n) => n.startsWith("Built one by one: the tool at line 4 was refused inside a queued boolean")) === true, on.reply);
  check("the recipe saw the refusal at its own line, as with queuing off", JSON.stringify(on.reply.metrics) === JSON.stringify({ made: 3 }) && JSON.stringify(on.reply.metrics) === JSON.stringify(off.reply.metrics) && (on.reply.notes as string[]).includes("line 4: The cut does not change the part."), { on: on.reply, off: off.reply });
  check("and left the same steps", JSON.stringify(on.ops) === JSON.stringify(off.ops), { on: on.ops, off: off.ops });
}

// A cancel that comes while the queue is built after `done` takes the whole run back, as a cancel during the run does.
{
  process.env.LIME_MCP_REPLY_S = "0.05";
  process.env.LIME_MCP_FAKE_MODEL_MS = "150";
  try {
    const session = fake();
    // Ten overlapping fuses: ten booleans, about three seconds of stand-in kernel time after done.
    const SLOW = `use lime_recipe::{ops, Session};
fn main() {
    let mut s = Session::start();
    let p = s.solid_new(ops::cuboid(10.0, 10.0, 2.0)).unwrap();
    for _ in 0..10 { s.apply(&p, ops::boolean("fuse", ops::cuboid(1.0, 1.0, 1.0), [0.0, 0.0, 2.0])).unwrap(); }
    s.done(&p);
}
`;
    const job = await session.call("recipe_run", { name: "slow-flush", source: SLOW, timeoutS: 60 });
    check("a slow queued run goes on as a job", job.status === "running" && typeof job.job === "string", job);
    const stage = () => String(session.workJobs.find((row) => row.handle === job.job)?.ctx.stage ?? "");
    for (let i = 0; i < 400 && !stage().includes("queued applies"); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    check("the queue is being built after done", stage().includes("building 10 queued applies"), stage());
    let cancelled = await session.call("slice_cancel", { job: job.job });
    while (cancelled.status === "cancelling") cancelled = await session.call("slice_wait", { job: job.job, timeoutS: 1 });
    check("a cancel during the queue's build fails the run as cancelled", cancelled.ok === false && String(cancelled.reason).includes("cancelled"), cancelled);
    check("and keeps nothing", session.objects.length === 0, session.objects.map((o) => o.id));
  } finally {
    delete process.env.LIME_MCP_REPLY_S;
    delete process.env.LIME_MCP_FAKE_MODEL_MS;
  }
}

// --- Real Open CASCADE.
const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
if (!bridge || !existsSync(bridge) || !addon) {
  if (process.env.LIME_RECIPE_REQUIRED === "1" && process.env.LIME_QUEUE_OCCT === "1") {
    console.error("recipe-queue: LIME_OCCT_BRIDGE and the MCP addon are required here");
    process.exit(1);
  }
  console.log("recipe-queue: the real Open CASCADE part skipped (needs LIME_OCCT_BRIDGE and lime-mcp-engine)");
} else {
  process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "60";
  const worker = loadEngineWorker(root);
  const real = () => new Session(worker);
  const sphere = async (call: (n: string, a?: unknown) => Promise<R>) => ({ object: String((await call("solid_new", { primitive: "sphere", radius: 30 })).object) });
  // Four bosses on the sphere's top, a cap fused on each, and a bore through each cap: three booleans when queued.
  const BOSSES = `use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let p = s.object().expect("a sphere");
    for i in 0..4 {
        let x = if i % 2 == 0 { -10.0 } else { 10.0 };
        let y = if i < 2 { -10.0 } else { 10.0 };
        s.apply(&p, ops::boolean("fuse", ops::cylinder(4.0, 25.0), [x, y, 40.0])).unwrap();
        s.apply(&p, ops::boolean("fuse", ops::cylinder(2.5, 4.0), [x, y, 64.0])).unwrap();
        s.apply(&p, ops::boolean("cut", ops::cylinder(1.0, 10.0), [x, y, 60.0])).unwrap();
    }
    s.done_with(&p, Json::obj());
}
`;
  const { on, off } = await runBoth(real, BOSSES, {}, sphere);
  check("OCCT: twelve applies run with queuing on and off", on.reply.ok === true && off.reply.ok === true, { on: on.reply, off: off.reply });
  check("OCCT: queued, they took three booleans", JSON.stringify(on.reply.queued) === JSON.stringify({ applies: 12, booleans: 3 }), on.reply.queued);
  const fp = (v: unknown) => v as { volumeMm3: number; faces: number; edges: number } | null;
  const a = fp(on.fingerprint);
  const b = fp(off.fingerprint);
  check("OCCT: the same faces and edges, and the volume to 1e-9", !!a && !!b && a.faces === b.faces && a.edges === b.edges && Math.abs(a.volumeMm3 - b.volumeMm3) <= 1e-9 * b.volumeMm3, { on: a, off: b });
  check("OCCT: the same History rows, in the order sent", JSON.stringify(on.ops) === JSON.stringify(off.ops) && on.ops.length === 13, { on: on.ops.length, off: off.ops.length });
  // Rebuilding a middle step from the steps before it gives that step's solid, as a rebuild does.
  const mid = on.history.find((row) => row.builtWith !== undefined && row.current !== true);
  const shown = mid ? await on.session.call("model_goto", { object: on.object, node: mid.id }) : null;
  check("OCCT: going to a step built inside a group builds it", shown?.ok === true, shown);

  // An extruded cut whose box meets the sphere's box but not the sphere: refused alone ("does not change the part");
  // inside a queued boolean it is found by its faces, and the run is built again. (A plain boolean that misses is an
  // ordinary step either way.)
  const CORNER = `use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let p = s.object().expect("a sphere");
    let mut made = 0.0;
    for c in [[0.0, 0.0, 55.0], [24.0, 24.0, 52.0], [0.0, 0.0, -5.0]] {
        match s.apply(&p, Json::obj().set("kind", "extrude").set("op", "cut").set("origin", c).set("profile", Json::arr(vec![[-3.0, -3.0], [3.0, -3.0], [3.0, 3.0], [-3.0, 3.0]])).set("depth", 6.0)) { Ok(_) => made += 1.0, Err(e) => s.log(&e.reason) }
    }
    s.done_with(&p, Json::obj().set("made", made));
}
`;
  const late = await runBoth(real, CORNER, {}, sphere);
  check("OCCT: the corner cut was built again one by one and refused at its line", late.on.reply.ok === true && JSON.stringify(late.on.reply.replayed) === JSON.stringify({ line: 8 }) && JSON.stringify(late.on.reply.metrics) === JSON.stringify({ made: 2 }), late.on.reply);
  check("OCCT: as with queuing off", JSON.stringify(late.on.reply.metrics) === JSON.stringify(late.off.reply.metrics) && JSON.stringify(late.on.ops) === JSON.stringify(late.off.ops), { on: late.on.reply, off: late.off.reply });
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("recipe-queue: all passed");
process.exit(0);
