/**
 * A rerun's assemblies take the old parts' handles (src/recipe/rerun-assembly.ts). A found gear mesh names its gears; a
 * declared coupling (docs/plan-coupling-kinds.md) has none, and a ratchet may name the part that is its click. Both
 * kinds must come through a rerun under the old handles.
 */
import type { Assembly, Coupling } from "../assembly.ts";
import { rerunAssemblies, rerunAssembliesReport, rerunSet } from "./rerun-assembly.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got), right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}

const hinge = { kind: "hinge" as const, pivot: [0, 0, 0] as [number, number, number], axis: [0, 0, 1] as [number, number, number], angle: 0 };
const member = (object: string, parent: string | null, joint = true) => ({ object, parent, offset: [0, 0, 0], turn: [0, 0, 0], ...(joint && parent !== null ? { joint: hinge } : {}) });
const mesh: Coupling = { driver: "n1", driven: "n2", ratio: -0.5, gears: [{ object: "n1", step: null, name: "Pinion" }, { object: "n2", step: null, name: "Wheel" }] };
const ratio: Coupling = { driver: "n2", driven: "n3", ratio: 2, kind: "ratio", names: ["Wheel", "Hand"], on: ["hinge", "hinge"] };
const ratchet: Coupling = { driver: "n3", driven: "n0", ratio: 1, kind: "ratchet", names: ["Hand", "Frame"], on: ["hinge", "fixed"], free: -1, click: { object: "n4", name: "Click", teeth: 20, tip: 12, root: 10.2, arm: 10, sense: 1, zero: 0, phase: 0, lift: 9.26 } };

// The old run's assembly under handles o0..o4; the new run built the same under n0..n4.
const old: Assembly = { id: "a_old", name: "Train", members: [member("o0", null), member("o1", "o0"), member("o2", "o0"), member("o3", "o0"), member("o4", "o0")] } as unknown as Assembly;
const built: Assembly = { id: "a_new", name: "Train", members: [member("n0", null), member("n1", "n0"), member("n2", "n0"), member("n3", "n0"), member("n4", "n0")], couplings: [mesh, ratio, ratchet] } as unknown as Assembly;
const renamed = new Map([["n0", "o0"], ["n1", "o1"], ["n2", "o2"], ["n3", "o3"], ["n4", "o4"]]);

const out = rerunAssemblies([old, built], renamed);
eq("one assembly, under the old one's id", out.map((row) => row.id), ["a_old"]);
eq("its members are the old handles", out[0]!.members.map((row) => row.object), ["o0", "o1", "o2", "o3", "o4"]);
const rows = out[0]!.couplings ?? [];
eq("every coupling came through, found and declared", rows.map((row) => [row.kind ?? "mesh", row.driver, row.driven]), [["mesh", "o1", "o2"], ["ratio", "o2", "o3"], ["ratchet", "o3", "o0"]]);
eq("a found mesh's gears name the old handles", rows[0]!.gears?.map((gear) => gear.object), ["o1", "o2"]);
eq("a declared coupling still has no gears", [rows[1]!.gears, rows[2]!.gears], [undefined, undefined]);
eq("a ratchet's click names the old handle", rows[2]!.click?.object, "o4");

// --- The window's rebuild of a set (docs/plan-plugin-recipes.md 6.4): the new parts, in the order made, take the old
// handles one for one; the new run's assembly, with an id the project already has, still lands in the old one's place.
{
  const clash: Assembly = { ...built, id: "a_old" } as Assembly;
  const set = rerunSet(["o0", "o1", "o2", "o3", "o4"], ["n0", "n1", "n2", "n3", "n4"], [old], [clash]);
  eq("a set: the handles one for one", "renamed" in set ? [...set.renamed] : set, [["n0", "o0"], ["n1", "o1"], ["n2", "o2"], ["n3", "o3"], ["n4", "o4"]]);
  eq("a set: one assembly, the old id, the old handles, coupled", "renamed" in set ? set.assemblies.map((row) => [row.id, row.members.map((m) => m.object).join(), (row.couplings ?? []).length]) : set, [["a_old", "o0,o1,o2,o3,o4", 3]]);
  eq("a set that grew is refused with both counts", rerunSet(["o0", "o1"], ["n0", "n1", "n2"], [old], [clash]), { made: 3, had: 2 });
  const none = rerunSet(["o0", "o1", "o2", "o3", "o4"], ["n0", "n1", "n2", "n3", "n4"], [], [built]);
  eq("with no old assembly, the new one comes in under the old handles", "renamed" in none ? none.assemblies.map((row) => [row.id, row.members[0]!.object]) : none, [["a_new", "o0"]]);
}

// --- Loops (docs/plan-pose-loops.md): the new run's pins come through under the old handles, a loop to a part from
// outside the run is kept, and one that cannot be carried is reported, never dropped without a word.
{
  const pin = (id: string, a: string, b: string) => ({ id, kind: "pin" as const, a: { member: a, at: [0, 0, 0] as [number, number, number] }, b: { member: b, at: [0, 0, 0] as [number, number, number] } });
  const oldLoops: Assembly = { ...old, members: [...old.members, member("hand", "o0")], closures: [pin("loop_1", "o1", "o2"), pin("loop_2", "o3", "hand"), pin("loop_3", "o4", "gone")] } as unknown as Assembly;
  const builtLoops: Assembly = { ...built, couplings: [], closures: [pin("loop_1", "n1", "n2"), pin("loop_2", "n3", "n2")] } as unknown as Assembly;
  const report = rerunAssembliesReport([oldLoops, builtLoops], renamed);
  const rows = report.assemblies[0]!.closures ?? [];
  eq("a rerun keeps the new run's loops, on the old handles", rows.slice(0, 2).map((row) => [row.id, row.a.member, row.b.member]), [["loop_1", "o1", "o2"], ["loop_2", "o3", "o2"]]);
  eq("a loop from a run part to an outside part is kept, renumbered when its id is taken", rows.slice(2).map((row) => [row.id, row.a.member, row.b.member]), [["loop_2_1", "o3", "hand"]]);
  eq("a loop that names a part no longer there is reported", report.dropped, ["loop_3 (o4 to gone)"]);
  eq("rerunAssemblies gives the same assemblies", rerunAssemblies([oldLoops, builtLoops], renamed).map((row) => row.closures?.length), [3]);
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("rerun-assembly: ok");
