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
import { findLust, lustFeatures, RecipeHost } from "./recipe.ts";
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
// Silent queuing needs lust's marks of the unread applies (`--mark-unread`, lust 0.3.0).
if (!lustFeatures(lust).markUnread) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("recipe-queue: this lust has no --mark-unread (it is older than 0.3.0)");
    process.exit(1);
  }
  console.log("recipe-queue: skipped (this lust has no --mark-unread; it needs lust 0.3.0)");
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

// lust marks the call, not the line (`--mark-unread`, lust 0.3.0): of two applies on one line only the unread one
// queues; a call split over lines and indented with tabs queues at the line of its method name, at the column the call
// reports (a tab counts four); a recipe with a function of its own called `apply` still has its s.apply calls marked
// (the text scan this replaced claimed none); and an apply after text outside ASCII on its line, whose reported column
// the host does not work out, is built in its place.
const MARKS = `use lime_recipe::{ops, Json, Part, Session};

fn apply(s: &mut Session, p: &Part, x: f64) {
\ts
\t\t.apply(p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [x, 0.0, -5.0]))
\t\t.unwrap();
}

fn main() {
    let mut s = Session::start();
    let p = s.solid_new(ops::cuboid(60.0, 20.0, 10.0)).unwrap();
    s.apply(&p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [-24.0, 0.0, -5.0])).unwrap(); let r = s.apply(&p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [-12.0, 0.0, -5.0])).unwrap();
    apply(&mut s, &p, 0.0);
    apply(&mut s, &p, 12.0);
    s.log("é 日本"); s.apply(&p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [24.0, 0.0, -5.0])).unwrap();
    s.done_with(&p, Json::obj().set("read", r.get("node").is_some()));
}
`;
{
  const { on, off } = await runBoth(fake, MARKS);
  check("a recipe with its own fn apply, a split call and a mixed line runs either way", on.reply.ok === true && off.reply.ok === true, { on: on.reply, off: off.reply });
  // The unread apply of line 12 queues and is built (one boolean) when the read one beside it comes; the two calls of
  // the helper (line 5, the method name's line) queue and are built together when line 15's apply comes.
  check("the unread calls queued; the read one, and the one after text outside ASCII, did not", JSON.stringify(on.reply.queued) === JSON.stringify({ applies: 3, booleans: 2 }), on.reply.queued);
  check("the read apply got its own answer", (on.reply.metrics as R | undefined)?.read === true && JSON.stringify(on.reply.metrics) === JSON.stringify(off.reply.metrics), on.reply.metrics);
  check("the same stored ops and solid", on.ops.length === 6 && JSON.stringify(on.ops) === JSON.stringify(off.ops) && JSON.stringify(on.fingerprint) === JSON.stringify(off.fingerprint), { on: on.ops, off: off.ops });
  const marked = on.history.filter((row) => row.builtWith !== undefined);
  check("the helper's two cuts were built together", marked.length === 2, on.history);
}

// A lust that does not know --mark-unread (someone's own older build in LIME_LUST) is not asked for it: recipes run,
// each apply built in its place, and the reply says why nothing queued.
{
  const session = fake();
  const crate = fileURLToPath(new URL("../crates/lime-recipe/", import.meta.url));
  const older = new RecipeHost({ crateDir: crate, features: { markUnread: false } });
  (session as unknown as { recipeHost: RecipeHost }).recipeHost = older;
  const built = await older.build("older", CUTS, false);
  check("an older lust's build carries no marks", built.ok && built.unread === undefined, built);
  const withMarks = await new RecipeHost({ crateDir: crate }).build("older", CUTS, false);
  check("this lust's build marks the five cuts' line", withMarks.ok && JSON.stringify(withMarks.unread) === JSON.stringify([{ line: 7, col: 11 }]), withMarks.unread);
  const again = await new RecipeHost({ crateDir: crate }).build("older", CUTS, false);
  check("a program kept from an unchanged text keeps its marks", again.ok && again.exe === withMarks.exe && JSON.stringify(again.unread) === JSON.stringify(withMarks.unread), again.unread);
  const reply = (await session.call("recipe_run", { source: CUTS, name: "older" })) as R;
  check("with an older lust the recipe runs, one apply at a time", reply.ok === true && reply.queued === undefined && reply.queueHints === undefined, reply);
  check("and a note says why nothing queued", (reply.notes as string[] | undefined)?.some((n) => n.startsWith("This lust does not mark unread applies")) === true, reply.notes);
  const fresh = fake();
  const now = (await fresh.call("recipe_run", { source: CUTS, name: "older" })) as R;
  check("the same text under this lust queues again: the kept program's marks are its own", now.ok === true && JSON.stringify(now.queued) === JSON.stringify({ applies: 5, booleans: 1 }) && JSON.stringify(opsOf(fresh, String(now.object))) === JSON.stringify(opsOf(session, String(reply.object))), now);
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
  // A flush meshes only what is read. Extruded bosses, then cylinders cut into them: two booleans, and the first (no
  // primitive boolean in it, not the last) asks for no mesh. The solid, its mesh and the steps are the ones of a run
  // whose every group was meshed (the same engine, with `mesh: false` taken off each request).
  const PADS = `use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let p = s.object().expect("a sphere");
    for c in [[-12.0, -12.0], [12.0, -12.0], [-12.0, 12.0], [12.0, 12.0]] {
        s.apply(&p, Json::obj().set("kind", "extrude").set("op", "fuse").set("origin", [c[0], c[1], 50.0]).set("profile", Json::arr(vec![[-4.0, -4.0], [4.0, -4.0], [4.0, 4.0], [-4.0, 4.0]])).set("depth", 12.0)).unwrap();
        s.apply(&p, ops::boolean("cut", ops::cylinder(1.5, 8.0), [c[0], c[1], 56.0])).unwrap();
    }
    s.done_with(&p, Json::obj());
}
`;
  const meshOf = (session: Session, object: string) => {
    const solid = (session as unknown as { find(id: string): { solid?: { positions: Float32Array; triangles: Uint32Array; fingerprint: unknown } } | undefined }).find(object)?.solid;
    return solid ? JSON.stringify([solid.fingerprint, Array.from(solid.positions), Array.from(solid.triangles)]) : "none";
  };
  const padsRun = async (meshAll: boolean) => {
    const asked: boolean[] = [];
    const engine = { ...worker, modelTree: (body: string) => {
      const group = body.includes('"call":"apply"') && body.includes('"kind":"queue"');
      if (group) asked.push(body.includes('"mesh":false'));
      return worker.modelTree(meshAll ? body.replace(',"mesh":false}', "}") : body);
    } };
    const session = new Session(engine);
    const call = (n: string, a: unknown = {}) => session.call(n, a) as Promise<R>;
    const { object } = await sphere(call);
    const reply = await call("recipe_run", { source: PADS, name: "pads", object, timeoutS: 120 });
    return { reply, asked, mesh: meshOf(session, object), ops: opsOf(session, object), check: await call("model_check", { object }) };
  };
  const lean = await padsRun(false);
  const full = await padsRun(true);
  check("OCCT: pads and bores queue as two booleans", lean.reply.ok === true && JSON.stringify(lean.reply.queued) === JSON.stringify({ applies: 8, booleans: 2 }), lean.reply);
  check("OCCT: the first group asks for no mesh, the last one is meshed", JSON.stringify(lean.asked) === JSON.stringify([true, false]), lean.asked);
  check("OCCT: the same solid, mesh and steps as with every group meshed", full.reply.ok === true && lean.mesh !== "none" && lean.mesh === full.mesh && JSON.stringify(lean.ops) === JSON.stringify(full.ops), { lean: lean.mesh.length, full: full.mesh.length });
  check("OCCT: and the same model_check", JSON.stringify(lean.check) === JSON.stringify(full.check), { lean: lean.check, full: full.check });

  // The one case the guard reads the solid before a group: pieces meet along an edge at a primitive after it. Two pads
  // that share only a vertical edge (extrudes, which no guard refuses) are two unmeshed groups; the bore beside that
  // edge is a primitive boolean, and its guard asks how many such edges there were before. The step before is meshed
  // then (a goto of it, and back to the bore's), so the bore is not blamed for the pads' edge and nothing is built
  // again one by one. A dry run: a part with such an edge is not committed to the plate.
  const CORNERS = `use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let p = s.object().expect("a block");
    for c in [[-2.0, -2.0], [2.0, 2.0]] {
        s.apply(&p, Json::obj().set("kind", "extrude").set("op", "fuse").set("origin", [c[0], c[1], 8.0]).set("profile", Json::arr(vec![[-2.0, -2.0], [2.0, -2.0], [2.0, 2.0], [-2.0, 2.0]])).set("depth", 6.0)).unwrap();
    }
    s.apply(&p, ops::boolean("cut", ops::cylinder(1.2, 8.0), [-1.6, -1.6, 10.0])).unwrap();
    s.done_with(&p, Json::obj());
}
`;
  const cornersRun = async (meshAll: boolean) => {
    const seen: string[] = [];
    const engine = { ...worker, modelTree: (body: string) => {
      if (body.includes('"call":"apply"') && body.includes('"kind":"queue"')) seen.push(body.includes('"mesh":false') ? "apply unmeshed" : "apply");
      else if (body.includes('"call":"goto"') && seen.length > 0 && !seen.includes("unfold")) seen.push("goto");
      else if (body.includes('"call":"unfold"')) seen.push("unfold");
      return worker.modelTree(meshAll ? body.replace(',"mesh":false}', "}") : body);
    } };
    const session = new Session(engine);
    const call = (n: string, a: unknown = {}) => session.call(n, a) as Promise<R>;
    const object = String((await call("solid_new", { primitive: "box", dx: 40, dy: 40, dz: 10 })).object);
    const reply = await call("recipe_run", { source: CORNERS, name: "corners", object, mode: "dry", timeoutS: 120 });
    return { reply, seen };
  };
  const cornersLean = await cornersRun(false);
  const cornersFull = await cornersRun(true);
  check("OCCT: pads meeting along an edge and a bore beside it queue as three booleans, with every group meshed", cornersFull.reply.ok === true && JSON.stringify(cornersFull.reply.queued) === JSON.stringify({ applies: 3, booleans: 3 }) && cornersFull.reply.replayed === undefined && JSON.stringify(cornersFull.seen) === JSON.stringify(["apply unmeshed", "apply unmeshed", "apply", "unfold"]), cornersFull);
  check("OCCT: unmeshed, the step before the bore is meshed for its guard (a goto of it, and back)", JSON.stringify(cornersLean.seen) === JSON.stringify(["apply unmeshed", "apply unmeshed", "apply", "goto", "goto", "unfold"]), cornersLean.seen);
  check("OCCT: so the guard passes as it did, and nothing is built again one by one", cornersLean.reply.ok === true && cornersLean.reply.replayed === undefined && JSON.stringify(cornersLean.reply.queued) === JSON.stringify(cornersFull.reply.queued) && JSON.stringify(cornersLean.reply.metrics) === JSON.stringify(cornersFull.reply.metrics), cornersLean.reply);

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
