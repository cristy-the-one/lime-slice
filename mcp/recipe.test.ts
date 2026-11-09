/**
 * recipe_run's host (mcp/recipe.ts) against real lust, with a scripted stand-in for the session's calls.
 * Skips without lust (LIME_LUST, or lust on PATH); LIME_RECIPE_REQUIRED=1 (the CI job that builds lust) makes that a failure.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// --- The animation authoring example compiles with the actual sandbox compiler.
{
  const source = "//! ---\n//! plugin: arm-point-then-peace\n//! title: Point into the distance, then a peace sign\n//! kind: animation\n//! api: 1.8\n//! params: [{\"name\":\"fps\",\"kind\":\"count\",\"default\":12,\"min\":4,\"max\":30}]\n//! ---\nuse lime_recipe::{anim::*, Session};\n\nfn main() {\n    let mut s = Session::start();\n    let fps = s.count(\"fps\", 12).range(4, 30).label(\"Frames per second\").get();\n    let rig = s.rig().unwrap_or_else(|r| s.refuse(&r.reason));\n\n    let fingers = rig.group(\"Finger * root|Finger * middle|Finger * claw\");\n    let index = rig.group(\"Finger 1 *\");\n    let middle = rig.group(\"Finger 2 *\");\n\n    let mut a = Animation::new(fps);\n    a.key(0.0, Pose::rest());\n    a.key(1.2, Pose::new().set(\"Upper arm\", 90.0).set(\"Forearm\", 110.0).set(\"Palm\", 180.0)).ease(Ease::InOut);\n    a.key(1.8, Pose::new().set_all(&fingers, Aim::Fraction(-0.9)).set(\"Thumb *\", -40.0));\n    a.key(2.6, Pose::new().set_all(&index, Aim::Aligned)).hold(1.0);\n    a.key(3.6, Pose::new().set(\"Forearm\", 150.0).set(\"Palm\", 90.0)).ease(Ease::InOut);\n    a.key(4.4, Pose::new().set_all(&middle, Aim::Aligned)).hold(1.2);\n    a.camera(Camera::looking(-1.0, -1.0, 0.5));\n\n    s.animate(&a).unwrap_or_else(|r| s.refuse(&r.reason));\n}\n";
  const built = await host.build("animation-example", source, false);
  check("animation example builds with lust", built.ok, built.diagnostics);
  if (built.ok) {
    const described = await host.run(built.exe!, { kind: "animation", describe: true }, async () => ({ ok: false, error: "describe must not call the rig" }));
    check("animation example describes fps", described.ok && described.described?.params[0]?.name === "fps", described);
    const calls: RecipeCallSite[] = [];
    const run = await host.run(built.exe!, { kind: "animation" }, async (site) => {
      calls.push(site);
      if (site.tool === "rig") return { ok: true, result: { members: [{ name: "Finger 1 root", parent: "Palm", joint: { kind: "hinge", angle: 0, min: -90, max: 90 }, aligned: 15 }] } };
      return { ok: true, result: {} };
    });
    const animation = calls.find((call) => call.tool === "animate")?.args;
    check("animation example sends its rig and keys", run.ok && calls.map((call) => call.tool).join(",") === "rig,animate" && Array.isArray(animation?.keys) && animation.keys.length === 6, { run, calls });
    const forbiddenSource = source.replace("s.animate(&a).unwrap_or_else(|r| s.refuse(&r.reason));", "s.call(\"model_apply\", lime_recipe::Json::obj()).unwrap_or_else(|r| s.refuse(&r.reason));");
    const forbidden = await host.build("animation-forbidden", forbiddenSource, false);
    check("animation attempting a model edit builds", forbidden.ok, forbidden.diagnostics);
    if (forbidden.ok) {
      const seen: string[] = [];
      const stopped = await host.run(forbidden.exe!, { kind: "animation" }, async (site) => {
        seen.push(site.tool);
        return { ok: true, result: { members: [] } };
      });
      check("animation model edit is refused by the real host", stopped.refused.some((r) => r.reason === "An animation can only pose the assembly it was given." && r.line > 0) && seen.join(",") === "rig", stopped);
    }
  }
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

  const regret = await call("recipe_run", { source: src(["    let p = s.object().unwrap();", "    let _built = s.apply(&p, ops::boolean(\"fuse\", ops::cylinder(1.0, 3.0), [0.0, 0.0, 10.0])).unwrap();", '    panic!("changed my mind");']), name: "regret", object: id });
  const back = (await call("model_history", { object: id })) as Record<string, unknown>;
  check("session: a panic after an edit sends the part back", regret.ok === false && regret.line === 6 && (regret.rolledBack as { restored: string[] }).restored[0] === id && JSON.stringify(back.current) === JSON.stringify(before.current), { regret, back: back.current });

  // With tool groups on, recipe_run is in model; the calls it makes are its own and are not gated again.
  const grouped = new Session(fakeEngine());
  grouped.toolGroups = new Set(["model"]);
  const logged = await grouped.call("recipe_run", { source: src(["    let p = s.solid_new(ops::cuboid(4.0, 4.0, 4.0)).unwrap();", '    s.log("made it");', "    s.done(&p);"]), name: "box" });
  check("session: log notes come back with their line", logged.ok === true && JSON.stringify(logged.notes) === JSON.stringify(["line 5: made it"]), logged);

  // --- A recipe places what it made; a part it did not make it may not move.
  const placed = src([
    '    let n = s.param_u32("n", 2);',
    "    let mut last = None;",
    "    for i in 0..n {",
    "        let p = s.solid_new(ops::cuboid(4.0, 4.0, 4.0)).unwrap();",
    '        s.call("object_place", lime_recipe::Json::obj().set("object", p.object.as_str()).set("centreX", 20.0 + 10.0 * i as f64).set("centreY", 30.0)).unwrap();',
    "        last = Some(p);",
    "    }",
    '    let pts = lime_recipe::Json::arr(vec![[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]]);',
    "    let p = last.unwrap();",
    '    s.done_with(&p, lime_recipe::Json::obj().set("outline", pts));',
  ]);
  const two = await call("recipe_run", { source: placed, name: "row" });
  const listed = (await call("plate_list", {})).objects as { object: string; centreMm: number[] }[];
  const made = (two.created as string[] | undefined) ?? [];
  const xs = made.map((oid) => listed.find((row) => row.object === oid)?.centreMm[0]);
  check("session: a recipe places the objects it made", two.ok === true && made.length === 2 && xs[1]! - xs[0]! === 10 && two.recipe === "row", { two, xs });
  check("session: recipe placement uses the solid's bounds before commit", JSON.stringify(xs) === "[20,30]" && made.every((oid) => {
    const centre = listed.find((row) => row.object === oid)?.centreMm;
    return centre?.[1] === 30 && centre[2] === 2;
  }), listed);
  check("session: Json::arr takes an outline", JSON.stringify((two.metrics as { outline?: unknown }).outline) === "[[0,0],[1,0],[0,1]]", two.metrics);
  const moveOther = await call("recipe_run", { source: src([`    s.call("object_place", lime_recipe::Json::obj().set("object", "${id}").set("centreX", 5.0)).unwrap();`]), name: "nudge" });
  check("session: placing a part the run did not make is refused", moveOther.ok === false && /places only the objects this run made/.test(JSON.stringify(moveOther.refused)), moveOther);

  // --- Saved with the project, and run again from its object with new parameters.
  const saved = await call("project_save", { name: "recipes.lime" });
  const doc = JSON.parse(readFileSync(join(process.env.LIME_MCP_WORKSPACE!, "recipes.lime"), "utf8")) as { mcpModel?: { rustRecipes?: Record<string, { source: string; params: Record<string, unknown>; objects: string[] }>; recipes?: Record<string, { rust?: string }> } };
  const row = doc.mcpModel?.rustRecipes?.row;
  check("session: the project keeps a recipe_run source once, by name", saved.ok === true && !!row && row.source.includes("object_place") && JSON.stringify(row.objects) === JSON.stringify(made) && made.every((oid) => doc.mcpModel?.recipes?.[oid]?.rust === "row"), doc.mcpModel);
  const reopened = new Session(fakeEngine());
  await reopened.call("project_open", { path: "recipes.lime" });
  const three = await reopened.call("recipe_run", { object: made[0], params: { n: 3 } });
  const after3 = ((await reopened.call("plate_list", {})).objects as { object: string; centreMm: number[] }[]);
  const third = (three.created as string[] | undefined) ?? [];
  // --- I22. The old handles hold the new parts; the run placed them, so they stand where it put them.
  check("session: a rerun from the object keeps the handles and adds the new one", three.ok === true && JSON.stringify(three.replaced) === JSON.stringify(made) && third.length === 1 && made.every((oid) => after3.some((r) => r.object === oid)) && after3.length === 4, { three, after3 });
  const xs3 = [...made, ...third].map((oid) => after3.find((r) => r.object === oid)?.centreMm[0]);
  check("session: the rerun's parts stand where it placed them", xs3[1]! - xs3[0]! === 10 && xs3[2]! - xs3[1]! === 10, xs3);
  const plain = String((await reopened.call("solid_new", { primitive: "box", dx: 3, dy: 3, dz: 3 })).object);
  const none = await reopened.call("recipe_run", { object: plain });
  check("session: a rerun needs an object a recipe_run made", none.ok === false && /Pass source/.test(String(none.reason)), none);

  // --- I22. New source for an object an earlier run of the same name made: the part is made again under its handle,
  // where the person left it. Never a second copy.
  const sizes = async (who: InstanceType<typeof Session>) => Object.fromEntries(((await who.call("plate_list", {})).objects as { object: string; centreMm: number[]; bboxMm: { min: number[]; max: number[] } }[]).map((r) => [r.object, { x: r.centreMm[0], y: r.centreMm[1], dx: Math.round(r.bboxMm.max[0]! - r.bboxMm.min[0]!) }]));
  const cubeSrc = (mm: number) => src([`    let p = s.solid_new(ops::cuboid(${mm.toFixed(1)}, ${mm.toFixed(1)}, ${mm.toFixed(1)})).unwrap();`, "    s.done(&p);"]);
  const one = await reopened.call("recipe_run", { source: cubeSrc(10), name: "cube" });
  const cube = String(one.object);
  await reopened.call("object_place", { object: cube, centreX: 60, centreY: 70 });
  const count = Object.keys(await sizes(reopened)).length;
  const swapped = await reopened.call("recipe_run", { source: cubeSrc(12), name: "cube", object: cube });
  const now = await sizes(reopened);
  check("session: new source on the run's object replaces it in place", swapped.ok === true && swapped.object === cube && JSON.stringify(swapped.replaced) === JSON.stringify([cube]) && swapped.created === undefined, swapped);
  check("session: one part, same handle, where it was, the new size", Object.keys(now).length === count && now[cube]?.x === 60 && now[cube]?.y === 70 && now[cube]?.dx === 12, now);
  const rerunCube = await reopened.call("recipe_run", { object: cube, params: {} });
  check("session: a rerun of the replaced part replaces it again", rerunCube.ok === true && rerunCube.object === cube && Object.keys(await sizes(reopened)).length === count, rerunCube);
  const assembledSrc = src([
    '    let x = s.param_f64("x", 15.0);',
    '    let p = s.solid_new(ops::cuboid(8.0, 8.0, 8.0)).unwrap();',
    '    s.call("model_place", lime_recipe::Json::obj().set("object", p.object.as_str()).set("x", x)).unwrap();',
    '    s.done(&p);',
  ]);
  const assembled = await reopened.call("recipe_run", { source: assembledSrc, name: "assembled" });
  const assembledId = String(assembled.object);
  await reopened.call("object_place", { object: assembledId, centreX: 42, centreY: 67 });
  const assembledAgain = await reopened.call("recipe_run", { object: assembledId, params: { x: 25 } });
  const assembledAfter = await sizes(reopened);
  const assembledPose = await reopened.call("model_place", { object: assembledId });
  check("session: model_place on rerun preserves the print layout", assembledAgain.ok === true && assembledAfter[assembledId]?.x === 42 && assembledAfter[assembledId]?.y === 67, { assembledAgain, assembledAfter });
  check("session: model_place on rerun updates the assembly pose", assembledPose.x === 25, assembledPose);
  const printSrc = src([
    '    let p = s.solid_new(ops::cuboid(8.0, 8.0, 8.0)).unwrap();',
    '    s.call("object_place", lime_recipe::Json::obj().set("object", p.object.as_str()).set("centreX", 80.0).set("centreY", 90.0)).unwrap();',
    '    s.done(&p);',
  ]);
  const printAgain = await reopened.call("recipe_run", { object: assembledId, name: "assembled", source: printSrc });
  const printAfter = await sizes(reopened);
  const keptPose = await reopened.call("model_place", { object: assembledId });
  check("session: object_place on rerun changes only the print pose", printAgain.ok === true && printAfter[assembledId]?.x === 80 && printAfter[assembledId]?.y === 90 && keptPose.x === 25, { printAgain, printAfter, keptPose });
  // The same name without object makes another part, and says how to replace the earlier one instead.
  const second = await reopened.call("recipe_run", { source: cubeSrc(8), name: "cube" });
  check("session: the same name without object says the earlier part is still there", second.ok === true && second.object !== cube && String(second.earlier).includes(`${cube} from an earlier run of cube is still on the plate`), second);
  const firstAgain = await reopened.call("recipe_run", { object: cube });
  const both = await sizes(reopened);
  check("session: the earlier part keeps its own recipe", firstAgain.ok === true && firstAgain.object === cube && both[cube]?.dx === 12 && both[String(second.object)]?.dx === 8, { firstAgain, both });
  const asTold = await reopened.call("recipe_run", { source: cubeSrc(14), name: "cube", object: cube });
  const told = await sizes(reopened);
  check("session: new source on the earlier part, as the reply said, replaces only it", asTold.ok === true && asTold.object === cube && JSON.stringify(asTold.replaced) === JSON.stringify([cube]) && told[cube]?.dx === 14 && told[String(second.object)]?.dx === 8, { asTold, told });

  // --- I23. A dry run stopped after N applied ops: the measures so far, then taken back.
  const plateBefore = Object.keys(await sizes(reopened)).join(",");
  const partial = await reopened.call("recipe_run", { source: example, name: "bar", mode: "dry", maxSteps: 2, params: { holes: 4 } });
  const partialMetrics = partial.metrics as Record<string, { volumeMm3: number; sizeMm: number[] }> | undefined;
  check("session: maxSteps stops a dry run after two applied ops", partial.ok === true && partial.partial === true && partial.applied === 2 && /after 2 applied ops/.test(String(partial.stopped)) && partial.line === 17, partial);
  check("session: the partial run reports what it built so far", !!partialMetrics && Object.values(partialMetrics).some((row) => row.volumeMm3 > 0 && row.sizeMm.length === 3), partialMetrics);
  check("session: the partial run is taken back", Object.keys(await sizes(reopened)).join(",") === plateBefore && (partial.rolledBack as { removed: string[] }).removed.length === 1, partial.rolledBack);
  const notDry = await reopened.call("recipe_run", { source: example, name: "bar", maxSteps: 2 });
  check("session: maxSteps is for dry runs only", notDry.ok === false && /maxSteps is for mode:"dry"/.test(String(notDry.reason)), notDry);

  // --- R-A. The source from a workspace file and data by name: a rerun sends a path, never the numbers.
  const ws = process.env.LIME_MCP_WORKSPACE!;
  mkdirSync(join(ws, "tray"), { recursive: true });
  writeFileSync(join(ws, "tray", "cells.json"), JSON.stringify({ xs: [1.5, 2.5, 3.5] }));
  writeFileSync(join(ws, "pts.csv"), ["1,2", "3,4", ""].join("\n"));
  const trayRs = src([
    '    let d = s.call("data", lime_recipe::Json::obj().set("name", "tray/cells")).unwrap();',
    '    let xs = d.get("xs").unwrap().as_array().unwrap().clone();',
    "    let n = xs.len();",
    "    let p = s.solid_new(ops::cuboid(xs[n - 1].as_f64().unwrap() * 4.0, 5.0, 5.0)).unwrap();",
    '    let c = s.call("data", lime_recipe::Json::obj().set("name", "pts")).unwrap();',
    "    let rows = c.as_array().unwrap().len();",
    '    s.done_with(&p, lime_recipe::Json::obj().set("n", n as f64).set("rows", rows as f64));',
  ]);
  writeFileSync(join(ws, "tray.rs"), trayRs);
  const viaPath = await reopened.call("recipe_run", { path: "tray.rs" });
  const trayMetrics = viaPath.metrics as { n?: number; rows?: number } | undefined;
  const kept = viaPath.data as Record<string, { sha256: string; bytes: number }> | undefined;
  check("session: path runs a workspace .rs, named after the file", viaPath.ok === true && viaPath.recipe === "tray" && trayMetrics?.n === 3 && trayMetrics?.rows === 2, viaPath);
  check("session: the data it read is listed with a hash", !!kept && /^[0-9a-f]{64}$/.test(kept["tray/cells"]?.sha256 ?? "") && kept.pts?.bytes === 8, kept);
  const trayId = String(viaPath.object);
  const both2 = await reopened.call("recipe_run", { path: "tray.rs", source: trayRs });
  check("session: source and path together are refused", both2.ok === false && /not both/.test(String(both2.reason)), both2);
  const outside = await reopened.call("recipe_run", { path: "../tray.rs" });
  check("session: a path out of the workspace is refused", outside.ok === false && String(outside.reason).startsWith("There is no ../tray.rs in the workspace"), outside);
  const missing = await reopened.call("recipe_run", { source: src(['    s.call("data", lime_recipe::Json::obj().set("name", "nope")).unwrap();']), name: "nodata" });
  const missingText = String(missing.reason);
  check("session: a missing data name is refused with the names there are", missing.ok === false && missingText.includes("No recipe data is named nope") && missingText.includes("tray/cells") && missingText.includes("pts"), missing);
  // Kept with the project: a rerun elsewhere, without the files, builds the same part.
  await reopened.call("project_save", { name: "tray.lime" });
  const elsewhere = mkdtempSync(join(tmpdir(), "lime-recipe-elsewhere-"));
  copyFileSync(join(ws, "tray.lime"), join(elsewhere, "tray.lime"));
  process.env.LIME_MCP_WORKSPACE = elsewhere;
  const there = new Session(fakeEngine());
  await there.call("project_open", { path: "tray.lime" });
  const rebuilt = await there.call("recipe_run", { object: trayId });
  check("session: the project carries the data, so a rerun builds without the files", rebuilt.ok === true && rebuilt.object === trayId && (rebuilt.metrics as { n?: number }).n === 3, rebuilt);
  process.env.LIME_MCP_WORKSPACE = ws;

  // --- section {saveAs}: a mesh's measured sections go to the workspace as recipe data, and a recipe reads them back.
  const meshCube = String((await reopened.call("mesh_import", { path: fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url)) })).object);
  const savedLevels = await reopened.call("section", { object: meshCube, levels: { axis: "z", values: [5, 10, 15] }, resample: 32, saveAs: "cube/levels" });
  const savedFile = join(ws, "cube", "levels.json");
  const savedDoc = JSON.parse(readFileSync(savedFile, "utf8")) as { sections: { regions: unknown[] }[] };
  check("section saveAs writes the answer as recipe data and replies with counts only", savedLevels.ok === true && savedLevels.saved === "cube/levels" && savedLevels.sections === 3 && (savedLevels.areasMm2 as number[]).every((a) => Math.abs(a - 400) < 12) && !JSON.stringify(savedLevels).includes("regions") && savedDoc.sections.length === 3, savedLevels);
  const levels = src([
    '    let d = s.data("cube/levels").unwrap();',
    "    let secs = lime_recipe::Section::all(&d);",
    "    let p = s.solid_new(ops::cuboid(secs[1].region.area().sqrt(), 5.0, 5.0)).unwrap();",
    '    s.done_with(&p, lime_recipe::Json::obj().set("levels", secs.len()).set("area", secs[1].region.area()).set("z", secs[1].frame.origin[2]));',
  ]);
  const readBack = await reopened.call("recipe_run", { source: levels, name: "levels" });
  const lm = readBack.metrics as { levels?: number; area?: number; z?: number } | undefined;
  check("a recipe reads the saved sections with Section::all", readBack.ok === true && lm?.levels === 3 && Math.abs((lm?.area ?? 0) - 400) < 12, readBack);
  const inRecipe = await reopened.call("recipe_run", { source: src([`    let r = s.call("section", lime_recipe::Json::obj().set("object", "${meshCube}").set("levels", lime_recipe::Json::obj().set("axis", "z").set("values", vec![5.0])).set("saveAs", "x"));`, "    let p = s.solid_new(ops::cuboid(1.0, 1.0, 1.0)).unwrap();", "    if let Err(e) = r { s.log(&e.reason); }", "    s.done(&p);"]), name: "nosave", object: meshCube });
  check("a recipe may not write data with saveAs", inRecipe.ok === true && JSON.stringify(inRecipe.notes).includes("saveAs is for a call from the chat"), inRecipe);
  const badName = await reopened.call("section", { object: meshCube, levels: { axis: "z", values: [5] }, saveAs: "../out" });
  check("saveAs keeps to data names in the workspace", badName.ok === false && /not a data name/.test(String(badName.reason)), badName);

  // --- R-C. A loft that stops the kernel is a refusal the recipe handles: it cuts in pieces of four sections.
  process.env.LIME_MCP_FAKE_STOP_LOFT = "1";
  const chunked = src([
    "    let p = s.solid_new(ops::cuboid(40.0, 40.0, 40.0)).unwrap();",
    "    let mut secs: Vec<lime_recipe::Json> = Vec::new();",
    "    for i in 0..7 {",
    '        secs.push(lime_recipe::Json::obj().set("origin", [0.0, 0.0, 2.0 + 4.0 * i as f64]).set("turn", [0.0, 0.0, 0.0]).set("profile", vec![[-5.0, -5.0], [5.0, -5.0], [5.0, 5.0], [-5.0, 5.0]]));',
    "    }",
    "    let mut pieces = 0;",
    '    let whole = lime_recipe::Json::obj().set("kind", "loft").set("op", "cut").set("sections", lime_recipe::Json::from(secs.clone()));',
    "    if let Err(e) = s.apply(&p, whole) {",
    "        s.log(&e.reason);",
    "        let mut i = 0;",
    "        while i + 1 < secs.len() {",
    "            let j = (i + 4).min(secs.len());",
    '            let piece = lime_recipe::Json::obj().set("kind", "loft").set("op", "cut").set("sections", lime_recipe::Json::from(secs[i..j].to_vec()));',
    "            s.apply(&p, piece).unwrap();",
    "            pieces += 1;",
    "            i = j - 1;",
    "        }",
    "    }",
    '    s.done_with(&p, lime_recipe::Json::obj().set("pieces", pieces as f64));',
  ]);
  const fell = await reopened.call("recipe_run", { source: chunked, name: "chunks" });
  check("session: the stopped loft reaches the recipe as a refusal, and its pieces apply", fell.ok === true && (fell.metrics as { pieces?: number }).pieces === 2 && JSON.stringify(fell.refused).includes("The loft stopped the kernel"), fell);
  check("session: the server goes on after it", (await reopened.call("plate_list", {})).ok === true);
  delete process.env.LIME_MCP_FAKE_STOP_LOFT;
}

if (failed > 0) {
  console.error(`recipe: ${failed} failed`);
  process.exit(1);
}
console.log("recipe: all passed");
