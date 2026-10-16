/**
 * The slicer behind the tools. The session calls this interface.
 * The first implementation loads `lime-mcp-engine` in-process.
 * A later transport can replace the loader without changing the tool schemas.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

/** The bridge search is next to the running program. For this server, that program is node. */
export function occtHint(error: string): string {
  if (!error.includes("Open CASCADE")) return error;
  if (error.includes("LIME_OCCT_BRIDGE")) return error;
  return `${error} Set LIME_OCCT_BRIDGE to the bridge library, or put it next to node.`;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export interface Engine {
  version(): string | Promise<string>;
  occt(): boolean | Promise<boolean>;
  /** `bytes` is encoded in the worker. The string stays small. */
  meshPreview(body: string, bytes?: Uint8Array): string | Promise<string>;
  modelTree(body: string): string | Promise<string>;
  /** `bytes` is the mesh. The worker inserts `dataB64` before the slicer sees the body. */
  sliceStart(body: string, bytes?: Uint8Array): string | Promise<string>;
  slicePoll(id: string): string | Promise<string>;
  sliceCancel(id: string): string | Promise<string>;
  /** Drop a stuck modeler and start another. Slicing keeps its own worker. */
  resetModeler(): void | Promise<void>;
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
  // A set path is the library. A missing file fails here instead of falling through to another build.
  if (process.env.LIME_MCP_ENGINE) return [process.env.LIME_MCP_ENGINE];
  return [join(root, "target", "release", name), join(root, "target", "debug", name)];
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
    meshPreview: (body, bytes) => native.meshPreview(withMesh(body, bytes)),
    modelTree: (body) => native.modelTree(body),
    sliceStart: (body, bytes) => native.sliceStart(withMesh(body, bytes)),
    slicePoll: (id) => native.slicePoll(id),
    sliceCancel: (id) => native.sliceCancel(id),
    resetModeler: () => undefined,
  };
}

/** Put the mesh into `dataB64`. Used when the caller is already off the stdio thread. */
export function withMesh(body: string, bytes?: Uint8Array): string {
  if (!bytes) return body;
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (typeof parsed.dataB64 !== "string" || parsed.dataB64 === "") parsed.dataB64 = Buffer.from(bytes).toString("base64");
  return JSON.stringify(parsed);
}

interface WorkerCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * One addon in a worker thread. A load failure is remembered, so later calls
 * fail at once instead of waiting on a thread that has already exited.
 * `role` is "slice" or "model": a stuck modeler is replaced without dropping the slicer.
 */
class EngineWorker {
  private worker: Worker;
  private seq = 0;
  private generation = 0;
  private pending = new Map<number, WorkerCall>();
  private failed: Error | null = null;
  private readonly root: string;
  private readonly role: "slice" | "model";

  constructor(root: string, role: "slice" | "model") {
    this.root = root;
    this.role = role;
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const generation = this.generation;
    const worker = new Worker(new URL("./engine-worker.ts", import.meta.url), {
      workerData: { root: this.root, role: this.role },
      execArgv: ["--experimental-strip-types"],
    });
    worker.on("message", (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      if (generation !== this.generation) return;
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.ok) slot.resolve(msg.result);
      else slot.reject(new ProtocolError(msg.error || "The engine call failed."));
    });
    const fail = (err: Error) => {
      if (generation !== this.generation) return;
      this.failed = err;
      for (const slot of this.pending.values()) slot.reject(err);
      this.pending.clear();
    };
    worker.on("error", (err) => fail(err instanceof ProtocolError ? err : new ProtocolError(err.message)));
    worker.on("exit", (code) => {
      if (generation !== this.generation || this.failed) return;
      fail(new ProtocolError(code === 0
        ? "The in-process engine was not found. Build it with cargo build -p lime-mcp-engine --release."
        : `The engine stopped (code ${code}). Build it with cargo build -p lime-mcp-engine --release.`));
    });
    return worker;
  }

  call(method: string, arg = "", bytes?: Uint8Array): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const id = this.seq;
      this.seq += 1;
      this.pending.set(id, { resolve, reject });
      const copy = bytes ? bytes.slice() : undefined;
      this.worker.postMessage({ id, method, arg, bytes: copy }, copy ? [copy.buffer] : []);
    });
  }

  /** Kill a runaway modeler. The next call loads a fresh one. Pending calls are rejected. */
  restart(): void {
    const previous = this.worker;
    this.generation += 1;
    this.failed = null;
    for (const slot of this.pending.values()) slot.reject(new ProtocolError("The modeler was restarted."));
    this.pending.clear();
    void previous.terminate();
    this.worker = this.spawn();
  }
}

/**
 * The same addon, called from worker threads so a long preview or slice
 * poll does not stop the stdio loop answering ping. Model edits use their own
 * worker, so a fillet that runs away can be replaced without losing the slicer.
 */
export function loadEngineWorker(root: string): Engine {
  const slice = new EngineWorker(root, "slice");
  const model = new EngineWorker(root, "model");
  return {
    version: () => slice.call("version") as Promise<string>,
    occt: () => slice.call("occt").then((value) => value === true) as Promise<boolean>,
    meshPreview: (body, bytes) => slice.call("meshPreview", body, bytes) as Promise<string>,
    modelTree: (body) => model.call("modelTree", body) as Promise<string>,
    sliceStart: (body, bytes) => slice.call("sliceStart", body, bytes) as Promise<string>,
    slicePoll: (id) => slice.call("slicePoll", id) as Promise<string>,
    sliceCancel: (id) => slice.call("sliceCancel", id) as Promise<string>,
    resetModeler: () => model.restart(),
  };
}

/** A closed box as a lime-solid-2 reply. Face 2 is +X. */
function boxSolid(min: number[], max: number[], volume: number, id = 0): { wire: Record<string, unknown>; positions: Float32Array } {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [4, 5, 6, 7],
    [0, 3, 2, 1],
    [1, 2, 6, 5],
    [0, 4, 7, 3],
    [3, 7, 6, 2],
    [0, 1, 5, 4],
  ];
  const normals = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  const positions = new Float32Array(quads.length * 18);
  const triangles = new Uint32Array(quads.length * 2);
  quads.forEach((quad, face) => {
    const corner = (index: number) => c[quad[index]!]!;
    const write = (tri: number, a: number[], b: number[], d: number[]) => {
      const at = (face * 2 + tri) * 9;
      positions.set([...a, ...b, ...d], at);
      triangles[face * 2 + tri] = face;
    };
    write(0, corner(0), corner(1), corner(2));
    write(1, corner(0), corner(2), corner(3));
  });
  const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edgePoints = new Float32Array(edges.length * 6);
  edges.forEach((edge, index) => {
    edgePoints.set([...c[edge[0]!]!, ...c[edge[1]!]!], index * 6);
  });
  const edgeOffsets = new Uint32Array(edges.length + 1);
  for (let i = 0; i < edgeOffsets.length; i += 1) edgeOffsets[i] = i * 2;
  const wire = {
    format: "lime-solid-2",
    id,
    volumeMm3: volume,
    solid: true,
    fingerprint: { volumeMm3: volume, faces: 6, edges: 12 },
    positions: Buffer.from(positions.buffer).toString("base64"),
    triangles: Buffer.from(triangles.buffer).toString("base64"),
    faces: normals.map((normal) => ({ areaMm2: 1, normal })),
    edgeLengths: edges.map(() => 1),
    edgePoints: Buffer.from(edgePoints.buffer).toString("base64"),
    edgeOffsets: Buffer.from(edgeOffsets.buffer).toString("base64"),
  };
  return { wire, positions };
}

const SOLID_MARK = "lime-mcp-solid ";

/** The plate mesh a committed solid's STEP names, or a 20 mm cube. */
function positionsFromPreview(body: string): Float32Array {
  try {
    const asked = JSON.parse(body) as { dataB64?: string; filename?: string };
    if (asked.filename && /overhang_ledge/i.test(asked.filename)) {
      return boxSolid([10, -4, 0], [40, 16, 8], 8000).positions;
    }
    if (asked.dataB64) {
      const text = Buffer.from(asked.dataB64, "base64").toString("utf8");
      const at = text.indexOf(SOLID_MARK);
      if (at >= 0) {
        const encoded = text.slice(at + SOLID_MARK.length).split(/\s/)[0] ?? "";
        const bytes = Buffer.from(encoded, "base64");
        return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      }
    }
  } catch {
    // A mesh that is not one of our STEP notes previews as the cube.
  }
  return boxSolid([0, 0, 0], [20, 20, 20], 8000).positions;
}

/** One `;LAYER:` line per returned layer, so a summary can be checked against the file. */
export const FAKE_LAYER_SECONDS = [6, 6];

export function fakeSliceGcode(extra = ""): string {
  const moves = FAKE_LAYER_SECONDS.map((_, index) => `;LAYER:${index}\nG1 X${index} Y0 E0.1`).join("\n");
  return `; generated by Lime Slice — FDM strategy blender\n${moves}\n; TIME:12.0s FILAMENT_MM:100.00 FILAMENT_G:0.300\n${extra}\n`;
}

interface KeptSolid {
  volume: number;
  positions: Float32Array;
  min: number[];
  max: number[];
}

/** A stand-in for scripted tests. It does not slice. A committed STEP round-trips its mesh. */
export function fakeEngine(): Engine & { lastSlice: string; calls: string[]; lastProbe: unknown; lastProbeBody: unknown; resets: number } {
  const jobs = new Map<number, { status: string; body: string; polls: number }>();
  const kept = new Map<string, KeptSolid>();
  let next = 0;
  const remember = (key: string, solid: KeptSolid, id = 0) => {
    kept.set(key, solid);
    const count = solid.positions.length / 9;
    const triangles = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) triangles[i] = i < 12 ? Math.floor(i / 2) : 0;
    const edges = 12;
    const [x0, y0, z0] = solid.min;
    const [x1, y1, z1] = solid.max;
    const corners = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const edgePoints = new Float32Array(edges * 6);
    pairs.forEach((pair, index) => {
      edgePoints.set([...(corners[pair[0]!] ?? [0, 0, 0]), ...(corners[pair[1]!] ?? [0, 0, 0])], index * 6);
    });
    const edgeOffsets = new Uint32Array(edges + 1);
    for (let i = 0; i < edgeOffsets.length; i += 1) edgeOffsets[i] = i * 2;
    const positions = Buffer.from(solid.positions.buffer, solid.positions.byteOffset, solid.positions.byteLength);
    return {
      format: "lime-solid-2",
      id,
      volumeMm3: solid.volume,
      solid: true,
      fingerprint: { volumeMm3: solid.volume, faces: 6, edges },
      positions: positions.toString("base64"),
      triangles: Buffer.from(triangles.buffer).toString("base64"),
      faces: [
        { areaMm2: 1, normal: [0, 0, 1] },
        { areaMm2: 1, normal: [0, 0, -1] },
        { areaMm2: 1, normal: [1, 0, 0] },
        { areaMm2: 1, normal: [-1, 0, 0] },
        { areaMm2: 1, normal: [0, 1, 0] },
        { areaMm2: 1, normal: [0, -1, 0] },
      ],
      edgeLengths: pairs.map((pair) => {
        const a = corners[pair[0]!] ?? [0, 0, 0];
        const b = corners[pair[1]!] ?? [0, 0, 0];
        return Math.hypot((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0), (b[2] ?? 0) - (a[2] ?? 0)) || 1;
      }),
      edgePoints: Buffer.from(edgePoints.buffer).toString("base64"),
      edgeOffsets: Buffer.from(edgeOffsets.buffer).toString("base64"),
    };
  };
  const engine = {
    lastSlice: "",
    calls: [] as string[],
    lastProbe: null as unknown,
    lastProbeBody: null as unknown,
    resets: 0,
    hung: false,
    version: () => "1.8.0",
    occt: () => true,
    meshPreview: async (body: string, bytes?: Uint8Array) => {
      const block = Number(process.env.LIME_MCP_FAKE_BLOCK_MS ?? 0);
      if (block > 0) await new Promise((resolve) => setTimeout(resolve, block));
      const text = withMesh(body, bytes);
      const asked = JSON.parse(text) as { filename?: string };
      const positions = positionsFromPreview(text);
      return JSON.stringify({
        triangles: positions.length / 9,
        min: [0, 0, 0],
        max: [20, 20, 20],
        seatMm: 0,
        positionsB64: Buffer.from(positions.buffer).toString("base64"),
        filename: asked.filename ?? "mesh.stl",
      });
    },
    modelTree: (body: string) => {
      const req = JSON.parse(body) as {
        call?: string;
        key?: string;
        op?: { kind?: string; radius?: number; factor?: number; edges?: number[] };
        node?: number;
        otherKey?: string;
        aIndex?: number;
        bIndex?: number;
        preview?: boolean;
        replay?: { id?: number; op?: unknown }[];
        primitive?: { origin?: number[]; size?: number[] };
        filename?: string;
        dataB64?: string;
      };
      engine.calls.push(req.call ?? "open");
      const key = req.key ?? "solid";
      if (req.call === "probe") {
        engine.lastProbe = req.op ?? null;
        engine.lastProbeBody = req;
      }
      if (process.env.LIME_MCP_HANG_MODEL === "1" && req.op?.kind === "fillet" && (req.call === "probe" || req.call === "apply") && !engine.hung) {
        engine.hung = true;
        return new Promise<string>(() => undefined);
      }
      if (req.call === "probe") {
        const radius = req.op?.radius ?? 0;
        if (req.op?.kind === "hole" && radius > 8) return JSON.stringify({ ok: false, error: "The hole misses the solid." });
        return JSON.stringify({ ok: true });
      }
      if (req.call === "distance") {
        const solid = kept.get(key);
        const a = req.aIndex ?? -1;
        const b = req.bIndex ?? -1;
        const opposite: Record<number, number> = { 0: 1, 1: 0, 2: 3, 3: 2, 4: 5, 5: 4 };
        const axisOf: Record<number, number> = { 0: 2, 1: 2, 2: 0, 3: 0, 4: 1, 5: 1 };
        const axis = axisOf[a] ?? 0;
        const distance = solid && opposite[a] === b ? Math.abs((solid.max[axis] ?? 0) - (solid.min[axis] ?? 0)) : 0;
        return JSON.stringify({ id: req.node ?? 0, distanceMm: distance });
      }
      if (req.call === "apply") {
        const prior = kept.get(key) ?? { volume: 8000, positions: boxSolid([0, 0, 0], [20, 20, 20], 8000).positions, min: [0, 0, 0], max: [20, 20, 20] };
        const nextSolid: KeptSolid = { volume: prior.volume, positions: new Float32Array(prior.positions), min: [...prior.min], max: [...prior.max] };
        if (req.op?.kind === "scale" && typeof req.op.factor === "number") {
          const factor = req.op.factor;
          for (let i = 0; i < nextSolid.positions.length; i += 1) nextSolid.positions[i] = (nextSolid.positions[i] ?? 0) * factor;
          nextSolid.min = nextSolid.min.map((value) => value * factor);
          nextSolid.max = nextSolid.max.map((value) => value * factor);
          nextSolid.volume *= factor ** 3;
        } else if (req.op?.kind === "hole") {
          nextSolid.volume = Math.max(1, nextSolid.volume - 100);
          const extra = new Float32Array(nextSolid.positions.length + 9);
          extra.set(nextSolid.positions);
          const z = (nextSolid.max[2] ?? 0) + 0.2;
          const x0 = (nextSolid.min[0] ?? 0) + 4;
          const y0 = (nextSolid.min[1] ?? 0) + 4;
          extra.set([x0, y0, z, x0, y0 + 6, z, x0 + 6, y0, z], nextSolid.positions.length);
          nextSolid.positions = extra;
        }
        if (req.op?.kind === "split") nextSolid.volume = Math.max(1, prior.volume / 2);
        const wire = remember(key, nextSolid);
        wire.id = req.node ?? 1;
        if (req.op?.kind === "split" && req.otherKey) {
          const piece = remember(req.otherKey, { ...nextSolid, positions: new Float32Array(nextSolid.positions) });
          return JSON.stringify({ ...wire, other: { ...piece, key: req.otherKey } });
        }
        return JSON.stringify(wire);
      }
      if (req.call === "edit") {
        const replay = Array.isArray(req.replay) ? req.replay : [];
        const steps = [{ id: req.node ?? 1, op: req.op }, ...replay.map((step) => ({ id: step.id, op: step.op }))];
        const prior = kept.get(key);
        const volume = prior ? Math.max(1, prior.volume / 2) : 500;
        const base = prior ?? { volume, positions: boxSolid([0, 0, 0], [20, 20, 20], volume).positions, min: [0, 0, 0], max: [20, 20, 20] };
        const wire = remember(key, { ...base, volume });
        wire.id = steps[steps.length - 1]?.id ?? 1;
        wire.volumeMm3 = volume;
        wire.fingerprint = { volumeMm3: volume, faces: 6, edges: 12 };
        return JSON.stringify({
          ...wire,
          built: steps.map((step) => ({ id: step.id, op: step.op, fingerprint: wire.fingerprint })),
        });
      }
      if (req.call === "export") {
        const solid = kept.get(key);
        const encoded = solid ? Buffer.from(solid.positions.buffer, solid.positions.byteOffset, solid.positions.byteLength).toString("base64") : "";
        const step = `ISO-10303-21;\n/* ${SOLID_MARK}${encoded} */\nENDSEC;\n`;
        const bytes = Buffer.from(step, "utf8");
        return JSON.stringify({ bytesBase64: bytes.toString("base64"), byteLength: bytes.length });
      }
      if (req.call === "close") return JSON.stringify({ ok: true });
      const spec = req.primitive;
      const origin = spec?.origin ?? [0, 0, 0];
      const size = spec?.size && spec.size.some((value) => value > 0) ? spec.size : [20, 20, 20];
      const min = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
      const max = [min[0]! + (size[0] ?? 20), min[1]! + (size[1] ?? 20), min[2]! + (size[2] ?? 20)];
      const volume = Math.abs((max[0]! - min[0]!) * (max[1]! - min[1]!) * (max[2]! - min[2]!)) || 8000;
      return JSON.stringify(remember(key, { volume, positions: boxSolid(min, max, volume).positions, min, max }));
    },
    sliceStart: (body: string, bytes?: Uint8Array) => {
      engine.lastSlice = withMesh(body, bytes);
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
      const gcode = fakeSliceGcode(extra);
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
          layers: FAKE_LAYER_SECONDS.map((seconds, index) => ({ z: 0.2 * (index + 1), index, seconds, paths: [[0, 0, 1, 0]] })),
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
    resetModeler: () => {
      engine.resets += 1;
      engine.hung = false;
    },
  };
  return engine;
}
