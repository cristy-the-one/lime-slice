/**
 * The ingredient inliner the app and the MCP host share (src/recipe/ingredients.ts): from copies in hand, the block of
 * inline modules after a recipe, the same text whichever of them builds it; a source with its own `mod ingredients`
 * is built as it stands; a copy that is missing is a sentence.
 */
import { hasOwnIngredients, inlineIngredients, ingredientRefs, keptCopy, refKey, type KeptIngredient } from "./ingredients.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}

const spacing: KeptIngredient = { id: "spacing", version: 2, sha256: "a".repeat(64), body: "pub fn hole_x(w: f64) -> f64 {\n    w / 2.0\n}\n" };
const old: KeptIngredient = { id: "spacing", version: 1, sha256: "b".repeat(64), body: "use ingredients::rounding::*;\npub fn hole_x(w: f64) -> f64 { round(w) }\n" };
const rounding: KeptIngredient = { id: "rounding", version: 1, sha256: "c".repeat(64), body: "pub fn round(x: f64) -> f64 { x }\n" };
const kept: Record<string, KeptIngredient> = { spacing, "spacing@1": old, rounding };

const source = "use lime_recipe::Session;\nuse ingredients::{spacing::*, spacing::v1::*};\nfn main() {}\n";
check("the refs a source names, a pinned version apart", JSON.stringify(ingredientRefs(source).map(refKey)) === JSON.stringify(["spacing", "spacing@1"]), ingredientRefs(source));
const out = inlineIngredients(source, (_ref, key) => kept[key] ?? { reason: `no ${key}` });
check("the copies inline, with those they import", !("reason" in out) && Object.keys(out.used).sort().join() === "rounding,spacing,spacing@1", out);
if (!("reason" in out)) {
  check("one module a name, a pinned version inside it", /pub mod spacing \{\n\/\/ ingredient: spacing v2 sha256:a{64}\n/.test(out.suffix) && /pub mod v1 \{\n\/\/ ingredient: spacing v1 sha256:b{64}\n/.test(out.suffix), out.suffix);
  check("the block is one mod ingredients after the recipe", out.suffix.includes("mod ingredients {") && out.suffix.endsWith("}\n"), out.suffix);
  check("each body's lines are mapped", out.bodies.length === 3 && out.bodies.every((b) => b.to >= b.from), out.bodies);
}
const missing = inlineIngredients(source, (_ref, key) => (key === "rounding" ? { reason: "this project keeps no copy of rounding" } : kept[key]!));
check("a copy that is not there is the sentence", "reason" in missing && missing.reason === "this project keeps no copy of rounding", missing);
const own = "use ingredients::spacing::*;\nfn main() {}\n#[allow(dead_code)]\nmod ingredients {\n    pub mod spacing { pub fn hole_x(w: f64) -> f64 { w } }\n}\n";
check("a source that carries its own ingredients builds as it stands", hasOwnIngredients(own) && (() => {
  const r = inlineIngredients(own, () => ({ reason: "asked" }));
  return !("reason" in r) && r.suffix === "";
})());
check("a project's copy is read back, and one with no hash is not", keptCopy({ ...spacing }) !== null && keptCopy({ id: "x", version: 1, body: "" }) === null);

if (failed) {
  console.error(`ingredients: ${failed} failed`);
  process.exit(1);
}
console.log("src/recipe/ingredients: ok");
