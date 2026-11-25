import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-assembly-link-"));
const s = new Session(fakeEngine());

const make = async (name: string, x: number) => {
  const made = await s.call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 4, name });
  const id = String(made.object);
  await s.call("model_place", { object: id, x, z: 3 });
  return id;
};
const at = (id: string) => [...s.find(id)!.modelPose.t];

const parent = await make("cover.stl", 0);
const child = await make("hook.stl", 20);
const parentAt = at(parent);
const childAt = at(child);
const linked = await s.call("assembly_link", { child, parent });
if (linked.ok !== true || Number(s.assemblies.length) !== 1) throw new Error(`free parts did not link: ${JSON.stringify(linked)}`);
if (s.assemblies[0]!.name !== "cover") throw new Error(`assembly was not named after the parent: ${s.assemblies[0]!.name}`);
if (s.assemblies[0]!.members.map((row) => [row.object, row.parent]).join() !== [[parent, null], [child, parent]].join()) throw new Error(`members: ${JSON.stringify(s.assemblies[0]!.members)}`);
if (JSON.stringify(at(parent)) !== JSON.stringify(parentAt) || JSON.stringify(at(child)) !== JSON.stringify(childAt)) throw new Error("linking moved a part");
if (s.find(child)!.frame !== "part" || s.find(parent)!.frame === "part") throw new Error(`frames child=${s.find(child)!.frame} parent=${s.find(parent)!.frame}`);

const extra = await make("clip.stl", 40);
const extraAt = at(extra);
const joined = await s.call("assembly_link", { child: extra, parent });
if (joined.ok !== true || Number(s.assemblies.length) !== 1 || s.assemblies[0]!.members.length !== 3) throw new Error(`did not join the existing assembly: ${JSON.stringify(joined)}`);
if (JSON.stringify(at(extra)) !== JSON.stringify(extraAt)) throw new Error("joining an existing assembly moved the part");

const otherParent = await make("base.stl", 80);
const otherChild = await make("pin.stl", 90);
const other = await s.call("assembly_link", { child: otherChild, parent: otherParent });
if (other.ok !== true || Number(s.assemblies.length) !== 2) throw new Error(`second assembly was not made: ${JSON.stringify(other)}`);
const taken = await s.call("assembly_link", { child, parent: otherParent });
const takenReason = String(taken.reason ?? "");
if (taken.ok !== false || !takenReason.includes("already in") || takenReason.split(".").filter((part) => part.trim()).length !== 1 || Number(s.assemblies.length) !== 2) {
  throw new Error(`a part in another assembly was not refused in one sentence: ${JSON.stringify(taken)}`);
}

const mid = await make("mid.stl", 30);
const tip = await make("tip.stl", 50);
await s.call("assembly_link", { child: mid, parent: extra });
await s.call("assembly_link", { child: tip, parent: mid });
const cycle = await s.call("assembly_link", { child: mid, parent: tip });
const cycleReason = String(cycle.reason ?? "");
if (cycle.ok !== false || !cycleReason.includes("loop") || cycleReason.split(".").filter((part) => part.trim()).length !== 1) {
  throw new Error(`a cycle was not refused in one sentence: ${JSON.stringify(cycle)}`);
}

console.log("assembly_link: ok");
