/**
 * Recipes that use plugins (recipe API 1.16, docs/plan-plugin-recipes.md): the nested-run rules both hosts share. What
 * `plugin_run` takes; cycles and depth; the outer run's time and calls handed down and counted together (over a scripted
 * recipe, no lust); which code runs: a pin, an asked version, the library's current, and the note when the library moved
 * on; the pins a run records. No lust, no engine.
 */
import { runRecipe, type RecipeProcessEvents, type RecipeSpawn } from "./host.ts";
import { MAX_PLUGIN_DEPTH, nestedLimits, nestedRefusal, nestingRefusal, pickPluginCode, pinsOf, readPluginRun, type PluginCode, type PluginSources } from "./nested.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name} ${JSON.stringify(detail)}`);
}

// --- What plugin_run takes.
{
  const ask = readPluginRun({ plugin: "gear-on-arbor", params: { teeth: 40 } });
  check("a plugin and its values", JSON.stringify(ask) === JSON.stringify({ id: "gear-on-arbor", params: { teeth: 40 } }), ask);
  check("a version", JSON.stringify(readPluginRun({ plugin: "a", version: 2 })) === JSON.stringify({ id: "a", version: 2, params: {} }));
  for (const [bad, said] of [
    [{}, "needs plugin"],
    [{ plugin: "draft:x" }, "not a kept plugin's id"],
    [{ plugin: "Has Spaces" }, "not a kept plugin's id"],
    [{ plugin: "a", version: 0 }, "whole number from 1"],
    [{ plugin: "a", version: 1.5 }, "whole number from 1"],
    [{ plugin: "a", params: [1] }, "params is an object"],
    [{ plugin: "a", object: "obj_1" }, "not object"],
  ] as const) {
    const out = readPluginRun(bad as Record<string, unknown>);
    check(`refused: ${JSON.stringify(bad)}`, "reason" in out && out.reason.includes(said), out);
  }
}

// --- Cycles and depth.
{
  check("a plugin may run another", nestingRefusal(["clock"], "gear-on-arbor") === null);
  check("not itself", nestingRefusal(["clock"], "clock") === "clock runs clock: a plugin cannot run itself, directly or through other plugins, so nothing ran.", nestingRefusal(["clock"], "clock"));
  check("nor itself through another", nestingRefusal(["recipe", "a", "b"], "a") === "a runs b runs a: a plugin cannot run itself, directly or through other plugins, so nothing ran.", nestingRefusal(["recipe", "a", "b"], "a"));
  const deep = ["r", "a", "b", "c"];
  check(`${MAX_PLUGIN_DEPTH} deep is the most`, nestingRefusal(deep.slice(0, MAX_PLUGIN_DEPTH), "z") === null && (nestingRefusal(deep, "z") ?? "").includes(`plugins may run plugins ${MAX_PLUGIN_DEPTH} deep`), nestingRefusal(deep, "z"));
  check("a nested refusal names the plugin", nestedRefusal("Gear on arbor", "Too many teeth.") === "Gear on arbor: Too many teeth.");
}

// --- Limits: the time left and one shared budget of calls.
{
  const outer = { timeoutS: 30, maxCalls: 2000, maxLineBytes: 1 << 20, spent: { calls: 120 } };
  const now = 1_000_000;
  const handed = nestedLimits(outer, now + 12_500, now);
  check("the nested run gets the time the outer has left, and its budget", !("reason" in handed) && handed.timeoutS === 12.5 && handed.spent === outer.spent && handed.maxCalls === 2000, handed);
  const late = nestedLimits(outer, now + 10, now);
  check("no time left: it does not run", "reason" in late && late.reason.includes("used its 30 s"), late);
  const spent = nestedLimits({ ...outer, spent: { calls: 2000 } }, now + 10_000, now);
  check("no calls left: it does not run", "reason" in spent && spent.reason.includes("made its 2000 calls"), spent);

  // Over a scripted recipe: two runs share one budget of 5 calls; the second stops at its third.
  const scripted = (calls: number): RecipeSpawn => (events: RecipeProcessEvents) => {
    let next = 1;
    let ended = false;
    const say = (line: Record<string, unknown>) => setTimeout(() => !ended && events.stdout(`${JSON.stringify(line)}\n`), 0);
    const end = () => setTimeout(() => { if (!ended) { ended = true; events.exit(0); } }, 1);
    return {
      write: () => {
        if (next <= calls) say({ id: next, call: "log", args: { text: `call ${next++}` }, at: { line: 3 } });
        else say({ done: { object: "", metrics: {} } });
      },
      closeInput: end,
      kill: end,
    };
  };
  const shared = { calls: 0 };
  const limits = { timeoutS: 10, maxCalls: 5, maxLineBytes: 1 << 20, spent: shared };
  const reply = async () => ({ ok: true as const, result: { ok: true } });
  const one = await runRecipe(scripted(3), {}, reply, limits);
  check("the first run makes its 3 calls", one.ok && one.calls === 3 && shared.calls === 3, one);
  const two = await runRecipe(scripted(3), {}, reply, limits);
  check("the second stops when the shared budget is gone, with a sentence that says both counted", !two.ok && two.reason === "The recipe and the plugins it ran made more than 5 calls and were stopped.", two);
}

// --- Which code runs.
{
  const code = (version: number, sha: string): PluginCode => ({ version, sha256: sha.padEnd(64, "0"), text: `//! plugin v${version}` });
  const v1 = code(1, "a1");
  const v2 = code(2, "b2");
  const v3 = code(3, "c3");
  const sources = (project: PluginCode[], current: PluginCode | null, older: PluginCode[]): PluginSources => ({
    project: (sha) => project.find((row) => row.sha256 === sha) ?? null,
    library: (version) => (version === undefined || version === current?.version ? current : older.find((row) => row.version === version) ?? null),
    olderVersions: () => older.map((row) => row.version),
  });
  const ask = { id: "gear-on-arbor", params: {} };
  const fresh = pickPluginCode(ask, undefined, sources([], v3, [v1, v2]));
  check("no pin: the library's current version", "code" in fresh && fresh.code === v3 && fresh.note === undefined, fresh);
  const pinned = pickPluginCode(ask, { version: 1, sha256: v1.sha256 }, sources([], v3, [v1, v2]));
  check("a pin: the same code from an older file, and a note that the library moved on", "code" in pinned && pinned.code === v1 && (pinned.note ?? "").startsWith("v3 of gear-on-arbor is in your library; this run used v1"), pinned);
  const kept = pickPluginCode(ask, { version: 2, sha256: v2.sha256 }, sources([v2], null, []));
  check("a pin with the library gone: the project's copy", "code" in kept && kept.code === v2 && kept.note === undefined, kept);
  const same = pickPluginCode(ask, { version: 3, sha256: v3.sha256 }, sources([], v3, []));
  check("a pin on the current version: no note", "code" in same && same.code === v3 && same.note === undefined, same);
  const lost = pickPluginCode(ask, { version: 1, sha256: v1.sha256 }, sources([], v3, []));
  check("pinned code nowhere: a sentence, nothing runs", "reason" in lost && lost.reason.includes("ran v1 of gear-on-arbor before, and that code is in neither this project nor your library"), lost);
  const askedOld = pickPluginCode({ ...ask, version: 2 }, undefined, sources([], v3, [v1, v2]));
  check("an asked version: that version's file", "code" in askedOld && askedOld.code === v2, askedOld);
  const askedPinned = pickPluginCode({ ...ask, version: 1 }, { version: 1, sha256: v1.sha256 }, sources([v1], null, []));
  check("an asked version that is pinned: the pinned copy", "code" in askedPinned && askedPinned.code === v1, askedPinned);
  const askedMissing = pickPluginCode({ ...ask, version: 7 }, undefined, sources([], v3, [v1]));
  check("an asked version that is not there", "reason" in askedMissing && askedMissing.reason.includes("no version 7 of gear-on-arbor"), askedMissing);
  const none = pickPluginCode(ask, undefined, sources([], null, []));
  check("no plugin of that id", "reason" in none && none.reason === "No plugin is named gear-on-arbor in your library, so it did not run.", none);
  check("pins of the plugins a run ran", JSON.stringify(pinsOf(new Map([["gear-on-arbor", v1]]))) === JSON.stringify({ "gear-on-arbor": { version: 1, sha256: v1.sha256 } }) && pinsOf(new Map()) === undefined);
}

if (failed > 0) {
  console.error(`nested: ${failed} failed`);
  process.exit(1);
}
console.log("nested: all passed");
process.exit(0);
