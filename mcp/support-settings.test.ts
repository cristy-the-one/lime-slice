/**
 * Support thin belt edges (supportBeltHoldThin) and the bridge limit (supportBridgeMm) through the MCP tools:
 * settings_set takes and refuses them as the panel does, settings_schema reads them back, and slice_start sends
 * them only when set (and the belt key only on a belt printer).
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, fakeEngine, loadNativeEngine } from "./engine.ts";
import { EXAMPLES } from "./examples.ts";
import { GUIDES } from "./guides.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-support-settings-"));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);
type Row = { key: string; value: unknown; default: unknown; label: string; help?: string };
const sent = () => JSON.parse(engine.lastSlice) as Record<string, unknown>;

await call("machine_select", { printerId: "lime-220", filamentId: "lime-pla" });
await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
await call("settings_set", { values: { supports: true } });
await call("slice_start", { cancelRunning: true });
check("by default neither key is sent", !("supportBridgeMm" in sent()) && !("supportBeltHoldThin" in sent()), engine.lastSlice.slice(0, 300));

const rows = (await call("settings_schema", { query: "bridge without support", all: true })).rows as Row[];
const bridgeRow = rows.find((row) => row.key === "supportBridgeMm");
check("settings_schema finds the bridge limit, 0 by default", bridgeRow?.default === 0 && bridgeRow?.value === 0, JSON.stringify(rows));

const flatSet = await call("settings_set", { values: { supportBridgeMm: 5, supportBeltHoldThin: true } });
check("both are set on a flat printer", flatSet.ok === true && (flatSet.changed as { key: string }[]).length === 2, JSON.stringify(flatSet));
check("a flat printer warns that thin belt edges are left out", JSON.stringify(flatSet.warnings ?? []).includes("supportBeltHoldThin applies only on a belt printer"), JSON.stringify(flatSet));
await call("slice_start", { cancelRunning: true });
check("a flat slice sends the bridge limit", sent().supportBridgeMm === 5, engine.lastSlice.slice(0, 300));
check("a flat slice leaves thin belt edges out", !("supportBeltHoldThin" in sent()));

const read = (await call("settings_schema", {})).rows as Row[];
check("the changed keys read back", read.some((row) => row.key === "supportBridgeMm" && row.value === 5) && read.some((row) => row.key === "supportBeltHoldThin" && row.value === true), JSON.stringify(read.map((row) => row.key)));

const tooLong = await call("settings_set", { values: { supportBridgeMm: 80 } });
check("a bridge limit past 50 mm is refused", tooLong.ok === false && String(tooLong.reason).includes("50"), JSON.stringify(tooLong));
const notBool = await call("settings_set", { values: { supportBeltHoldThin: "yes" } });
check("thin belt edges take only true or false", notBool.ok === false, JSON.stringify(notBool));
const perObject = await call("settings_set", { allObjects: true, values: { supportBridgeMm: 3 } });
check("the bridge limit is plate-wide", perObject.ok === false && JSON.stringify(perObject).includes("plate-wide"), JSON.stringify(perObject));

await call("machine_select", { printerId: "generic-belt-45", filamentId: "lime-pla" });
const beltSet = await call("settings_set", { values: { supportBeltHoldThin: true } });
check("no flat-printer warning on a belt", !JSON.stringify(beltSet.warnings ?? []).includes("belt printer"), JSON.stringify(beltSet));
await call("slice_start", { cancelRunning: true });
check("a belt slice sends both", sent().supportBeltHoldThin === true && sent().supportBridgeMm === 5 && !!sent().belt, engine.lastSlice.slice(0, 300));

await call("settings_set", { values: { supportBridgeMm: 0, supportBeltHoldThin: false } });
await call("slice_start", { cancelRunning: true });
check("turned off, neither is sent", !("supportBridgeMm" in sent()) && !("supportBeltHoldThin" in sent()));

const slice = GUIDES.find((guide) => guide.uri === "lime://guide/slice");
check("the slice guide names both keys", !!slice?.text.includes("supportBridgeMm") && !!slice?.text.includes("supportBeltHoldThin"));
check("settings_set has an example with both", JSON.stringify(EXAMPLES.settings_set).includes("supportBeltHoldThin") && JSON.stringify(EXAMPLES.settings_set).includes("supportBridgeMm"));

// Supports on one object while the plate's are off (feedback 2.10): the plate's support values reach that object.
{
  const own = new Session(fakeEngine());
  const ownEngine = own.engine as ReturnType<typeof fakeEngine>;
  const body = () => JSON.parse(ownEngine.lastSlice) as Record<string, unknown>;
  const objectsOf = () => (body().objects ?? []) as { settings?: Record<string, unknown> }[];
  await own.call("machine_select", { printerId: "generic-belt-45", filamentId: "lime-pla" });
  await own.call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
  await own.call("settings_set", { values: { supports: "off", supportBridgeMm: 5, supportBeltHoldThin: true } });
  await own.call("slice_start", { cancelRunning: true });
  const before = body().belt as Record<string, unknown>;
  check("plate supports off, no object on: no floorSupports", !("floorSupports" in before) && !("supportBridgeMm" in body()), ownEngine.lastSlice.slice(0, 400));

  const set = await own.call("settings_set", { allObjects: true, values: { supports: "auto" } });
  const keys = (set.changed as { key: string; to: unknown }[]).map((row) => `${row.key}=${String(row.to)}`);
  check("allObjects supports auto stores supports and supportSource", set.ok === true && keys.includes("supports=true") && keys.includes("supportSource=auto"), JSON.stringify(set));
  await own.call("slice_start", { cancelRunning: true });
  const after = body();
  check("the object's supports reach the belt: floorSupports is sent", (after.belt as Record<string, unknown>).floorSupports === true, ownEngine.lastSlice.slice(0, 600));
  check("the plate's own supports stay off", after.supports === false);
  check("the bridge limit and thin edges are sent for that object", after.supportBridgeMm === 5 && after.supportBeltHoldThin === true && after.supportBeltAnchorMm === 10, JSON.stringify(after).slice(0, 600));
  check("the object carries supports and Automatic", objectsOf()[0]?.settings?.supports === true && objectsOf()[0]?.settings?.supportSource === "auto", JSON.stringify(objectsOf()[0]?.settings));

  await own.call("settings_set", { values: { supports: "paint" } });
  await own.call("slice_start", { cancelRunning: true });
  check("on a Painted-only plate the object stays Automatic", body().supportSource === "paint" && objectsOf()[0]?.settings?.supportSource === "auto", JSON.stringify(objectsOf()[0]?.settings));
  const painted = await own.call("settings_set", { allObjects: true, values: { supports: "paint" } });
  check("an object set to Painted only stores supportSource paint", (painted.changed as { key: string; to: unknown }[]).some((row) => row.key === "supportSource" && row.to === "paint"), JSON.stringify(painted));
  const both = await own.call("settings_set", { allObjects: true, values: { supports: "auto", supportSource: "paint" } });
  check("a supportSource given beside supports wins", (both.changed as { key: string; to: unknown }[]).filter((row) => row.key === "supportSource").map((row) => row.to).join() === "paint", JSON.stringify(both));
  const badSource = await own.call("settings_set", { allObjects: true, values: { supportSource: "tree" } });
  check("a supportSource other than auto or paint is refused by name", badSource.ok === false && JSON.stringify(badSource).includes("supportSource must be"), JSON.stringify(badSource));
  await own.call("settings_set", { allObjects: true, values: { supports: "auto" } });

  // Flat bed: the plate's gap and bridge values reach the object too.
  await own.call("machine_select", { printerId: "lime-220", filamentId: "lime-pla" });
  await own.call("settings_set", { values: { supports: "off", supportZGapMm: 0.3 } });
  await own.call("settings_set", { allObjects: true, values: { supports: "auto" } });
  await own.call("slice_start", { cancelRunning: true });
  check("flat: the gap and bridge limit reach an object with its own supports", body().supportZGapMm === 0.3 && body().supportBridgeMm === 5 && !("belt" in body()), JSON.stringify(body()).slice(0, 600));
}

// The real engine, when it is built: the object's supports print on a belt with the plate's off.
const engineRoot = fileURLToPath(new URL("..", import.meta.url));
if (engineCandidates(engineRoot).some((path) => existsSync(path))) {
  const real = new Session(loadNativeEngine(engineRoot));
  const sliced = async () => {
    const job = await real.call("slice_start", { cancelRunning: true });
    const done = await real.call("slice_wait", { job: job.job });
    return { grams: Number(done.grams), done };
  };
  await real.call("machine_select", { printerId: "generic-belt-45", filamentId: "lime-pla" });
  await real.call("mesh_import", { path: fileURLToPath(new URL("../samples/overhang_ledge.stl", import.meta.url)) });
  await real.call("settings_set", { values: { supports: "off" } });
  const off = await sliced();
  await real.call("settings_set", { allObjects: true, values: { supports: "auto" } });
  const on = await sliced();
  console.log(`real engine belt: ${off.grams} g with supports off, ${on.grams} g with the object's own supports on`);
  check("real engine: the object's own supports print on a belt", on.grams > off.grams, `${JSON.stringify(off.done)} ${JSON.stringify(on.done)}`);
} else {
  console.log("real engine support check: skipped (build lime-mcp-engine to run)");
}

if (failed > 0) {
  console.error(`support-settings: ${failed} failed`);
  process.exit(1);
}
console.log("support-settings: ok");
