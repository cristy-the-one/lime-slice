/**
 * motion_run over MCP (docs/plan-hinge-dynamics.md), on the fake engine. The escapement's parts are horology's outlines
 * (src/graham.ts, held to the crate by mcp/graham-port.test.ts) extruded into STL files and imported, so every mesh is
 * real; a rod and a bob ride on the anchor; the frame is a slab. No kernel call decides anything here.
 *
 * - The call becomes a job past the reply time; slice_wait returns a converged "runs" reply with its sentences, the
 *   inputs and defaults used, what is left out, the fit against the meshes and the friction sweep.
 * - slice_cancel stops a run between slices.
 * - keys:true gives a key per 1/fps s; out writes a GIF and PNG frames through pose_animate's writer, as many frames as
 *   the sampler makes of those keys, and nothing on the plate moves.
 * - Refusals: numbers that do not fit the parts, a drive on the frame, a part outside the assembly.
 */
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-motion-"));
process.env.LIME_MCP_REPLY_S = "1";
const { fakeEngine } = await import("./engine.ts");
const { Session } = await import("./session.ts");
const { validateTool } = await import("./schema.ts");
const { clockMeshes } = await import("../src/escapement-parts.ts");
const { escapeWheel, graham, restPose } = await import("../src/graham.ts");
const { box } = await import("../src/box-mesh.ts");

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) { console.log(`ok   ${name}`); return; }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}
type Reply = Record<string, unknown>;
const s = new Session(fakeEngine());
const call = async (name: string, input: Reply = {}) => (await s.call(name, input)) as Reply;
const ok = async (name: string, input: Reply) => { const r = await call(name, input); if (r.ok !== true) throw new Error(`${name}: ${JSON.stringify(r)}`); return r; };
const stl = (pos: Float32Array) => {
  const n = pos.length / 9, b = Buffer.alloc(84 + 50 * n);
  b.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i += 1) for (let k = 0; k < 9; k += 1) b.writeFloatLE(pos[i * 9 + k]!, 84 + 50 * i + 12 + 4 * k);
  return b;
};
const part = async (name: string, positions: Float32Array) => {
  const path = join(process.env.LIME_MCP_WORKSPACE!, `${name}.stl`);
  writeFileSync(path, stl(positions));
  const made = await ok("mesh_import", { path });
  return String(made.object);
};
const wait = async (reply: Reply): Promise<Reply> => {
  let r = reply;
  while (r.status === "running") r = await call("slice_wait", { job: r.job, timeoutS: 30 });
  return r;
};

// The clock, in model space (the parts' own frames are their STL coordinates): the wheel turns about +Y at the origin,
// the anchor about +Y at horology's pivot distance above it.
const g = graham(escapeWheel(30, 22.5, 17.5, 12), 7.5);
const meshes = clockMeshes(g, (restPose(g) as [number, number])[0] - 0.3);
if ("reason" in meshes) throw new Error(meshes.reason);
const d = meshes.pivotDistance;
const frame = await part("Frame", box(120, 4, 200, [0, -10, 40]));
const wheel = await part("Escape wheel", meshes.wheel);
const anchor = await part("Anchor", meshes.anchor);
const rod = await part("Rod", box(3, 3, 140, [0, 12, d - 70]));
const bob = await part("Bob", box(30, 6, 30, [0, 12, d - 140]));
for (const id of [wheel, anchor]) await ok("model_place", { object: id, to: frame });
for (const id of [rod, bob]) await ok("model_place", { object: id, to: anchor });
await ok("model_place", { object: wheel, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0] } });
await ok("model_place", { object: anchor, joint: { kind: "hinge", pivot: [0, 0, d], axis: [0, 1, 0] } });
const escapement = { wheel, anchor, teeth: 30, tip: 22.5, root: 17.5, lean: 12, span: 7.5 };
const before = JSON.stringify(s.assemblies);

check("motion_run takes its fields", validateTool("motion_run", { object: wheel, escapement, drive: { member: wheel, torque: 0.25 }, seconds: 12 }) === null);
check("a drive needs its member", validateTool("motion_run", { object: wheel, drive: { torque: 1 } }) !== null);
check("findStart is a field", validateTool("motion_run", { object: wheel, escapement, drive: { member: wheel, torque: 0.25 }, findStart: true }) === null);

// --- A run, as a job.
{
  const started = await call("motion_run", { object: wheel, escapement, drive: { member: wheel, torque: 0.25 }, seconds: 12, push: 3.5, sweep: [0.3, 0.6], density: 1.24 });
  check(`past the reply time it answers with a job (${started.status})`, started.status === "running" && typeof started.job === "string", started);
  const r = await wait(started);
  check(`slice_wait gives the run: verdict ${r.verdict}, converged ${JSON.stringify(r.converged)}`, r.ok === true && r.verdict === "runs" && (r.converged as { ok: boolean }).ok === true, r);
  const push = r.fromPush as Reply;
  check(`from a 3.5° push: steady ${push.steadyAmplitudeDeg}°, period ${push.periodS} s, one tooth a period (${push.wheelTeethPerPeriod})`, push.runs === true && typeof push.steadyAmplitudeDeg === "number" && Math.abs((push.wheelTeethPerPeriod as number) - 1) < 1e-3, push);
  const rest = r.fromRest as Reply;
  check(`from rest it never starts, and says where: ${JSON.stringify(rest.stall)}`, rest.selfStarts === false && String((rest.stall as Reply)?.where).includes("impulse face"), rest);
  const stall = rest.stall as Reply;
  check(`let go as posed: releaseDeg ${rest.releaseDeg}° from where it hangs, state ${rest.state}, the stall from the run's history (teeth ${stall.teethEscaped}, anchor ${stall.anchorReachDeg}° of the ${stall.letoffDeg}° let-off, unlocks ${stall.unlocks}), the run ended at ${rest.endedAtS} s`, typeof rest.releaseDeg === "number" && rest.state === "stalls" && stall.teethEscaped === 0 && stall.unlocks === false && typeof rest.endedAtS === "number" && (rest.endedAtS as number) < 12, rest);
  check(`the push run's swing: each side's mean and trend, settled (${push.plusSideDeg}°, ${push.minusSideDeg}°, ${push.trendDegPerPeriod}° a period)`, push.settled === true && typeof push.plusSideDeg === "number" && typeof push.minusSideDeg === "number" && Math.abs(push.trendDegPerPeriod as number) <= 0.002, push);
  check(`agree is in the reply (${JSON.stringify(r.agree)}) and the amplitudes carry their side`, typeof (r.agree as Reply)?.ok === "boolean" && (r.amplitudeOverTime as { side: number }[]).every((row) => row.side === 1 || row.side === -1), r.agree);
  const inputs = r.inputs as Reply;
  check("inputs name every default used", inputs.friction === 0.3 && inputs.pinRadiusMm === 1.5 && inputs.restitution === 0 && (inputs.defaults as string[]).length === 3, inputs);
  check("leftOut and the fit are in the reply", (r.leftOut as string[]).some((line) => line.includes("infill")) && (r.fit as { wheelResidualMm: number }).wheelResidualMm < 0.02, r.fit);
  const sweep = r.sweep as Reply[];
  check(`the sweep: runs at 0.3, stops at 0.6 (${JSON.stringify(sweep)})`, sweep[0]?.runs === true && sweep[1]?.runs === false && sweep[1]?.state === "stalls");
  check("every sweep row carries its last swing, and why where a value is missing", sweep.every((row) => typeof row.lastAmplitudeDeg === "number" && (row.settled === true || typeof row.why === "string")), sweep);
  check("sentences say it in words", (r.sentences as string[]).some((line) => line.startsWith("From a 3.5° push (the anchor 3.5° from its middle; it unlocks at 2°), it runs: the escape wheel turns a tooth a period")) && !(r.sentences as string[]).some((line) => line.includes("swings 0° each side")) && (r.sentences as string[]).some((line) => line.includes("depends on friction")), r.sentences);
  check("nothing on the plate moved", JSON.stringify(s.assemblies) === before);
  console.log((r.sentences as string[]).map((line) => `     ${line}`).join("\n"));
}

// --- slice_cancel stops a run between slices.
{
  const started = await call("motion_run", { object: wheel, escapement, drive: { member: wheel, torque: 0.25 }, seconds: 120, sweep: false });
  check("a long run is a job", started.status === "running", started);
  const cancelled = await wait(await call("slice_cancel", { job: started.job }));
  check(`slice_cancel stops it: ${cancelled.code} "${cancelled.reason}"`, cancelled.ok === false && cancelled.code === "cancelled", cancelled);
}

// --- Keys and frames.
{
  const r = await wait(await call("motion_run", { object: wheel, escapement, drive: { member: wheel, torque: 0.25 }, seconds: 2, push: 3.5, sweep: false, keys: true, fps: 5, out: { gif: "run.gif", frames: "run-frames" }, longEdge: 96 }));
  const animation = r.animation as { fps: number; keys: { t: number; set: Record<string, number> }[] };
  check(`keys: ${animation?.keys.length} at multiples of 1/5 s from 0 to 2`, animation?.fps === 5 && animation.keys.length === 11 && animation.keys.every((key, k) => Math.abs(key.t - k / 5) < 1e-9), animation?.keys.map((key) => key.t));
  check("each key sets the wheel and the anchor", animation?.keys.every((key) => Object.keys(key.set).length === 2), animation?.keys[0]);
  const frames = r.frames as { count: number };
  const files = r.files as { gif: string; frames: string; count: number };
  const pngs = readdirSync(join(process.env.LIME_MCP_WORKSPACE!, "run-frames")).filter((name) => name.endsWith(".png"));
  check(`out writes the GIF and ${pngs.length} PNG frames, as many as the sampler made (${frames?.count}), no .partial left`, existsSync(files?.gif) && pngs.length === frames.count && files.count === frames.count && !readdirSync(process.env.LIME_MCP_WORKSPACE!).some((name) => name.endsWith(".partial")), { files, frames, pngs: pngs.length });
}

// --- Refusals.
{
  const bad = await wait(await call("motion_run", { object: wheel, escapement: { ...escapement, span: 8.5 }, drive: { member: wheel, torque: 0.25 }, seconds: 1 }));
  check(`numbers that do not fit: motion-refused, "${bad.reason}"`, bad.ok === false && bad.code === "motion-refused" && String(bad.reason).includes("pivot is"), bad);
  const still = await wait(await call("motion_run", { object: wheel, drive: { member: frame, torque: 1 }, seconds: 1 }));
  check(`a drive on the frame: "${still.reason}"`, still.ok === false && still.code === "motion-refused" && String(still.reason).includes("does not move"), still);
  const lone = await part("Loose", box(5, 5, 5, [300, 0, 0]));
  const outside = await call("motion_run", { object: wheel, drive: { member: lone, torque: 1 } });
  check(`a part outside the assembly: "${outside.reason}"`, outside.ok === false && outside.code === "bad-argument", outside);
}

if (failed) { console.error(`motion: ${failed} failed`); process.exit(1); }
console.log("motion: all passed");
process.exit(0);
