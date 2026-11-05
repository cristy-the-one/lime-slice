/**
 * Save hints for a plugin (mcp/plugin-hints.ts): each rule fires on the shape it names, and the good examples (a face
 * pick with a fallback rule; a curved pick with a refusal) get none. Pure, no lust.
 */
import { MANY_PARAMS, pluginHints } from "./plugin-hints.ts";
import type { PluginParam } from "./plugins.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${JSON.stringify(detail)}`);
}

const num = (name: string): PluginParam => ({ name, kind: "number", default: 1 });
const face = (name: string, curved = false): PluginParam => ({ name, kind: "face", default: null, ...(curved ? { curved: true } : {}) });
const has = (hints: string[], start: string) => hints.some((h) => h.startsWith(start));
const PICK = "Pick the face with a face param";
const READ = "Read centre/radius from a picked face";
const REFUSE = "A part that doesn't fit should get s.refuse";
const DESC = "Start the description with what part it needs";
const COMMON = "Put common params first";

const cutting = "fn main() { let mut s = Session::start(); let p = s.object().unwrap(); s.apply(&p, ops::hole_through([0.0;3],[0.0,0.0,-1.0],3.0)).unwrap(); s.done(&p); }";
const refusing = `s.refuse("Needs a part."); s.apply(&p, o);`;

// Spiderweb v3-like: a face pick, no numeric face; the source asks the pick for its geometry.
const spiderParams = [face("face"), num("rings"), num("spokes")];
const spiderSource = `fn main() { let mut s = Session::start(); let f = s.face("face").rule("largest_up").get(); let g = s.pick_face(&part, &f)?; s.apply(&part, ops::cut(g)); }`;
const spider = pluginHints({ params: spiderParams, target: "object", description: "Spiderweb cut on a part, on the face you pick" }, spiderSource);
check("spiderweb v3-like gets no hint", spider.length === 0, spider);

// Moon v2-like: 17 params, a curved pick, a refusal, description starts with the part.
const moonParams = [face("face", true), ...Array.from({ length: 16 }, (_, i) => num(`size${i}`))];
const moonSource = `fn main() { if g.kind != "sphere" { s.refuse("This part has no sphere face: Moon crater field puts craters on a ball. Pick a sphere face."); } s.apply(&p, c); }`;
const moon = pluginHints({ params: moonParams, target: "object", description: "Craters on a sphere: a field of bowls cut into the face you pick." }, moonSource);
check("moon v2-like (17 params) gets only the soft many-params hint", moon.length === 1 && has(moon, COMMON), moon);
const moonTrim = pluginHints({ params: moonParams.slice(0, 10), target: "object", description: "Craters on a sphere" }, moonSource);
check("moon v2-like with 10 params gets none", moonTrim.length === 0, moonTrim);

// Rule 1: a numeric face.
check("a number named face gets the pick hint", has(pluginHints({ params: [num("face")], target: "object", description: "Cut on a face" }, cutting), PICK));
check("a count named faceIndex gets the pick hint", has(pluginHints({ params: [{ name: "faceIndex", kind: "count", default: 0 }], target: "object", description: "Cut on a face" }, cutting), PICK));
check("a count named index gets the pick hint", has(pluginHints({ params: [{ name: "index", kind: "count", default: 0 }], target: "object", description: "Cut on a face" }, cutting), PICK));
check("a face pick named face gets no pick hint", !has(pluginHints({ params: [face("face")], target: "object", description: "Cut on a face" }, cutting), PICK));
check("a toggle named face gets no pick hint", !has(pluginHints({ params: [{ name: "face", kind: "toggle", default: true }], target: "new", description: "A cube" }, "fn main(){}"), PICK));

// Rule 2: centre and radius asked for.
for (const name of ["centre", "center_x", "cx", "cy", "cz", "radius", "bodyRadius", "Centre Z"]) {
  check(`${name} gets the read-from-face hint`, has(pluginHints({ params: [num(name)], target: "object", description: "Craters on a sphere" }, refusing), READ), name);
}
check("a radius next to a face pick gets no hint (a size, not a measurement)", !has(pluginHints({ params: [face("face", true), num("radius")], target: "object", description: "Craters on a sphere" }, refusing), READ));

// Rule 3: applies to a part with no pick and no refusal.
check("an object plugin that cuts with no pick and no refuse is told to refuse", has(pluginHints({ params: [num("depth")], target: "object", description: "Cut on a flat face" }, cutting), REFUSE));
check("an either plugin is told too", has(pluginHints({ params: [num("depth")], target: "either", description: "Cut on a flat face" }, cutting), REFUSE));
check("a refusal silences it", !has(pluginHints({ params: [num("depth")], target: "object", description: "Cut on a flat face" }, `${cutting} s.refuse("Needs a flat face.");`), REFUSE));
check("a pick silences it", !has(pluginHints({ params: [face("face")], target: "object", description: "Cut on a flat face" }, cutting), REFUSE));
check("a commented refuse does not count", has(pluginHints({ params: [num("depth")], target: "object", description: "Cut on a flat face" }, `// s.refuse("x")\n${cutting}`), REFUSE));
check("a new-part plugin is not told to refuse", !has(pluginHints({ params: [num("width")], target: "new", description: "A bracket" }, cutting), REFUSE));
check("a plugin that never calls apply is not told to refuse", !has(pluginHints({ params: [num("depth")], target: "object", description: "Cut on a flat face" }, "fn main() {}"), REFUSE));

// Rule 4: the description names the part.
check("'Spiderweb pattern' alone is told to name the part", has(pluginHints({ params: [face("face")], target: "object", description: "Spiderweb pattern, very pretty" }, cutting), DESC));
check("an empty description is told too", has(pluginHints({ params: [face("face")], target: "object", description: "" }, cutting), DESC));
for (const d of ["Craters on a sphere", "Needs a cylinder", "Works on any flat part", "Texture the picked face", "Grooves on the top"]) {
  check(`"${d}" names the part`, !has(pluginHints({ params: [face("face")], target: "object", description: d }, cutting), DESC), d);
}
check("only the first clause counts", has(pluginHints({ params: [face("face")], target: "object", description: "A pretty pattern. Works on a sphere." }, cutting), DESC));
check("a new-part plugin needs no part in its description", !has(pluginHints({ params: [num("width")], target: "new", description: "A bracket" }, "fn main(){}"), DESC));

// Rule 5: many params.
const many = (n: number) => Array.from({ length: n }, (_, i) => num(`p${i}`));
check(`${MANY_PARAMS} params get no hint`, !has(pluginHints({ params: many(MANY_PARAMS), target: "new", description: "A grid" }, "fn main(){}"), COMMON));
check(`${MANY_PARAMS + 1} params get the soft hint`, has(pluginHints({ params: many(MANY_PARAMS + 1), target: "new", description: "A grid" }, "fn main(){}"), COMMON));

// The old versions: everything fires.
const v1 = pluginHints({ params: [num("bodyRadius"), num("centreX"), num("centreY"), num("centreZ"), ...many(18)], target: "object", description: "Moon crater field" }, "s.apply(&p, o);");
check("moon v1-like gets four hints", has(v1, READ) && has(v1, REFUSE) && has(v1, DESC) && has(v1, COMMON) && v1.length === 4, v1);
const v2 = pluginHints({ params: [num("face")], target: "object", description: "Spiderweb cut on a part" }, "s.apply(&p, o);");
check("spiderweb v2-like gets the pick and refuse hints", has(v2, PICK) && has(v2, REFUSE) && v2.length === 2, v2);

if (failed) {
  console.error(`${failed} plugin-hints check(s) failed`);
  process.exit(1);
}
console.log("plugin-hints: all passed");
