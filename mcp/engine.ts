/**
 * The slicer behind the tools. The session calls this interface.
 * The first implementation loads `lime-mcp-engine` in-process.
 * A later transport can replace the loader without changing the tool schemas.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export interface Engine {
  version(): string | Promise<string>;
  occt(): boolean | Promise<boolean>;
  meshPreview(body: string): string | Promise<string>;
  modelTree(body: string): string | Promise<string>;
  sliceStart(body: string): string | Promise<string>;
  slicePoll(id: string): string | Promise<string>;
  sliceCancel(id: string): string | Promise<string>;
}

type NativeExports = {
  version: () => string;
  occt: () => string;
  meshPreview: (body: string) => string;
  modelTree: (body: string) => string;
  sliceStart: (body: string) => string;
  slicePoll: (id: string) => string;
  sliceCancel: (id: string) => string;
};

export function engineLibraryName(): string {
  if (process.platform === "win32") return "lime_mcp_engine.dll";
  if (process.platform === "darwin") return "liblime_mcp_engine.dylib";
  return "liblime_mcp_engine.so";
}

export function engineCandidates(root: string): string[] {
  const name = engineLibraryName();
  const listed = [process.env.LIME_MCP_ENGINE, join(root, "target", "release", name), join(root, "target", "debug", name)];
  return listed.filter((path): path is string => !!path);
}

export function loadNativeEngine(root: string): Engine {
  const path = engineCandidates(root).find((candidate) => existsSync(candidate));
  if (!path) {
    throw new ProtocolError("The in-process engine was not found. Build it with cargo build -p lime-mcp-engine --release.");
  }
  const mod = { exports: {} as NativeExports };
  process.dlopen(mod, path);
  const native = mod.exports;
  if (typeof native.sliceStart !== "function") {
    throw new ProtocolError("The in-process engine loaded, but it did not export the slicer.");
  }
  return {
    version: () => native.version(),
    occt: () => native.occt() === "true",
    meshPreview: (body) => native.meshPreview(body),
    modelTree: (body) => native.modelTree(body),
    sliceStart: (body) => native.sliceStart(body),
    slicePoll: (id) => native.slicePoll(id),
    sliceCancel: (id) => native.sliceCancel(id),
  };
}

/**
 * The same addon, called from a worker thread so a long preview or slice
 * poll does not stop the stdio loop answering ping.
 */
export function loadEngineWorker(root: string): Engine {
  const worker = new Worker(new URL("./engine-worker.ts", import.meta.url), {
    workerData: { root },
    execArgv: ["--experimental-strip-types"],
  });
  let seq = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  const fail = (err: Error) => {
    for (const slot of pending.values()) slot.reject(err);
    pending.clear();
  };
  worker.on("message", (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.ok) slot.resolve(msg.result);
    else slot.reject(new ProtocolError(msg.error || "The engine call failed."));
  });
  worker.on("error", fail);
  const call = (method: string, arg = ""): Promise<unknown> => new Promise((resolve, reject) => {
    const id = seq;
    seq += 1;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, arg });
  });
  return {
    version: () => call("version") as Promise<string>,
    occt: () => call("occt").then((value) => value === true) as Promise<boolean>,
    meshPreview: (body) => call("meshPreview", body) as Promise<string>,
    modelTree: (body) => call("modelTree", body) as Promise<string>,
    sliceStart: (body) => call("sliceStart", body) as Promise<string>,
    slicePoll: (id) => call("slicePoll", id) as Promise<string>,
    sliceCancel: (id) => call("sliceCancel", id) as Promise<string>,
  };
}

function fakeSolid(): Record<string, unknown> {
  return {
    format: "lime-solid-2",
    id: 0,
    volumeMm3: 8000,
    solid: true,
    fingerprint: { volumeMm3: 8000, faces: 6, edges: 12 },
    positions: Buffer.alloc(9 * 4).toString("base64"),
    triangles: Buffer.alloc(4).toString("base64"),
    faces: [
      { areaMm2: 400, normal: [0, 0, 1] },
      { areaMm2: 400, normal: [0, 0, -1] },
      { areaMm2: 400, normal: [1, 0, 0] },
      { areaMm2: 400, normal: [0, 1, 0] },
      { areaMm2: 400 },
      { areaMm2: 400, normal: [-1, 0, 0] },
    ],
    edgeLengths: Array.from({ length: 12 }, () => 20),
    edgePoints: Buffer.alloc(12 * 2 * 3 * 4).toString("base64"),
    edgeOffsets: (() => {
      const words = new Uint32Array(13);
      for (let i = 0; i < 13; i += 1) words[i] = i * 2;
      return Buffer.from(words.buffer).toString("base64");
    })(),
  };
}

/** A stand-in for scripted tests. It does not slice. */
export function fakeEngine(): Engine & { lastSlice: string } {
  const jobs = new Map<number, { status: string; body: string; polls: number }>();
  let next = 0;
  const engine = {
    lastSlice: "",
    version: () => "1.8.0",
    occt: () => true,
    meshPreview: async (body: string) => {
      const block = Number(process.env.LIME_MCP_FAKE_BLOCK_MS ?? 0);
      if (block > 0) await new Promise((resolve) => setTimeout(resolve, block));
      const asked = JSON.parse(body) as { filename?: string };
      const positions = new Float32Array([
        0, 0, 0, 20, 0, 0, 20, 20, 0,
        0, 0, 0, 20, 20, 0, 0, 20, 0,
      ]);
      return JSON.stringify({
        triangles: 12,
        min: [0, 0, 0],
        max: [20, 20, 20],
        seatMm: 0,
        positionsB64: Buffer.from(positions.buffer).toString("base64"),
        filename: asked.filename ?? "mesh.stl",
      });
    },
    modelTree: (body: string) => {
      const req = JSON.parse(body) as { call?: string; op?: { radius?: number }; node?: number };
      if (req.call === "probe") {
        const radius = req.op?.radius ?? 0;
        if (radius > 8) return JSON.stringify({ ok: false, error: "The hole misses the solid." });
        return JSON.stringify({ ok: true });
      }
      if (req.call === "apply" || req.call === "edit") return JSON.stringify({ ok: true, id: req.node ?? 1 });
      if (req.call === "export") return JSON.stringify({ ok: true, step: "ISO-10303-21;\nENDSEC;\n" });
      if (req.call === "close") return JSON.stringify({ ok: true });
      return JSON.stringify(fakeSolid());
    },
    sliceStart: (body: string) => {
      engine.lastSlice = body;
      const id = next;
      next += 1;
      jobs.set(id, { status: "running", body, polls: 0 });
      return JSON.stringify({ id });
    },
    slicePoll: (id: string) => {
      const job = jobs.get(Number(id));
      if (!job) return JSON.stringify({ error: "That slice job is not in this session." });
      job.polls += 1;
      const need = Number(process.env.LIME_MCP_POLLS_UNTIL_DONE ?? 1);
      const untilDone = Number.isFinite(need) && need > 0 ? need : 1;
      if (job.status === "running" && job.polls >= untilDone) job.status = "done";
      const request = JSON.parse(job.body) as { layerActions?: { kind?: string; gcode?: string }[] };
      const extra = (request.layerActions ?? [])
        .filter((action) => action.kind === "customGcode" && action.gcode)
        .map((action) => action.gcode)
        .join("\n");
      const gcode = `; generated by Lime Slice — FDM strategy blender\n; TIME:12.0s FILAMENT_MM:100.00 FILAMENT_G:0.300\nG1 X0 Y0 E1\n${extra}\n`;
      return JSON.stringify({
        status: job.status,
        stage: job.status === "done" ? "done" : "toolpaths",
        fraction: job.status === "done" ? 1 : 0.4,
        result: job.status === "done" ? JSON.stringify({
          gcode,
          estimate: {
            seconds: 12,
            filamentMm: 100,
            filamentG: 0.3,
            byFeature: [{ kind: "outer", seconds: 12, filamentMm: 100, filamentG: 0.3 }],
          },
          warnings: [],
          layers: [{ z: 0.2, index: 0, seconds: 12 }, { z: 20, index: 99, seconds: 0 }],
          mesh: { triangles: 12 },
        }) : undefined,
      });
    },
    sliceCancel: (id: string) => {
      const job = jobs.get(Number(id));
      if (!job) return JSON.stringify({ ok: false, error: "That slice job is not in this session." });
      if (job.status === "running") job.status = "cancelled";
      return JSON.stringify({ ok: true, status: job.status });
    },
  };
  return engine;
}
