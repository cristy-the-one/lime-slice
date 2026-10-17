/**
 * The slicer behind the tools. The session calls this interface.
 * The first implementation loads `lime-mcp-engine` in-process.
 * A later transport can replace the loader without changing the tool schemas.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import { encodePaths } from "../src/preview-wire.ts";

/**
 * This file's folder. In a checkout that is `mcp/`; in an installed app it is the
 * `mcp` folder the installer wrote, with the engine library beside the bundled server
 * and Open CASCADE in `../occt/lib`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
/** The bundle is plain JavaScript. The checkout runs the TypeScript with type stripping. */
const BUNDLED = import.meta.url.endsWith(".mjs");

/** The Open CASCADE bridge an installed app carries, or null in a checkout. */
export function installedOcctBridge(): string | null {
  const name = process.platform === "win32" ? "lime_model_occt.dll" : process.platform === "darwin" ? "liblime_model_occt.dylib" : "liblime_model_occt.so";
  const path = join(HERE, "..", "occt", "lib", name);
  return existsSync(path) ? path : null;
}

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
  /** A calibration tower. The body is the app's calibrate request plus `kind`. */
  calibrate(body: string): string | Promise<string>;
  /** Blend estimates for one slice body. No G-code. */
  pareto(body: string): string | Promise<string>;
  /** Drop a stuck modeler and start another. Slicing keeps its own worker. */
  resetModeler(): void | Promise<void>;
  /** Drop a stuck mesh preview. Open model trees and the slicer are kept. */
  resetPreview?(): void | Promise<void>;
}

type NativeExports = {
  version: () => string;
  occt: () => string;
  meshPreview: (body: string) => string;
  modelTree: (body: string) => string;
  sliceStart: (body: string) => string;
  slicePoll: (id: string) => string;
  sliceCancel: (id: string) => string;
  calibrate?: (body: string) => string;
  pareto?: (body: string) => string;
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
  // An installed app ships the library beside the bundled server; a checkout builds it under target.
  return [join(HERE, name), join(root, "target", "release", name), join(root, "target", "debug", name)];
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
    calibrate: (body) => native.calibrate?.(body) ?? JSON.stringify({ error: "Rebuild the in-process engine. This one has no calibration." }),
    pareto: (body) => native.pareto?.(body) ?? JSON.stringify({ error: "Rebuild the in-process engine. This one has no blend comparison." }),
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

/** Every engine process this server started, so none outlives it. */
const children = new Set<ChildProcess>();
let reaping = false;

function reapOnExit(): void {
  if (reaping) return;
  reaping = true;
  process.on("exit", () => {
    for (const child of children) child.kill("SIGKILL");
  });
}

/**
 * One addon in a child process. A native call cannot be stopped inside a
 * thread, so a call that runs past its budget is stopped by killing the
 * process; its memory goes with it. A load failure is remembered, so later
 * calls fail at once instead of waiting on a process that has already exited.
 * `role` is "slice", "model" or "preview": a stuck one is replaced without dropping the others.
 * The child's stdout goes to this process's stderr, because stdout is the protocol.
 */
class EngineWorker {
  private child: ChildProcess;
  private seq = 0;
  private generation = 0;
  private pending = new Map<number, WorkerCall>();
  private failed: Error | null = null;
  private readonly root: string;
  private readonly role: "slice" | "model" | "preview";

  constructor(root: string, role: "slice" | "model" | "preview") {
    this.root = root;
    this.role = role;
    reapOnExit();
    this.child = this.spawn();
  }

  private spawn(): ChildProcess {
    const generation = this.generation;
    const occt = process.env.LIME_OCCT_BRIDGE ? null : installedOcctBridge();
    const child = fork(join(HERE, BUNDLED ? "engine-worker.mjs" : "engine-worker.ts"), [], {
      execArgv: BUNDLED ? [] : ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
      env: {
        ...process.env,
        LIME_MCP_ENGINE_ROOT: this.root,
        LIME_MCP_ENGINE_ROLE: this.role,
        // An installed app's own Open CASCADE, unless the client chose another.
        ...(occt ? { LIME_OCCT_BRIDGE: occt } : {}),
      },
      serialization: "advanced",
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
    children.add(child);
    child.stdout?.pipe(process.stderr);
    child.on("message", (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      if (generation !== this.generation) return;
      if (msg.id === -1) {
        fail(new ProtocolError(msg.error || "The in-process engine did not load."));
        return;
      }
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
    child.on("error", (err) => fail(err instanceof ProtocolError ? err : new ProtocolError(err.message)));
    child.on("exit", (code) => {
      children.delete(child);
      if (generation !== this.generation || this.failed) return;
      fail(new ProtocolError(`The engine stopped (code ${code}). Build it with cargo build -p lime-mcp-engine --release.`));
    });
    // An idle engine does not keep the server alive; the stdio loop does.
    child.unref();
    child.channel?.unref();
    return child;
  }

  call(method: string, arg = "", bytes?: Uint8Array): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const id = this.seq;
      this.seq += 1;
      if (this.pending.size === 0) this.child.channel?.ref();
      this.pending.set(id, {
        resolve: (value) => {
          this.settled();
          resolve(value);
        },
        reject: (err) => {
          this.settled();
          reject(err);
        },
      });
      this.child.send({ id, method, arg, bytes });
    });
  }

  private settled(): void {
    if (this.pending.size === 0) this.child.channel?.unref();
  }

  /** Kill a runaway engine process. The next call loads a fresh one. Pending calls are rejected. */
  restart(): void {
    const previous = this.child;
    this.generation += 1;
    this.failed = null;
    const stopped = [...this.pending.values()];
    this.pending.clear();
    previous.kill("SIGKILL");
    children.delete(previous);
    this.child = this.spawn();
    for (const slot of stopped) slot.reject(new ProtocolError("The modeler was restarted."));
  }
}

/**
 * The same addon, called from child processes so a long preview or slice
 * poll does not stop the stdio loop answering ping. Mesh preview and model
 * edits each have their own process, so a stuck tessellation can be killed
 * without losing the slicer or the open model trees.
 */
export function loadEngineWorker(root: string): Engine {
  const slice = new EngineWorker(root, "slice");
  const model = new EngineWorker(root, "model");
  const preview = new EngineWorker(root, "preview");
  return {
    version: () => slice.call("version") as Promise<string>,
    occt: () => slice.call("occt").then((value) => value === true) as Promise<boolean>,
    meshPreview: (body, bytes) => preview.call("meshPreview", body, bytes) as Promise<string>,
    modelTree: (body) => model.call("modelTree", body) as Promise<string>,
    sliceStart: (body, bytes) => slice.call("sliceStart", body, bytes) as Promise<string>,
    slicePoll: (id) => slice.call("slicePoll", id) as Promise<string>,
    sliceCancel: (id) => slice.call("sliceCancel", id) as Promise<string>,
    calibrate: (body) => slice.call("calibrate", body) as Promise<string>,
    pareto: (body) => slice.call("pareto", body) as Promise<string>,
    resetModeler: () => model.restart(),
    resetPreview: () => preview.restart(),
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
    const baseName = asked.filename?.split(/[\\/]/).pop() ?? "";
    if (baseName.toLowerCase() === "two-shells.stl") {
      const left = boxSolid([0, 0, 0], [10, 10, 10], 1000).positions;
      const right = boxSolid([40, 0, 0], [50, 10, 10], 1000).positions;
      const both = new Float32Array(left.length + right.length);
      both.set(left, 0);
      both.set(right, left.length);
      return both;
    }
    if (asked.dataB64) {
      const raw = Buffer.from(asked.dataB64, "base64");
      // A binary STL reads as it is: a committed solid's plate mesh is one.
      if (raw.length >= 84 && raw.length === 84 + raw.readUInt32LE(80) * 50) {
        const count = raw.readUInt32LE(80);
        const out = new Float32Array(count * 9);
        for (let t = 0; t < count; t += 1) for (let k = 0; k < 9; k += 1) out[t * 9 + k] = raw.readFloatLE(84 + t * 50 + 12 + k * 4);
        return out;
      }
      const text = raw.toString("utf8");
      const at = text.indexOf(SOLID_MARK);
      if (at >= 0) {
        const encoded = text.slice(at + SOLID_MARK.length).split(/\s/)[0] ?? "";
        const bytes = Buffer.from(encoded, "base64");
        return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      }
      if (asked.filename && /-shell-\d+\.stl$/i.test(asked.filename)) {
        const decoded = stlPositions(raw);
        if (decoded) return decoded;
      }
    }
  } catch {
    // A mesh that is not one of our STEP notes previews as the cube.
  }
  return boxSolid([0, 0, 0], [20, 20, 20], 8000).positions;
}

/** Triangles in a binary STL. Anything else is left to the stand-in cube. */
function stlPositions(bytes: Buffer): Float32Array | null {
  if (bytes.length < 84) return null;
  const count = bytes.readUInt32LE(80);
  if (count < 1 || bytes.length < 84 + count * 50) return null;
  const positions = new Float32Array(count * 9);
  for (let tri = 0; tri < count; tri += 1) {
    const base = 84 + tri * 50 + 12;
    for (let v = 0; v < 9; v += 1) positions[tri * 9 + v] = bytes.readFloatLE(base + v * 4);
  }
  return positions;
}

/** One `;LAYER:` line per returned layer, so a summary can be checked against the file. */
export const FAKE_LAYER_SECONDS = [6, 6];

export function fakeSliceGcode(extra = ""): string {
  const moves = FAKE_LAYER_SECONDS.map((_, index) => `;LAYER:${index}\nG1 X${index} Y0 E0.1`).join("\n");
  return `; generated by Lime Slice — FDM strategy blender\n${moves}\n; TIME:12.0s FILAMENT_MM:100.00 FILAMENT_G:0.300\n${extra}\n`;
}

/** Layer 0 of the stand-in: a skirt and a 20 mm square, in the same columns the app decodes. */
const FAKE_LAYER_PATHS = encodePaths([
  { kind: "skirt", pts: [[-3, -3], [23, -3], [23, 23], [-3, 23], [-3, -3]], width: 0.45, speed: 30, effectiveSpeed: 30 },
  { kind: "outer", pts: [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]], width: 0.45, speed: 40, effectiveSpeed: 40 },
]);

const FAKE_SKELETON = {
  id: [1, 2],
  tree: [1, 1],
  into: [0, 1],
  live: [1, 1],
  siteX: [20, 22],
  siteY: [0, 0],
  siteZ: [8, 4],
  start: [0, 2, 4],
  xs: [20, 20, 22, 22],
  ys: [0, 0, 0, 0],
  zs: [8, 0, 4, 0],
  rs: [0.4, 1, 0.3, 0.6],
};

interface KeptSolid {
  volume: number;
  positions: Float32Array;
  min: number[];
  max: number[];
}

/** What the stand-in makes of an op: a scale, a hole's mark, or a box cut that cleaves the part in two. */
function applied(prior: KeptSolid, op: { kind?: string; factor?: number; op?: string; primitive?: string; origin?: number[]; size?: number[] } | undefined): KeptSolid {
  const next: KeptSolid = { volume: prior.volume, positions: new Float32Array(prior.positions), min: [...prior.min], max: [...prior.max] };
  if (op?.kind === "scale" && typeof op.factor === "number") {
    const factor = op.factor;
    for (let i = 0; i < next.positions.length; i += 1) next.positions[i] = (next.positions[i] ?? 0) * factor;
    next.min = next.min.map((value) => value * factor);
    next.max = next.max.map((value) => value * factor);
    next.volume *= factor ** 3;
  } else if (op?.kind === "hole") {
    next.volume = Math.max(1, next.volume - 100);
    const extra = new Float32Array(next.positions.length + 9);
    extra.set(next.positions);
    const z = (next.max[2] ?? 0) + 0.2;
    const x0 = next.min[0] ?? 0;
    const y0 = next.min[1] ?? 0;
    // One corner is the part's own, so the mark stays one piece with it.
    extra.set([x0, y0, z - 0.2, x0, y0 + 6, z, x0 + 6, y0, z], next.positions.length);
    next.positions = extra;
  } else if (op?.kind === "boolean" && op.op === "cut" && op.primitive === "box" && op.origin && op.size) {
    const [ox, oy, oz] = op.origin as [number, number, number];
    const [sx, sy, sz] = op.size as [number, number, number];
    const spans = oy <= next.min[1]! && oy + sy >= next.max[1]! && oz <= next.min[2]! && oz + sz >= next.max[2]!;
    if (spans && ox > next.min[0]! && ox + sx < next.max[0]!) {
      const left = boxSolid(next.min as [number, number, number], [ox, next.max[1]!, next.max[2]!], 1).positions;
      const right = boxSolid([ox + sx, next.min[1]!, next.min[2]!], next.max as [number, number, number], 1).positions;
      next.positions = new Float32Array(left.length + right.length);
      next.positions.set(left, 0);
      next.positions.set(right, left.length);
      next.volume = Math.max(1, next.volume - sx * (next.max[1]! - next.min[1]!) * (next.max[2]! - next.min[2]!));
    }
  }
  return next;
}

/** A stand-in for scripted tests. It does not slice. A committed STEP round-trips its mesh. */
export function fakeEngine(): Engine & { lastSlice: string; calls: string[]; lastProbe: unknown; lastProbeBody: unknown; resets: number; previewResets: number } {
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
    previewResets: 0,
    hung: false,
    version: () => "2.5.1",
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
        if (!req.preview) return JSON.stringify({ ok: true });
        const prior = kept.get(key) ?? { volume: 8000, positions: boxSolid([0, 0, 0], [20, 20, 20], 8000).positions, min: [0, 0, 0], max: [20, 20, 20] };
        const shown = remember(`${key}#preview`, applied(prior, req.op), 0);
        return JSON.stringify({ ok: true, preview: shown });
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
        const nextSolid = applied(prior, req.op);
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
      const actions = request.layerActions ?? [];
      const extra = [
        ...actions.filter((action) => action.kind === "customGcode" && action.gcode).map((action) => action.gcode),
        actions.some((action) => action.kind === "filamentChange") ? "M600" : "",
      ].filter((line) => line).join("\n");
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
          layers: FAKE_LAYER_SECONDS.map((seconds, index) => ({
            z: 0.2 * (index + 1),
            index,
            seconds,
            height: 0.2,
            paths: index === 0 ? FAKE_LAYER_PATHS : encodePaths([]),
          })),
          skeleton: FAKE_SKELETON,
          coverage: [{ z: [4, 8], areaMm2: 40, min: [10, -4], max: [40, 16], outline: [[[10, -4], [40, -4], [40, 16], [10, 16]]] }],
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
    resetPreview: () => {
      engine.previewResets += 1;
    },
    calibrate: (body: string) => {
      const req = JSON.parse(body) as { kind?: string; start?: number; end?: number; step?: number; bandHeight?: number };
      const start = req.start ?? 0;
      const end = req.end ?? start;
      const step = req.step && req.step > 0 ? req.step : 1;
      const height = req.bandHeight ?? (req.kind === "pa" ? 2 : 5);
      const bands: { index: number; value: number; z0: number; z1: number }[] = [];
      for (let value = start, index = 0; index < 80 && value <= end + step * 0.25; value += step, index += 1) {
        bands.push({ index, value, z0: index * height, z1: (index + 1) * height });
      }
      return JSON.stringify({ bands, gcode: `; ${req.kind ?? "cal"} calibration\n` });
    },
    pareto: () => JSON.stringify([
      { label: "speed", toughness: 0, seconds: 10, filamentG: 0.2, score: 0.2 },
      { label: "mix", toughness: 0.5, seconds: 14, filamentG: 0.28, score: 0.5 },
      { label: "tough", toughness: 1, seconds: 20, filamentG: 0.4, score: 0.9 },
    ]),
  };
  return engine;
}
