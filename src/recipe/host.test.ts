/**
 * The shared recipe host (src/recipe/host.ts) over a scripted transport: no lust and no process. The script plays the
 * recipe's side of protocol v1, so the same run loop the MCP server and the app use is checked call for call.
 */
import { applyAllEdits, applyAutoEdits, buildRecipe, memorySentence, parseDiagnostics, RECIPE_MEMORY_BYTES, rewriteOf, runRecipe, utf8Bytes, type CompileResult, type RecipeCallSite, type RecipeProcessEvents, type RecipeReply, type RecipeSpawn } from "./host.ts";

let failed = 0;
function check(name: string, cond: boolean, detail: unknown = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

/**
 * A scripted recipe: `script` gets each line the host writes and answers with lines of its own (or an exit). The
 * process's writes are recorded; `exit` ends it the way a real process does, after its output.
 */
function scripted(script: (line: string, io: { say(line: string): void; exit(code: number | null, reason?: string): void; stderr(text: string): void }) => void) {
  const written: string[] = [];
  let killed = 0;
  let closed = 0;
  const spawn: RecipeSpawn = (events: RecipeProcessEvents) => {
    let ended = false;
    const io = {
      say: (line: string) => setTimeout(() => !ended && events.stdout(`${line}\n`), 0),
      exit: (code: number | null, reason?: string) => setTimeout(() => {
        if (ended) return;
        ended = true;
        events.exit(code, reason);
      }, 1),
      stderr: (text: string) => setTimeout(() => events.stderr(text), 0),
    };
    return {
      write: (line) => {
        written.push(line);
        script(line, io);
      },
      closeInput: () => {
        closed += 1;
        io.exit(0);
      },
      kill: () => {
        killed += 1;
        io.exit(null);
      },
    };
  };
  return { spawn, written, killed: () => killed, closed: () => closed };
}

const ok = async (site: RecipeCallSite): Promise<RecipeReply> => (site.tool === "solid_new" ? { ok: true, result: { ok: true, object: "obj_1" } } : { ok: true, result: { ok: true, id: site.id } });

{
  const abort = new AbortController();
  abort.abort();
  const p = scripted(() => {});
  const out = await runRecipe(p.spawn, {}, ok, undefined, abort.signal);
  check("an already-cancelled recipe stops without starting", out.reason === "The recipe was cancelled." && p.written.length === 0 && p.killed() === 1, out);
}

// Progress is an out-of-band message: it is bounded and does not consume a call or need a reply.
{
  const seen: [number, string][] = [];
  const p = scripted((_line, io) => {
    io.say(JSON.stringify({ progress: { fraction: 1.5, message: "axle 41" } }));
    io.say(JSON.stringify({ done: { object: "", metrics: {} } }));
  });
  const out = await runRecipe(p.spawn, {}, ok, undefined, undefined, (fraction, message) => seen.push([fraction, message]));
  check("recipe progress reaches the caller without a tool call", out.ok && out.calls === 0 && JSON.stringify(seen) === '[[1,"axle 41"]]', { out, seen });
}

// --- A whole run: the start line, two calls, a refusal with its hint, a note, a late parameter, done.
{
  const seen: RecipeCallSite[] = [];
  const p = scripted((line, io) => {
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (msg.v === 1) {
      io.say(JSON.stringify({ id: 1, call: "solid_new", args: { kind: "box" }, at: { line: 4 } }));
      return;
    }
    if (msg.id === 1) {
      io.say(JSON.stringify({ note: "width held at 200" }));
      io.say(JSON.stringify({ late_param: { name: "late", line: 9 } }));
      io.say(JSON.stringify({ id: 2, call: "model_apply", args: { object: "obj_1", op: { kind: "fillet" } }, at: { line: 7 } }));
      return;
    }
    if (msg.id === 2) io.say(JSON.stringify({ done: { object: "obj_1", metrics: { volumeMm3: 8 } } }));
  });
  const out = await runRecipe(p.spawn, { params: { width: 200 }, context: { units: "mm" } }, async (site) => {
    seen.push(site);
    if (site.id === 2) return { ok: false, error: "A blend of 1 mm does not fit.", extra: { maxMm: 0.4 } };
    return ok(site);
  });
  check("the run reached done", out.ok && out.done?.object === "obj_1", out);
  check("the start line is v1 with params and context", JSON.parse(p.written[0]!).v === 1 && JSON.parse(p.written[0]!).params.width === 200, p.written[0]);
  check("each call reached the caller with its line", seen.length === 2 && seen[0]!.tool === "solid_new" && seen[0]!.line === 4 && seen[1]!.line === 7, seen);
  check("the reply carries the result", JSON.parse(p.written[1]!).result.object === "obj_1", p.written[1]);
  const refusal = JSON.parse(p.written[2]!) as Record<string, unknown>;
  check("a refusal carries its hint fields and the error", refusal.ok === false && refusal.maxMm === 0.4 && refusal.id === 2, refusal);
  check("the refused call is listed with its line", out.refused.length === 1 && out.refused[0]!.line === 7, out.refused);
  check("notes and late parameters are kept", out.notes?.[0] === "width held at 200" && out.lateParams?.[0]?.name === "late", out);
  check("done closes the recipe's input", p.closed() === 1);
  check("two calls counted", out.calls === 2, out.calls);
}

// --- A call outside the allowlist is refused by the host, and the caller never sees it.
{
  let asked = 0;
  const p = scripted((line, io) => {
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (msg.v === 1) io.say(JSON.stringify({ id: 1, call: "gcode_export", args: {}, at: { line: 3 } }));
    else io.say(JSON.stringify({ done: { object: "", metrics: {} } }));
  });
  const out = await runRecipe(p.spawn, {}, async (site) => {
    asked += 1;
    return ok(site);
  });
  check("a call outside the allowlist is refused", out.refused[0]?.reason.startsWith("gcode_export is not a recipe call") === true, out.refused);
  check("the caller was not asked", asked === 0);
}

// --- Animation calls are isolated from model-editing recipe calls.
{
  const seen: string[] = [];
  const p = scripted((line, io) => {
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (msg.v === 1) io.say(JSON.stringify({ id: 1, call: "rig", args: {}, at: { line: 3 } }));
    else if (msg.id === 1) io.say(JSON.stringify({ id: 2, call: "model_apply", args: {}, at: { line: 7 } }));
    else if (msg.id === 2) io.say(JSON.stringify({ id: 3, call: "animate", args: {}, at: { line: 9 } }));
    else io.say(JSON.stringify({ done: { object: "", metrics: {} } }));
  });
  const out = await runRecipe(p.spawn, { kind: "animation" }, async (site) => { seen.push(site.tool); return ok(site); });
  check("animation permits rig and animate only", seen.join(",") === "rig,animate", seen);
  check("animation refuses model edits at their line", out.refused[0]?.reason === "An animation can only pose the assembly it was given." && out.refused[0]?.line === 7, out.refused);
  const normal = scripted((line, io) => {
    if (JSON.parse(line).v === 1) io.say(JSON.stringify({ id: 1, call: "rig", args: {}, at: { line: 4 } }));
    else io.say(JSON.stringify({ done: { object: "", metrics: {} } }));
  });
  const ordinary = await runRecipe(normal.spawn, {}, async (site) => { seen.push(site.tool); return ok(site); });
  check("ordinary recipes cannot call rig", ordinary.refused[0]?.reason.startsWith("rig is not a recipe call") === true && seen.length === 2, ordinary.refused);
}

// --- A panic names its line; an exit without done says so.
{
  const p = scripted((line, io) => {
    if (JSON.parse(line).v === 1) {
      io.stderr("thread 'main' (42) panicked at src\\main.rs:12:5:\r\nwidth must be positive\r\n");
      io.exit(101);
    }
  });
  const out = await runRecipe(p.spawn, {}, ok);
  check("a panic is the reason, with its line", !out.ok && out.line === 12 && out.reason === "The recipe panicked at line 12: width must be positive", out);
  const q = scripted((line, io) => {
    if (JSON.parse(line).v === 1) io.exit(3);
  });
  const quiet = await runRecipe(q.spawn, {}, ok);
  check("an exit without done", quiet.reason === "The recipe ended without done (exit 3).", quiet.reason);
}

// --- Limits: wall time, calls, a long line, a line that is not JSON.
{
  const p = scripted(() => {});
  const out = await runRecipe(p.spawn, {}, ok, { timeoutS: 0.05, maxCalls: 10, maxLineBytes: 1000 });
  check("the time limit stops and kills the recipe", out.reason === "The recipe ran past its 0.05 s limit and was stopped." && p.killed() === 1, out.reason);

  const many = scripted((line, io) => {
    const msg = JSON.parse(line) as { v?: number; id?: number };
    const next = msg.v === 1 ? 1 : (msg.id ?? 0) + 1;
    io.say(JSON.stringify({ id: next, call: "model_describe", args: {}, at: { line: next } }));
  });
  const capped = await runRecipe(many.spawn, {}, ok, { timeoutS: 5, maxCalls: 3, maxLineBytes: 1000 });
  check("the call limit stops the recipe at the fourth call", capped.reason === "The recipe made more than 3 calls and was stopped." && capped.line === 4, capped);

  const long = scripted((line, io) => {
    if (JSON.parse(line).v === 1) io.say(`{"note":"${"x".repeat(2000)}"}`);
  });
  const big = await runRecipe(long.spawn, {}, ok, { timeoutS: 5, maxCalls: 10, maxLineBytes: 1000 });
  check("a line past the byte limit stops the recipe", big.reason === "A recipe line passed 1000 bytes.", big.reason);

  const junk = scripted((line, io) => {
    if (JSON.parse(line).v === 1) io.say("hello");
  });
  const bad = await runRecipe(junk.spawn, {}, ok);
  check("a line that is not JSON stops the recipe", bad.reason === "The recipe wrote a line that is not JSON: hello", bad.reason);
}

// --- lust's memory limit (`--max-memory`, built into the program): exit code 101 and lust's line read as the app's
// sentence, with the limit lust printed; a sandbox stop of another family keeps lust's own line.
{
  const p = scripted((line, io) => {
    if (JSON.parse(line).v === 1) {
      io.stderr("1008 MB\nerror[L0532]: this program was built with --max-memory 1073741824 and tried to use more memory\n");
      io.exit(101);
    }
  });
  const out = await runRecipe(p.spawn, {}, ok);
  check("lust's memory stop reads as the app's sentence", !out.ok && out.exitCode === 101 && out.reason === "The recipe used more than 1024 MB of memory and was stopped." && out.reason === memorySentence(RECIPE_MEMORY_BYTES), out);
  const small = scripted((line, io) => {
    if (JSON.parse(line).v === 1) {
      io.stderr("error[L0532]: this program was built with --max-memory 67108864 and tried to use more memory\n");
      io.exit(101);
    }
  });
  check("the megabytes are the limit the program was built with", (await runRecipe(small.spawn, {}, ok)).reason === "The recipe used more than 64 MB of memory and was stopped.");
  const net = scripted((line, io) => {
    if (JSON.parse(line).v === 1) {
      io.stderr("error[L0532]: this program was built with --sandbox and tried to use the network\n");
      io.exit(101);
    }
  });
  check("another sandbox stop keeps lust's line", (await runRecipe(net.spawn, {}, ok)).reason === "error[L0532]: this program was built with --sandbox and tried to use the network");
  const echoed = scripted((line, io) => {
    if (JSON.parse(line).v === 1) {
      io.stderr("error[L0532]: this program was built with --max-memory 1 and tried to use more memory\n");
      io.exit(3);
    }
  });
  check("the words alone, without lust's exit code, are not a memory stop", (await runRecipe(echoed.spawn, {}, ok)).reason?.startsWith("error[L0532]") === true);
}

// --- The runner's own stop (a memory cap) is the reason; a cancel is too.
{
  const p = scripted((line, io) => {
    if (JSON.parse(line).v === 1) io.exit(null, "The recipe used more than 1024 MB of memory and was stopped.");
  });
  const out = await runRecipe(p.spawn, {}, ok);
  check("the runner's reason is the run's", out.reason === "The recipe used more than 1024 MB of memory and was stopped.", out.reason);

  const abort = new AbortController();
  const q = scripted(() => {});
  const pending = runRecipe(q.spawn, {}, ok, { timeoutS: 5, maxCalls: 10, maxLineBytes: 1000 }, abort.signal);
  abort.abort();
  const cancelled = await pending;
  check("a cancel stops the recipe", cancelled.reason === "The recipe was cancelled." && q.killed() === 1, cancelled.reason);
}

// --- A halt ends the run after a call without a failure (I23).
{
  const p = scripted((line, io) => {
    if (JSON.parse(line).v === 1) io.say(JSON.stringify({ id: 1, call: "model_apply", args: {}, at: { line: 5 } }));
  });
  const out = await runRecipe(p.spawn, {}, async () => ({ ok: true, result: {}, halt: "The run stopped after 1 applied op." }));
  check("a halt is kept with its line", out.halted?.line === 5 && out.halted.id === 1 && !out.ok, out);
}

// --- Describe mode: parameters in order, the object read, the end at the first call.
{
  const p = scripted((line, io) => {
    if (JSON.parse(line).v !== 1) return;
    io.say(JSON.stringify({ describe: { param: { name: "width", kind: "number", default: 60 }, line: 3 } }));
    io.say(JSON.stringify({ describe: { object: true } }));
    io.say(JSON.stringify({ describe: { end: true, line: 8 } }));
  });
  const out = await runRecipe(p.spawn, { describe: true }, ok);
  check("describe mode lists the parameters", out.ok && out.described?.params[0]?.name === "width" && out.described.params[0]!.line === 3, out.described);
  check("describe mode saw the object read and its end", out.described?.readObject === true && out.described.ended && out.described.line === 8, out.described);
  check("describe mode's end kills the recipe", p.killed() === 1);
}

// --- Builds: auto fix rounds through a scripted compiler, ingredients never edited.
{
  const main = "/slots/slot-0/src/main.rs";
  const fixLine = (start: number, end: number, replacement: string, line = 1) => JSON.stringify({ kind: "diagnostic", severity: "error", code: "L0110", message: "expected f64", file: main, span: { line, col: 1 }, fix: "write 60.0", edits: [{ start, end, replacement, auto: true }] });
  const texts: string[] = [];
  const compile = async (text: string): Promise<CompileResult> => {
    texts.push(text);
    const at = text.indexOf("= 60;");
    if (at >= 0) return { code: 1, stdout: `${fixLine(at + 2, at + 4, "60.0")}\n`, stderr: "", main };
    return { code: 0, stdout: "", stderr: "", exe: "/slots/slot-0/recipe", main };
  };
  const built = await buildRecipe(compile, "let w: f64 = 60;\n", true);
  check("one auto fix round, then a build", built.ok && built.fixRounds === 1 && built.source === "let w: f64 = 60.0;\n" && built.exe === "/slots/slot-0/recipe", built);
  const plain = await buildRecipe(compile, "let w: f64 = 60;\n", false);
  check("without autofix the diagnostics come back", !plain.ok && plain.diagnostics[0]?.code === "L0110" && plain.diagnostics[0].edits.length === 1, plain);

  const suffixed: string[] = [];
  const inSuffix = async (text: string): Promise<CompileResult> => {
    suffixed.push(text);
    const at = text.indexOf("= 60;");
    return { code: 1, stdout: `${fixLine(at + 2, at + 4, "60.0", 3)}\n`, stderr: "", main };
  };
  const kept = await buildRecipe(inSuffix, "fn main() {}", true, "mod ing {\n  let w: f64 = 60;\n}\n");
  check("the source gets a newline before its ingredients", suffixed[0] === "fn main() {}\nmod ing {\n  let w: f64 = 60;\n}\n", suffixed[0]);
  check("an edit inside the ingredients is never applied", !kept.ok && kept.fixRounds === 0 && kept.diagnostics[0]!.edits.length === 0 && kept.source === "fn main() {}", kept);

  const broken = await buildRecipe(async () => ({ code: 2, stdout: "", stderr: "lust-core crashed\n", main }), "fn main() {}\n", true);
  check("a build with no diagnostics says what lust said", broken.reason === "lust failed: lust-core crashed", broken.reason);
}

// --- Rewrites for rejects (lust 0.3.0): edits that are not `auto`. Shown as the lines they would become; applied only
// when asked (`autofix: "all"`), the edits of one diagnostic together, an ingredient never touched.
{
  const main = "/slots/slot-0/src/main.rs";
  const diag = (code: string, line: number, edits: { start: number; end: number; replacement: string; auto: boolean }[]) => JSON.stringify({ kind: "diagnostic", severity: "error", code, message: "rejected", file: main, span: { line, col: 1 }, fix: "write it the other way", edits });
  const source = "#![no_implicit_prelude]\nstatic F: fn(f64) -> f64 = |x| x * 2.0;\nfn main() { let w: f64 = 60; }\n";
  // A stand-in for lust: one reject a round, in the order lust's phases find them, with the edits lust carries.
  const compile = async (text: string): Promise<CompileResult> => {
    const prelude = text.indexOf("#![no_implicit_prelude]\n");
    if (prelude >= 0) return { code: 1, stdout: diag("L0522", 1, [{ start: prelude, end: prelude + 24, replacement: "", auto: false }]), stderr: "", main };
    const closure = text.indexOf("|x| x * 2.0");
    if (closure >= 0) return { code: 1, stdout: diag("L0630", text.slice(0, closure).split("\n").length, [{ start: closure, end: closure + 11, replacement: "f_fn", auto: false }, { start: closure + 12, end: closure + 12, replacement: "\n\nfn f_fn(x: f64) -> f64 { x * 2.0 }", auto: false }]), stderr: "", main };
    const int = text.indexOf("= 60;");
    if (int >= 0) return { code: 1, stdout: diag("L0110", text.slice(0, int).split("\n").length, [{ start: int + 2, end: int + 4, replacement: "60.0", auto: true }]), stderr: "", main };
    return { code: 0, stdout: "", stderr: "", exe: "/slots/slot-0/recipe", main };
  };
  const shown = await buildRecipe(compile, source, true);
  check("a reject's rewrite is not applied by the safe fixes", !shown.ok && shown.source === source && shown.fixRounds === 0 && shown.rewrote === undefined, shown);
  check("it comes back as the lines to put in place: the attribute's line goes", JSON.stringify(shown.diagnostics[0]!.rewrite) === JSON.stringify({ line: 1, lines: 1, with: [] }), shown.diagnostics[0]);
  const second = await buildRecipe(compile, source.slice(24), false);
  check("a rewrite of two edits is one change of whole lines", JSON.stringify(second.diagnostics[0]!.rewrite) === JSON.stringify({ line: 1, lines: 1, with: ["static F: fn(f64) -> f64 = f_fn;", "", "fn f_fn(x: f64) -> f64 { x * 2.0 }"] }), second.diagnostics[0]);
  const all = await buildRecipe(compile, source, "all");
  check("autofix all applies the rewrites and the safe fix, a round each", all.ok && all.fixRounds === 3 && all.source === "static F: fn(f64) -> f64 = f_fn;\n\nfn f_fn(x: f64) -> f64 { x * 2.0 }\nfn main() { let w: f64 = 60.0; }\n", all);
  check("and names the rejects it rewrote, not the safe fix", JSON.stringify(all.rewrote) === JSON.stringify(["L0522", "L0630"]), all.rewrote);
  const auto = await buildRecipe(compile, "fn main() { let w: f64 = 60; }\n", true);
  check("a safe fix alone names no rewrite and shows none", auto.ok && auto.rewrote === undefined && auto.fixRounds === 1, auto);
  const inIngredient = await buildRecipe(compile, "fn main() {}\n", "all", source);
  check("a rewrite inside an ingredient is neither applied nor shown", !inIngredient.ok && inIngredient.source === "fn main() {}\n" && inIngredient.diagnostics[0]!.rewrite === undefined && inIngredient.rewrote === undefined, inIngredient);

  // The edits of one diagnostic go together or not at all; a diagnostic that meets one already taken waits a round.
  const text = "aaa bbb ccc\n";
  const one = { code: "A", message: "", line: 1, col: 1, fix: "", edits: [{ start: 0, end: 3, replacement: "x", auto: false }, { start: 8, end: 11, replacement: "z", auto: false }] };
  const meets = { code: "B", message: "", line: 1, col: 5, fix: "", edits: [{ start: 4, end: 7, replacement: "y", auto: false }, { start: 9, end: 10, replacement: "!", auto: false }] };
  const apart = { code: "C", message: "", line: 1, col: 5, fix: "", edits: [{ start: 4, end: 7, replacement: "y", auto: true }] };
  check("edits that meet are left for the next round, whole", JSON.stringify(applyAllEdits(text, [one, meets, apart, one])) === JSON.stringify({ source: "x y z\n", rewrote: ["A"] }), applyAllEdits(text, [one, meets, apart]));
  check("no edits, nothing to apply", applyAllEdits(text, [{ ...one, edits: [] }]) === null);
  check("an edit past the text is not a rewrite", rewriteOf(text, [{ start: 4, end: 99, replacement: "", auto: false }]) === null);
  check("an insertion shows the line it lands on", JSON.stringify(rewriteOf("ab\ncd\n", [{ start: 4, end: 4, replacement: "X", auto: false }])) === JSON.stringify({ line: 2, lines: 1, with: ["cXd"] }));
  check("a change across lines shows them all", JSON.stringify(rewriteOf("ab\ncd\nef\n", [{ start: 1, end: 4, replacement: "-", auto: false }])) === JSON.stringify({ line: 1, lines: 2, with: ["a-d"] }));
  check("text outside ASCII keeps its bytes", JSON.stringify(rewriteOf("é = 1;\nb\n", [{ start: 5, end: 6, replacement: "2", auto: false }])) === JSON.stringify({ line: 1, lines: 1, with: ["é = 2;"] }));
}

// --- Diagnostics and edits.
{
  const main = "/slot/src/main.rs";
  const lines = [
    JSON.stringify({ kind: "diagnostic", severity: "error", code: "L1", message: "in the crate", file: "/crate/src/lib.rs", span: { line: 2, col: 1 }, edits: [{ start: 0, end: 1, replacement: "x", auto: true }] }),
    JSON.stringify({ kind: "diagnostic", severity: "warning", code: "W1", message: "a warning", file: main, span: { line: 1, col: 1 } }),
    "not json",
    JSON.stringify({ kind: "diagnostic", severity: "error", code: "L2", message: "in the recipe", file: main, span: { line: 5, col: 3 } }),
  ].join("\n");
  const d = parseDiagnostics(lines, main);
  check("errors only, the recipe's first", d.length === 2 && d[0]!.code === "L2" && d[1]!.inCrate === true, d);
  check("a crate diagnostic carries no edits", d[1]!.edits.length === 0, d[1]);
  // Byte offsets: "é" is two bytes, so the edit after it lands by bytes, not characters.
  const src = "é = 60;";
  const at = utf8Bytes("é = ");
  const edited = applyAutoEdits(src, [{ code: "L0110", message: "", line: 1, col: 1, fix: "", edits: [{ start: at, end: at + 2, replacement: "60.0", auto: true }, { start: at, end: at + 2, replacement: "60.0", auto: true }] }]);
  check("edits are byte offsets, each span once", edited === "é = 60.0;", edited);
  check("no auto edits is null", applyAutoEdits(src, [{ code: "x", message: "", line: 1, col: 1, fix: "", edits: [{ start: 0, end: 1, replacement: "y", auto: false }] }]) === null);
  check("an edit past the end is null", applyAutoEdits("ab", [{ code: "x", message: "", line: 1, col: 1, fix: "", edits: [{ start: 1, end: 9, replacement: "y", auto: true }] }]) === null);
}

if (failed) {
  console.error(`recipe host: ${failed} failed`);
  process.exit(1);
}
console.log("recipe host: ok");
process.exit(0);
