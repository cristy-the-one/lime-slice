/**
 * Recipe API levels (docs/plan-recipe-plugins.md D12, milestone 9): which crate a plugin builds against, and the one
 * sentence and code for one that does not build here, decided before anything is built. Shared by the MCP and the app.
 */
import { apiVerdict, crateApiOf, newerApiSentence, parseApiLevel } from "./api-level.ts";

let failed = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  failed += 1;
  console.error(`FAIL ${name}: ${a} vs ${b}`);
}

eq("a level parses", parseApiLevel(" 1.4 "), [1, 4]);
eq("not a level", [parseApiLevel("1"), parseApiLevel("1.x"), parseApiLevel("v1.2")], [null, null, null]);
eq("the crate's constant", crateApiOf("pub const API: (u32, u32) = (1, 4);\n"), [1, 4]);
eq("no constant", crateApiOf("fn main() {}"), null);

const one: [number, number][] = [[1, 4]];
eq("every older minor of the major builds on its crate", ["1.0", "1.1", "1.2", "1.3", "1.4"].map((l) => apiVerdict(l, one)), Array(5).fill({ ok: true, major: 1 }));
eq("a newer minor is refused with D12's sentence", apiVerdict("1.5", one), { ok: false, code: "plugin-unsupported", reason: "This plugin needs recipe API 1.5; this Lime Slice has 1.4. Update Lime Slice to run it. Its parts are kept as built." });
eq("API 9.0 is refused the same way", apiVerdict("9.0", one), { ok: false, code: "plugin-unsupported", reason: newerApiSentence([9, 0], [1, 4]) });
eq("a major below every shipped crate is retired", apiVerdict("0.9", one), { ok: false, code: "plugin-api-retired", reason: "This plugin was written for recipe API 0.x, which this Lime Slice no longer builds. Its parts are kept as built." });
eq("a malformed level", apiVerdict("one", one).ok === false && (apiVerdict("one", one) as { code: string }).code, "plugin-invalid");

// --- After a first major bump: 2.0 is current and the last 1.x crate ships beside it.
const two: [number, number][] = [[2, 0], [1, 4]];
eq("a 1.x plugin builds against the 1.x crate", apiVerdict("1.2", two), { ok: true, major: 1 });
eq("a 2.0 plugin against the current crate", apiVerdict("2.0", two), { ok: true, major: 2 });
eq("a 1.x minor newer than the shipped 1.x crate names that crate's level", apiVerdict("1.5", two), { ok: false, code: "plugin-unsupported", reason: newerApiSentence([1, 5], [1, 4]) });
eq("2.1 names the current level", apiVerdict("2.1", two), { ok: false, code: "plugin-unsupported", reason: newerApiSentence([2, 1], [2, 0]) });
eq("a dropped 1.x (only 2.0 ships)", apiVerdict("1.4", [[2, 0]]).ok === false && (apiVerdict("1.4", [[2, 0]]) as { code: string }).code, "plugin-api-retired");

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("api-level: all passed");
