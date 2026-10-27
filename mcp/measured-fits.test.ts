/**
 * Split to print, milestone 11, through the MCP server against the stand-in engine: machine_set's `fits` enters coupon
 * results into the library, a cut made after it stores them, and a reset puts the starting values back. The plate's
 * filament is the library's default, PLA.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { TOOLS } from "./schema.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-fits-"));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const session = new Session(fakeEngine());
const call = (name: string, args: unknown = {}) => session.call(name, args);

const fitsOf = async () => (await call("machine_get", {})).measuredFits;
const wide = String((await call("solid_new", { primitive: "box", dx: 500, dy: 60, dz: 20 })).object);
const op = { kind: "partition", cuts: [{ origin: [0, 0, 10], normal: [1, 0, 0], connectors: { on: true, types: [{ type: "dowel", count: 2 }] } }], labels: { on: false } };
const applyOn = async (object: string) => {
  await call("model_probe", { object, op });
  return call("model_apply", { object, op });
};
const clearanceOf = (applied: Record<string, unknown>) => ((applied.stored as { cuts: { connectors: { types: { clearance: number }[] } }[] }).cuts[0]!.connectors.types[0]!.clearance);

check("nothing is measured to begin with", (await fitsOf()) === undefined);
const before = await applyOn(wide);
check("a cut stores PLA's starting Snug, 0.15", before.ok === true && clearanceOf(before) === 0.15, JSON.stringify(before));

const dry = await call("machine_set", { fits: { material: "PLA", snug: 0.18 }, dryRun: true });
check("dryRun reports the entry and writes nothing", dry.ok === true && dry.dryRun === true && String(dry.fits).startsWith("PLA measured: snug 0.18 mm each side") && (await fitsOf()) === undefined, JSON.stringify(dry));

const entered = await call("machine_set", { fits: { material: "PLA", snug: 0.18, press: 0.04 } });
check("entering results says what became measured", entered.ok === true && entered.fits === "PLA measured: snug 0.18 mm, press 0.04 mm each side. New cuts use it; applied cuts keep theirs.", JSON.stringify(entered));
check("machine_get reads them back", JSON.stringify(await fitsOf()) === JSON.stringify({ cells: { pla: { snug: 0.18, press: 0.04 } } }), JSON.stringify(await fitsOf()));

const wide2 = String((await call("solid_new", { primitive: "box", dx: 500, dy: 60, dz: 20 })).object);
const after = await applyOn(wide2);
check("a new cut stores the measured Snug", after.ok === true && clearanceOf(after) === 0.18, JSON.stringify(after));
check("the cut applied before keeps 0.15", clearanceOf(before) === 0.15 && JSON.stringify(((await call("model_history", { object: wide })).nodes as unknown[]).length) !== "0");

const resin = await call("machine_set", { fits: { material: "", process: "resin", snug: 0.12, wallMm: 0.6 } });
check("a resin entry takes the wall", resin.ok === true && String(resin.fits).startsWith("Standard resin (Form 4) measured: snug 0.12 mm, wall 0.6 mm") && JSON.stringify(await fitsOf()) === JSON.stringify({ cells: { pla: { snug: 0.18, press: 0.04 }, resin: { snug: 0.12 } }, resinFeatureMm: 0.6 }), JSON.stringify(await fitsOf()));

const refusals: [string, unknown, string][] = [
  ["a material with no row", { material: "Nylon", snug: 0.1 }, "No fit row for Nylon."],
  ["a negative gap", { material: "PLA", snug: -0.1 }, "fits: snug is a gap each side from 0 to 2 mm"],
  ["a string", { material: "PLA", snug: "0.1" }, "fits.snug is a number of millimetres."],
  ["an empty entry", { material: "PLA" }, "fits: Give at least one of snug, loose, press"],
  ["a wall on an FDM row", { material: "PLA", wallMm: 0.5 }, "fits.wallMm is for the resin row."],
  ["a bad process", { material: "PLA", process: "sla", snug: 0.1 }, "fits.process is fdm or resin."],
];
for (const [name, fits, reason] of refusals) {
  const said = await call("machine_set", { fits });
  check(`${name} is refused with a sentence`, said.ok === false && String(said.reason).startsWith(reason), JSON.stringify(said));
}
check("the refusals changed nothing", JSON.stringify((await fitsOf() as { cells: { pla: unknown } }).cells.pla) === JSON.stringify({ snug: 0.18, press: 0.04 }));

const reset = await call("machine_set", { fits: { material: "PLA", reset: true } });
check("reset puts one row's starting values back and leaves the others", reset.ok === true && reset.fits === "PLA is back to its starting values." && JSON.stringify(await fitsOf()) === JSON.stringify({ cells: { resin: { snug: 0.12 } }, resinFeatureMm: 0.6 }), JSON.stringify(await fitsOf()));
const wide3 = String((await call("solid_new", { primitive: "box", dx: 500, dy: 60, dz: 20 })).object);
check("a cut after the reset is back at 0.15", clearanceOf(await applyOn(wide3)) === 0.15);
await call("machine_set", { fits: { material: "", process: "resin", reset: true } });
check("resetting the last row leaves nothing", (await fitsOf()) === undefined);

// No new tool; the schema and the guide say where results go.
const setTool = TOOLS.find((tool) => tool.name === "machine_set")!;
check("machine_set's schema names fits", JSON.stringify(setTool.inputSchema).includes("\"fits\""));
check("no tool was added for it", !TOOLS.some((tool) => /fit/i.test(tool.name) && tool.name !== "machine_set"));
check("the ops guide says how to enter results", JSON.stringify(await session.resource("lime://guide/ops")).includes("machine_set {fits:"));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("measured-fits: ok");
