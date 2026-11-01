/**
 * recipe_run's host (mcp/recipe.ts) against real lust, with a scripted stand-in for the session's calls.
 * Skips without lust (LIME_LUST, or lust on PATH); LIME_RECIPE_REQUIRED=1 (the CI job that builds lust) makes that a failure.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyAutoEdits, findLust, lfOnly, RecipeHost, type RecipeCallSite, type RecipeReply } from "./recipe.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const crateDir = join(root, "crates", "lime-recipe");
const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("recipe: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("recipe: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

const host = new RecipeHost({ crateDir, root: mkdtempSync(join(tmpdir(), "lime-recipe-test-")), lust });
const example = readFileSync(join(crateDir, "examples", "mounting_bar.rs"), "utf8");

/** A session stand-in: solid_new makes obj_1, every fourth call is refused, a fillet does not fit. */
function stub(log: RecipeCallSite[]) {
  return async (site: RecipeCallSite): Promise<RecipeReply> => {
    log.push(site);
    if (site.tool === "solid_new") return { ok: true, result: { ok: true, object: "obj_1" } };
    if (site.id === 4) return { ok: false, error: "The hole runs off the part." };
    const op = (site.args.op ?? {}) as { kind?: string };
    if (op.kind === "fillet") return { ok: false, error: "A blend of 1 mm does not fit.", extra: { maxMm: 0.4 } };
    return { ok: true, result: { ok: true } };
  };
}

// --- An auto fix: `60` where an f64 goes is fixed by lust's edit, then built.
{
  const broken = example.replace('let width = s.param_f64("width", 60.0);', 'let width: f64 = 60;');
  check("example has the line to break", broken !== example);
  const built = await host.build("bar", broken, true);
  check("auto fix builds", built.ok, built);
  check("auto fix took one round", built.fixRounds === 1, built.fixRounds);
  check("fixed source has 60.0", built.source.includes("let width: f64 = 60.0;"), built.source.slice(0, 400));
  const unfixed = await host.build("bar", broken, false);
  check("without autofix the build fails", !unfixed.ok && unfixed.diagnostics.some((d) => d.code === "L0110" && d.edits.some((e) => e.auto)), unfixed.diagnostics);
  // The host builds LF text (a Windows checkout of the example is CRLF), so the edits apply to that.
  check("applyAutoEdits is the same fix", applyAutoEdits(lfOnly(broken), unfixed.diagnostics) === built.source);
}

// --- A CRLF recipe (a Windows checkout) takes the same fix at the same place.
{
  const crlf = example.replace(/\r?\n/g, "\r\n").replace('let width = s.param_f64("width", 60.0);', "let width: f64 = 60;");
  const built = await host.build("bar", crlf, true);
  check("a CRLF recipe gets the fix in the right place", built.ok && built.source.includes("let width: f64 = 60.0;") && !built.source.includes("\r"), built.source.slice(0, 300));
}

// --- The run: calls in order with their recipe lines, refusals passed back, done with metrics.
{
  const built = await host.build("bar", example, true);
  check("example builds", built.ok && built.fixRounds === 0, built);
  const log: RecipeCallSite[] = [];
  const out = await host.run(built.exe!, { params: { width: 72, holes: 5 }, context: { units: "mm" } }, stub(log));
  check("run reaches done", out.ok && out.done?.object === "obj_1", out);
  check("metrics come through", out.done?.metrics.holes === 4, out.done);
  check("calls: solid_new, 5 holes, fillet, log", log.map((c) => c.tool).join(",") === "solid_new,model_apply,model_apply,model_apply,model_apply,model_apply,model_apply,log", log.map((c) => c.tool));
  check("each call carries its recipe line", log[0]!.line === 10 && log[1]!.line === 17, log.map((c) => c.line));
  check("refusals are listed with lines", out.refused.length === 2 && out.refused[1]!.line === 25, out.refused);
  const holeX = (log[1]!.args.op as { origin: number[] }).origin[0];
  check("float text is rustc's", holeX === -28.8, holeX);
}

// --- What the sandbox refuses, at check time, with the line.
{
  const r = await host.build("fs", 'fn main() { let _ = std::fs::read("/etc/passwd"); }\n', true);
  check("std::fs is refused", !r.ok && r.diagnostics.some((d) => d.code === "L0532" && d.line === 1), r.diagnostics);
}

// --- A call outside the allowlist, a panic, a time limit, a call limit.
{
  const src = (body: string) => `use lime_recipe::{Json, Session};\nfn main() {\n    let mut s = Session::start();\n${body}\n}\n`;
  const notAllowed = await host.build("t1", src('    let r = s.call("slice_start", Json::obj());\n    if let Err(e) = r { panic!("{}", e.reason); }'), true);
  check("t1 builds", notAllowed.ok, notAllowed);
  const out1 = await host.run(notAllowed.exe!, { params: {} }, stub([]));
  check("a call outside the list is refused, then the panic names line 5", !out1.ok && out1.line === 5 && /not a recipe call/.test(out1.reason ?? ""), out1);

  const spin = await host.build("t2", src("    let mut n = 0u64;\n    loop { n = n.wrapping_add(1); if n == u64::MAX { s.log(\"x\"); } }"), true);
  check("t2 builds", spin.ok, spin);
  const out2 = await host.run(spin.exe!, { params: {} }, stub([]), { timeoutS: 1, maxCalls: 10, maxLineBytes: 1 << 20 });
  check("the time limit stops it", !out2.ok && /1 s limit/.test(out2.reason ?? ""), out2);

  const chatty = await host.build("t3", src('    for _ in 0..50 { s.log("x"); }\n    let p = s.solid_new(lime_recipe::ops::cuboid(1.0, 1.0, 1.0)).unwrap();\n    s.done(&p);'), true);
  const out3 = await host.run(chatty.exe!, { params: {} }, stub([]), { timeoutS: 10, maxCalls: 20, maxLineBytes: 1 << 20 });
  check("the call limit stops it", !out3.ok && /more than 20 calls/.test(out3.reason ?? ""), out3);
  check("slots are reused: four at most", host.slots().length <= 4, host.slots());
}

// --- A recipe built again in its slot is warm: only the edit recompiles.
{
  const edited = example.replace("width >= 50.0", "width >= 55.0");
  await host.build("bar", example, true);
  const t0 = Date.now();
  const again = await host.build("bar", edited, true);
  const ms = Date.now() - t0;
  check("warm rebuild", again.ok, again);
  console.log(`warm edit + build of the example: ${ms} ms`);
}

// --- recipe_run through a session, on the fake engine: the transaction and the undo step. Real cuts are
// mcp/recipe-session.test.ts, with OCCT.
{
  process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-recipe-session-"));
  const { fakeEngine } = await import("./engine.ts");
  const { Session } = await import("./session.ts");
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const plate = async () => ((await call("plate_list", {})).objects as { object: string }[]).map((row) => row.object).join(",");
  const src = (body: string[]) => ["use lime_recipe::{ops, Session};", "fn main() {", "    let mut s = Session::start();", ...body, "}"].join("\n");

  const fixedRun = await call("recipe_run", { source: example.replace('let width = s.param_f64("width", 60.0);', "let width: f64 = 60;"), name: "bar", mode: "check" });
  check("session: check builds and returns the fixed source", fixedRun.ok === true && String(fixedRun.fixedSource).includes("let width: f64 = 60.0;"), fixedRun);
  const denied = await call("recipe_run", { source: 'fn main() { let _ = std::env::var("HOME"); }\n', name: "env" });
  check("session: the sandbox refusal comes back as a diagnostic", denied.ok === false && (denied.diagnostics as { code: string }[]).some((d) => d.code === "L0532"), denied);

  const box = await call("recipe_run", { source: src(["    let p = s.solid_new(ops::cuboid(20.0, 20.0, 10.0)).unwrap();", "    s.done(&p);"]), name: "box" });
  check("session: an apply puts the part on the plate", box.ok === true && (await plate()) === String(box.object) && (box.created as string[])[0] === box.object, box);
  const id = String(box.object);

  const dry = await call("recipe_run", { source: example, name: "bar", mode: "dry", params: { holes: 3 } });
  check("session: dry reports and takes its part back", dry.ok === true && dry.dry === true && (dry.metrics as { holes: number }).holes === 3 && (await plate()) === id, { dry, plate: await plate() });

  const miss = await call("recipe_run", { source: src(["    let p = s.solid_new(ops::cuboid(5.0, 5.0, 5.0)).unwrap();", "    let r = s.call(\"model_apply\", lime_recipe::Json::obj().set(\"object\", p.object.as_str()).set(\"op\", lime_recipe::Json::obj().set(\"kind\", \"nope\")));", "    r.unwrap();", "    s.done(&p);"]), name: "miss" });
  check("session: an unwrapped refusal fails at its line and removes the new part", miss.ok === false && miss.line === 6 && (await plate()) === id && (miss.rolledBack as { removed: string[] }).removed.length === 1, { miss, plate: await plate() });

  const studs = src([
    "    let p = s.object().unwrap();",
    "    for i in 0..3 {",
    "        let x = -6.0 + 4.0 * i as f64;",
    "        s.apply(&p, ops::boolean(\"fuse\", ops::cylinder(1.0, 3.0), [x, 0.0, 10.0])).unwrap();",
    "    }",
    "    s.done(&p);",
  ]);
  const before = (await call("model_history", { object: id })) as Record<string, unknown>;
  const added = await call("recipe_run", { source: studs, name: "studs", object: id });
  check("session: three fuses on the part passed in", added.ok === true && added.calls === 3 && added.created === undefined, added);
  const undo = await call("model_undo", { object: id });
  check("session: one undo takes the recipe back", undo.ok === true && undo.group === "recipe studs", undo);
  const after = (await call("model_history", { object: id })) as Record<string, unknown>;
  check("session: the history is back at its step", JSON.stringify(after.current) === JSON.stringify(before.current), { before: before.current, after: after.current });

  const regret = await call("recipe_run", { source: src(["    let p = s.object().unwrap();", "    s.apply(&p, ops::boolean(\"fuse\", ops::cylinder(1.0, 3.0), [0.0, 0.0, 10.0])).unwrap();", '    panic!("changed my mind");']), name: "regret", object: id });
  const back = (await call("model_history", { object: id })) as Record<string, unknown>;
  check("session: a panic after an edit sends the part back", regret.ok === false && regret.line === 6 && (regret.rolledBack as { restored: string[] }).restored[0] === id && JSON.stringify(back.current) === JSON.stringify(before.current), { regret, back: back.current });

  // With tool groups on, recipe_run is in model; the calls it makes are its own and are not gated again.
  const grouped = new Session(fakeEngine());
  grouped.toolGroups = new Set(["model"]);
  const logged = await grouped.call("recipe_run", { source: src(["    let p = s.solid_new(ops::cuboid(4.0, 4.0, 4.0)).unwrap();", '    s.log("made it");', "    s.done(&p);"]), name: "box" });
  check("session: log notes come back with their line", logged.ok === true && JSON.stringify(logged.notes) === JSON.stringify(["line 5: made it"]), logged);
}

if (failed > 0) {
  console.error(`recipe: ${failed} failed`);
  process.exit(1);
}
console.log("recipe: all passed");
