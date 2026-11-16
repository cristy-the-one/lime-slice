/**
 * Support thin belt edges (supportBeltHoldThin) and the bridge limit (supportBridgeMm) through the MCP tools:
 * settings_set takes and refuses them as the panel does, settings_schema reads them back, and slice_start sends
 * them only when set (and the belt key only on a belt printer).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
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

if (failed > 0) {
  console.error(`support-settings: ${failed} failed`);
  process.exit(1);
}
console.log("support-settings: ok");
