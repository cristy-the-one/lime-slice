/**
 * A vented plan applied through ribs_apply. The stand-in kernel does not build the solid the tray rays measure;
 * this is the step that failed before those rays ran: ribs_apply sends a ribNet whose paths carry openEnds, and the
 * op schema used to refuse that field, so the notch was never built.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine, ProtocolError } from "./engine.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-vents-apply-"));

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  console.error(`FAIL ${name}${text ? ` ${text.slice(0, 500)}` : ""}`);
}

const session = new Session(fakeEngine());
const call = (name: string, args: unknown = {}) => session.call(name, args) as Promise<Record<string, unknown>>;

const made = await call("solid_new", { primitive: "box", dx: 80, dy: 40, dz: 10 });
const bounds = made.bounds as { min: number[]; max: number[] } | null;
const object = String(made.object ?? "");
check("a box to put the notched ribs on", made.ok === true && bounds !== null && object !== "", made);
if (bounds) {
  const z = bounds.max[2]!;
  const y = (bounds.min[1]! + bounds.max[1]!) / 2;
  const left: [number, number, number][] = [[bounds.min[0]! + 8, y, z], [-0.375, y, z]];
  const right: [number, number, number][] = [[0.375, y, z], [bounds.max[0]! - 8, y, z]];
  const rib = (points: [number, number, number][], ends: [string, string]) => ({ points, heights: [6], width: 2.4, profile: "straight", ends });
  let applied: Record<string, unknown>;
  try {
    applied = await call("ribs_apply", {
      object,
      plan: {
        object,
        fingerprint: made.fingerprint,
        ribs: [rib(left, ["boundary", "gap"]), rib(right, ["gap", "boundary"])],
      },
    });
  } catch (err) {
    applied = { ok: false, reason: err instanceof ProtocolError ? err.message : String(err) };
  }
  const net = applied.ribNet as { ends?: { square?: number; joint?: number } } | undefined;
  check("ribs_apply builds a plan whose gap ends are openEnds", applied.ok === true && net?.ends?.square === 2 && net.ends.joint === 0, applied.ok === true ? net : applied);
}

if (failed) {
  console.error(`vents-apply: ${failed} failed`);
  process.exit(1);
}
console.log("vents-apply: ok");
