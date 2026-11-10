/**
 * The long guides in sections: guide {topic} answers an index, guide {topic, section} one part, full:true the whole
 * text, and the lime://guide/* resources stay whole.
 */
import { fakeEngine } from "./engine.ts";
import { guideByUri, guideSections } from "./guides.ts";
import { handleRpc } from "./protocol.ts";
import { OP_KINDS } from "./schema.ts";
import { Session } from "./session.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}` : ""}`);
}
const tokens = (value: unknown) => Math.ceil(Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value)) / 4);

process.env.LIME_INGREDIENTS_DIR ??= "";
const session = new Session(fakeEngine());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (name: string, args: unknown = {}) => session.call(name, args) as Promise<Record<string, any>>;

for (const topic of ["ops", "recipes", "ingredients"]) {
  const whole = guideByUri(`lime://guide/${topic}`)!.text;
  const sections = guideSections(topic)!;
  check(`${topic}: the sections joined are the guide's text`, sections.map((row) => row.text).join("\n") === whole);
  check(`${topic}: every section has lines and a name of its own`, sections.every((row) => row.text.length > 0) && new Set(sections.flatMap((row) => [row.section, ...row.also])).size === sections.reduce((n, row) => n + 1 + row.also.length, 0));
  const index = await call("guide", { topic });
  const full = await call("guide", { topic, full: true });
  console.log(`${topic}: index ~${tokens(index)} tokens, full ~${tokens(full)} tokens, largest section ~${Math.max(...sections.map((row) => tokens(row.text)))}`);
  check(`${topic}: guide {topic} is an index under 450 tokens that names the section and full forms`, index.ok === true && index.text === undefined && Array.isArray(index.sections) && tokens(index) < 450 && String(index.next).includes("section") && String(index.next).includes("full:true"), index);
  check(`${topic}: full:true is the whole text`, full.ok === true && String(full.text).startsWith(whole) && (topic === "recipes" || full.text === whole));
  for (const row of sections) {
    const one = await call("guide", { topic, section: row.section });
    if (one.ok !== true || one.text !== row.text) check(`${topic}: section ${row.section} is its lines`, false, one);
  }
  const resource = (await handleRpc(session, { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: `lime://guide/${topic}` } })) as { result: { contents: { text: string }[] } };
  check(`${topic}: the resource is still the whole text`, JSON.stringify(JSON.parse(resource.result.contents[0]!.text)).includes(JSON.stringify(whole).slice(1, -1)));
}

const kinds = guideSections("ops")!.flatMap((row) => [row.section, ...row.also]);
check("every op kind the ops guide writes about is a section by its name", ["boolean", "gear", "extrude", "revolve", "loft", "sweep", "shell", "faceExtrude", "moveFaces", "hole", "fillet", "chamfer", "transition", "split", "scale", "partition", "join", "pocket", "boss", "texture", "array", "ribs", "pattern", "text", "mirror"].every((kind) => kinds.includes(kind) && OP_KINDS.includes(kind)));
const chamfer = await call("guide", { topic: "ops", section: "chamfer" });
check("a kind that shares a section reads it", chamfer.ok === true && chamfer.section === "fillet" && String(chamfer.text).startsWith("fillet, chamfer:"));
const two = await call("guide", { topic: "ops", section: "boolean, flow" });
check("two sections in one call", two.ok === true && two.section === "boolean,flow" && String(two.text).startsWith("boolean:") && String(two.text).includes("A plain op needs model_probe first"));
const none = await call("guide", { topic: "ops", section: "nope" });
check("an unknown section names the sections", none.ok === false && none.code === "unknown-topic" && String(none.reason).includes("boolean"), none);
const library = await call("guide", { topic: "recipes", section: "library" });
check("the kept ingredients are the recipes guide's library section", library.ok === true && String(library.text).startsWith("Your ingredients") || String(library.text).includes("ingredients::"), library);
const short = await call("guide", { topic: "slice" });
check("a short guide is still its text", short.ok === true && short.text === guideByUri("lime://guide/slice")!.text);
check("the pivot rule is in the boolean section", String((await call("guide", { topic: "ops", section: "boolean" })).text).includes("turn pivots about the primitive's own centre"));

if (failed > 0) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("guide sections: all checks passed");
