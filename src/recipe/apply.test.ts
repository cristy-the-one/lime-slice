/**
 * The window's plugin run (src/recipe/apply.ts) follows the same strict rule as the MCP (7.4.0).
 * A refused queued step the recipe never reads fails the run. `//! strict: false` keeps the
 * per-step notes and one opt-out note. A nested run reads its own file. A scripted runner, no lust.
 */
import { encodeSolid } from "../model-reply.ts";
import type { AppEngine, AppRunEnv } from "./app-calls.ts";
import type { AppPluginSources } from "./app-nested.ts";
import { runPluginFresh } from "./apply.ts";
import type { RecipeCall, RunOutcome } from "./host.ts";
import type { RecipeRunner } from "./rebuild.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2500)}`);
}

const OPT_OUT = "//! strict: false is accepted through 7.4 and removed in 7.5.0: read or handle each queued step's result instead.";
const REFUSED = "A queued step was refused and the recipe never read it";
const MISSED = "The tool does not touch the part.";

const CODE = `use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let p = s.solid_new(ops::cuboid(60.0, 20.0, 10.0)).unwrap();
    s.apply_later(&p, Json::obj().set("kind", "boolean").set("op", "cut")).unwrap();
    s.done(&p);
}
`;

function lineOf(source: string, needle: string): number {
  return source.split("\n").findIndex((line) => line.includes(needle)) + 1;
}

const solid = {
  id: 1,
  ...encodeSolid({
    volumeMm3: 12000,
    positions: [0, 0, 0, 60, 0, 0, 0, 20, 0, 0, 0, 10, 60, 0, 10, 0, 20, 10],
    triangles: [0, 0],
    faces: [{ areaMm2: 1200 }, { areaMm2: 200 }],
    edges: [{ lengthMm: 60, points: [0, 0, 0, 60, 0, 0] }],
  }),
  fingerprint: { volumeMm3: 12000, faces: 2, edges: 1 },
};

let partN = 0;
const engine: AppEngine = {
  tree: async () => solid,
  open: async (request) => (request.call === "close" || request.call === "toolBox" ? {} : solid),
};
const env: AppRunEnv = {
  chordMm: 0.05,
  newPart: () => {
    partN += 1;
    return { id: `bar_${partN}`, key: `bar-tree-${partN}` };
  },
};

function stop(reason: string, calls: number): RunOutcome {
  return { ok: false, calls, refused: [], stderr: "", ms: 1, reason };
}

/** A recipe that makes a bar, queues a cut that misses it, and ends without reading the refusal. */
async function playMissed(source: string, call: RecipeCall): Promise<RunOutcome> {
  const made = await call({ id: 1, tool: "solid_new", line: lineOf(source, "solid_new"), col: 5, args: { primitive: "box", dx: 60, dy: 20, dz: 10, name: "bar" } });
  if (!made.ok) return stop(made.error, 1);
  const object = String((made.result as { object?: string }).object ?? "");
  const cut = await call({
    id: 2,
    tool: "model_apply",
    line: lineOf(source, "apply_later"),
    col: 5,
    args: { object, queue: "later", probe: true, op: { kind: "boolean", op: "cut", primitive: "box", dx: 2, dy: 2, dz: 2, origin: [1000, 0, 0] } },
  });
  if (!cut.ok) return stop(cut.error, 2);
  return { ok: true, done: { object, metrics: {} }, calls: 2, refused: [], stderr: "", ms: 1 };
}

function runnerFor(play: (name: string, call: RecipeCall) => Promise<RunOutcome>): RecipeRunner {
  return {
    build: async (name) => ({ ok: true, diagnostics: [], source: name, fixRounds: 0, exe: name, ms: 1, unread: [] }),
    run: async (exe, _start, call) => play(exe, call),
  };
}

async function fresh(id: string, body: string, plugins?: AppPluginSources) {
  return runPluginFresh({
    part: null,
    plugin: { id, version: 1, sha256: "ab", api: "1.16" },
    body,
    params: {},
    context: { bedMm: [250, 210, 220], nozzleMm: 0.4 },
    recipes: runnerFor(async (name, call) => (name === "outer" ? playOuter(call) : playMissed(nestedFiles.get(name)?.body ?? body, call))),
    engine,
    env,
    runId: "a1b2c3d4",
    ...(plugins ? { plugins } : {}),
  });
}

const pluginFile = (id: string, title: string, body: string) => [
  "//! ---",
  `//! plugin: ${id}`,
  `//! title: ${title}`,
  "//! version: 1",
  "//! description: A queued drop.",
  "//! author: Test",
  "//! api: 1.16",
  "//! target: new",
  "//! params: []",
  "//! ---",
  body,
].join("\n");

const nestedFiles = new Map<string, { title: string; body: string }>([
  ["bare-drop", { title: "Bare drop", body: CODE }],
  ["loose-drop", { title: "Loose drop", body: `//! strict: false\n${CODE}` }],
]);

function pluginSources(): AppPluginSources {
  return {
    sources: (id) => ({
      project: () => null,
      library: (version) => {
        const file = nestedFiles.get(id);
        if (!file || (version !== undefined && version !== 1)) return null;
        return { version: 1, sha256: `${id}${"ab".repeat(32)}`.slice(0, 64), text: pluginFile(id, file.title, file.body) };
      },
      olderVersions: () => [],
    }),
    untrusted: () => null,
  };
}

/** The outer recipe runs the loose plugin, then the bare one, and keeps the loose part. */
async function playOuter(call: RecipeCall): Promise<RunOutcome> {
  const loose = await call({ id: 1, tool: "plugin_run", line: 4, col: 5, args: { plugin: "loose-drop" } });
  const bare = await call({ id: 2, tool: "plugin_run", line: 6, col: 5, args: { plugin: "bare-drop" } });
  if (!bare.ok) await call({ id: 3, tool: "log", line: 7, col: 5, args: { text: bare.error } });
  if (!loose.ok) return stop(loose.error, 3);
  const object = String((loose.result as { object?: string }).object ?? "");
  return { ok: true, done: { object, metrics: {} }, calls: 3, refused: [], stderr: "", ms: 1 };
}

function reasonOf(outcome: { ok: boolean; reason?: string }): string {
  return outcome.ok ? "" : outcome.reason ?? "";
}

{
  const bare = await fresh("missed", CODE);
  const at = lineOf(CODE, "apply_later");
  const reason = reasonOf(bare);
  const buried = bare.notes.some((note) => note.includes("apply_later was refused"));
  check(
    "no header: an unread refused step fails the run, and nothing is kept",
    bare.ok === false && !buried && reason.includes(`${REFUSED}: line ${at} model_apply`) && reason.includes(MISSED) && !("kept" in bare),
    { ok: bare.ok, reason, notes: bare.notes },
  );
  const strictSource = `//! strict: true\n${CODE}`;
  const strict = await fresh("missed-strict", strictSource);
  const strictAt = lineOf(strictSource, "apply_later");
  check(
    "//! strict: true fails the run",
    strict.ok === false && reasonOf(strict).includes(`${REFUSED}: line ${strictAt} model_apply`) && !("kept" in strict),
    { ok: strict.ok, reason: reasonOf(strict), notes: strict.notes },
  );
  const opted = `  //! strict: false  \n${CODE}`;
  const loose = await fresh("missed-loose", opted);
  const looseAt = lineOf(opted, "apply_later");
  const notes = loose.notes;
  const kept = loose.ok === true && "kept" in loose && loose.kept.length === 1
    && notes.filter((note) => note === OPT_OUT).length === 1
    && notes.some((note) => note.startsWith(`line ${looseAt}: apply_later was refused (`) && note.includes(MISSED) && note.includes("s.flush(&part) reports these."));
  check("//! strict: false keeps the part, the per-step note, and one opt-out note", kept, { ok: loose.ok, reason: reasonOf(loose), notes, kept: "kept" in loose ? loose.kept.length : 0 });
}

{
  const outer = await fresh("outer", "fn main() {}\n", pluginSources());
  const notes = outer.notes;
  const follows = outer.ok === true && "kept" in outer && outer.kept.length === 1
    && notes.some((note) => note === `loose-drop: ${OPT_OUT}`)
    && notes.some((note) => note.includes(`Bare drop: ${REFUSED}`))
    && !notes.some((note) => note === OPT_OUT);
  check("a nested run follows its own header", follows, { ok: outer.ok, reason: reasonOf(outer), notes, kept: "kept" in outer ? outer.kept.length : 0 });
  const optedOuter = await fresh("outer", "//! strict: false\nfn main() {}\n", pluginSources());
  const optedNotes = optedOuter.notes;
  check(
    "an opted-out run does not opt out a nested run",
    optedOuter.ok === true && optedNotes.filter((note) => note === OPT_OUT).length === 1 && optedNotes.some((note) => note.includes(`Bare drop: ${REFUSED}`)),
    { ok: optedOuter.ok, reason: reasonOf(optedOuter), notes: optedNotes },
  );
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("apply strict: all passed");
