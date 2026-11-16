/**
 * The README's media that start over MCP, made with the real engine (docs/readme-media.md):
 *   - artifacts/readme-media/gear-train.lime: three spur gears at mesh, uncoupled, for tools/readme-media/pose.media.ts;
 *   - artifacts/readme-media/lettering.lime: a cylinder with text wrapped round it, for model.media.ts;
 *   - docs/screenshots/clip-escapement.gif: a Graham escapement run in time by motion_run, drawn by the server.
 * Run from the repository root:
 *   node --experimental-strip-types --no-warnings tools/readme-media/mcp-media.ts
 * with LIME_MCP_ENGINE (the release lime_mcp_engine library) and LIME_OCCT_BRIDGE set. The plugin library is an empty
 * folder of its own, so nothing from a personal library ends up in a picture.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const artifacts = join(root, "artifacts", "readme-media");
const shots = process.env.LIME_MEDIA_OUT ?? join(root, "docs", "screenshots");
mkdirSync(artifacts, { recursive: true });
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-readme-ws-"));
process.env.LIME_PLUGINS_DIR = mkdtempSync(join(tmpdir(), "lime-readme-plugins-"));

const { loadEngineWorker } = await import("../../mcp/engine.ts");
const { Session } = await import("../../mcp/session.ts");
const session = new Session(loadEngineWorker(root));
const call = async (name: string, input: Record<string, unknown> = {}) => {
  const reply = (await session.call(name, input)) as Record<string, unknown>;
  if (reply.ok !== true) throw new Error(`${name}: ${JSON.stringify(reply).slice(0, 600)}`);
  return reply;
};
const wait = async (reply: Record<string, unknown>) => {
  let r = reply;
  while (r.status === "running") r = await call("slice_wait", { job: r.job, timeoutS: 60 });
  return r;
};

// Three gears at mesh, as a person leaves them after making them in Model and placing them where the gear card says
// they mesh: no hinge, no assembly. Couple gears in Pose does the rest (pose.media.ts).
{
  const pinion = String((await call("solid_new", { gear: { teeth: 12, module: 2, thickness: 6, bore: 5 }, name: "Pinion" })).object);
  const wheel = String((await call("solid_new", { gear: { teeth: 24, module: 2, thickness: 6, bore: 5, phaseDeg: 172.5 }, name: "Wheel" })).object);
  const idler = String((await call("solid_new", { gear: { teeth: 18, module: 2, thickness: 6, bore: 5, phaseDeg: 180 }, name: "Idler" })).object);
  for (const [object, x] of [[wheel, 36], [idler, 78]] as const) await call("model_place", { object, x, y: 0, z: 0 });
  const saved = await call("project_save", { name: "gear-train.lime" });
  copyFileSync(String(saved.path), join(artifacts, "gear-train.lime"));
  console.log(JSON.stringify({ gearTrain: { pinion, wheel, idler } }));
  await call("object_remove", { objects: [pinion, wheel, idler] });
}

// Lettering on a curved face: a 44 mm drum with raised Inter letters wrapped round it.
{
  const drum = String((await call("solid_new", { primitive: "cylinder", radius: 22, height: 30, name: "Drum" })).object);
  const found = await call("faces_find", { object: drum, kind: "cylinder" });
  const face = (found.faces as { index: number }[])[0]!.index;
  await call("model_apply", { object: drum, op: { kind: "text", faceIndex: face, text: "Lime Slice", font: "sans", style: "bold", height: 7, depth: 1.2, point: [15.556, -15.556, 15] }, commit: true });
  const saved = await call("project_save", { name: "lettering.lime" });
  copyFileSync(String(saved.path), join(artifacts, "lettering.lime"));
  console.log(JSON.stringify({ lettering: drum }));
  await call("object_remove", { objects: [drum] });
}

// A Graham escapement from horology's outlines (30 teeth, tip 22.5, root 17.5, lean 12, span 7.5): the wheel on a hinge
// about +Y, the anchor on a hinge above it, a rod and a bob on the anchor. motion_run drives the wheel with a small
// torque, gives the pendulum a push and draws the run.
{
  const { clockMeshes } = await import("../../src/escapement-parts.ts");
  const { escapeWheel, graham, restPose } = await import("../../src/graham.ts");
  const { box } = await import("../../src/box-mesh.ts");
  const g = graham(escapeWheel(30, 22.5, 17.5, 12), 7.5);
  const meshes = clockMeshes(g, (restPose(g) as [number, number])[0] - 0.3);
  if ("reason" in meshes) throw new Error(meshes.reason);
  const d = meshes.pivotDistance;
  const part = async (name: string, positions: Float32Array) => {
    const n = positions.length / 9, bytes = Buffer.alloc(84 + 50 * n);
    bytes.writeUInt32LE(n, 80);
    for (let i = 0; i < n; i += 1) for (let k = 0; k < 9; k += 1) bytes.writeFloatLE(positions[i * 9 + k]!, 84 + 50 * i + 12 + 4 * k);
    const path = join(process.env.LIME_MCP_WORKSPACE!, `${name}.stl`);
    writeFileSync(path, bytes);
    return String((await call("mesh_import", { path })).object);
  };
  const frame = await part("Frame", box(64, 4, 64, [0, -10, d / 2]));
  const wheel = await part("Escape wheel", meshes.wheel);
  const anchor = await part("Anchor", meshes.anchor);
  const rod = await part("Rod", box(3, 3, 140, [0, 12, d - 70]));
  const bob = await part("Bob", box(30, 6, 30, [0, 12, d - 140]));
  for (const id of [wheel, anchor]) await call("model_place", { object: id, to: frame });
  for (const id of [rod, bob]) await call("model_place", { object: id, to: anchor });
  await call("model_place", { object: wheel, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0] } });
  await call("model_place", { object: anchor, joint: { kind: "hinge", pivot: [0, 0, d], axis: [0, 1, 0] } });
  const escapement = { wheel, anchor, teeth: 30, tip: 22.5, root: 17.5, lean: 12, span: 7.5 };
  const run = await wait(await call("motion_run", {
    object: wheel, escapement, drive: { member: wheel, torque: 0.25 }, seconds: 6, push: 3.5, sweep: false, keys: true, fps: 12,
    camera: { direction: [0, 1, 0.12], up: [0, 0, 1] }, longEdge: 600, background: "#15171a", out: { gif: "escapement.gif" },
  }));
  console.log(JSON.stringify({ escapement: { verdict: run.verdict, sentences: run.sentences } }, null, 1));
  // The server's GIF, cropped to the clock and re-encoded at fewer colours to keep the repository light.
  const raw = join(process.env.LIME_MCP_WORKSPACE!, "escapement.gif");
  const out = join(shots, "clip-escapement.gif");
  execFileSync(process.env.FFMPEG ?? "ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-vf", "crop=300:600:150:0,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle", "-loop", "0", out]);
  console.log(`clip-escapement.gif ${statSync(out).size} bytes (server GIF ${statSync(raw).size})`);
}
process.exit(0);
