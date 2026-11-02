/**
 * The shared recipe host (src/recipe/host.ts) over a scripted transport: no lust and no process. The script plays the
 * recipe's side of protocol v1, so the same run loop the MCP server and the app use is checked call for call.
 */
import { applyAutoEdits, buildRecipe, parseDiagnostics, runRecipe, utf8Bytes, type CompileResult, type RecipeCallSite, type RecipeProcessEvents, type RecipeReply, type RecipeSpawn } from "./host.ts";

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
