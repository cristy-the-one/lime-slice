/**
 * The slicer behind the tools. The session calls this interface.
 * The first implementation loads `lime-mcp-engine` in-process.
 * A later transport can replace the loader without changing the tool schemas.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import { encodePaths } from "../src/preview-wire.ts";
import { SOLVER_STAND_IN } from "./sim.ts";
import { appVersion } from "./version.ts";

/**
 * This file's folder. In a checkout that is `mcp/`; in an installed app it is the
 * `mcp` folder the installer wrote, with the engine library beside the bundled server
 * and Open CASCADE in `../occt/lib`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
/** The bundle is plain JavaScript. The checkout runs the TypeScript with type stripping. */
const BUNDLED = import.meta.url.endsWith(".mjs");

export function occtLibraryName(): string {
  return process.platform === "win32" ? "lime_model_occt.dll" : process.platform === "darwin" ? "liblime_model_occt.dylib" : "liblime_model_occt.so";
}

/** The Open CASCADE bridge an installed app carries, or null in a checkout. */
export function installedOcctBridge(): string | null {
  const path = join(HERE, "..", "occt", "lib", occtLibraryName());
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
  /** One sliced stress study: the same JSON `lime_sim_bridge::study_json` reads. */
  simStudy(body: string): string | Promise<string>;
  /** Which library answers, and whether it is the installed app's, for session_info. */
  where?(): { path: string; installed: boolean } | Promise<{ path: string; installed: boolean }>;
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
  simStudy?: (body: string) => string;
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

/**
 * Where an installed Lime Slice keeps its MCP folder: the engine and server.mjs, with Open CASCADE in `../occt/lib`.
 * Null when this platform has no known install place.
 */
export function installedMcpDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (platform === "win32") return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Lime Slice", "mcp") : null;
  if (platform === "darwin") return "/Applications/Lime Slice.app/Contents/Resources/mcp";
  return "/usr/lib/Lime Slice/mcp";
}

/**
 * The installed app's engine, for a checkout that has not built its own. Only a checkout falls back to it, and only
 * when LIME_MCP_ENGINE is unset; the worker then loads it only if its version is the server's own.
 */
export function installedEngineFallback(): string | null {
  if (BUNDLED || process.env.LIME_MCP_ENGINE) return null;
  const dir = installedMcpDir();
  if (!dir) return null;
  const path = join(dir, engineLibraryName());
  return existsSync(path) ? path : null;
}

/** What to do when no engine was found: the installed server, a build, or LIME_MCP_ENGINE. */
export function engineNotFound(searched: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const installed = platform === "win32"
    ? "%LOCALAPPDATA%\\Lime Slice\\mcp\\server.mjs"
    : platform === "darwin"
      ? "/Applications/Lime Slice.app/Contents/Resources/mcp/server.mjs"
      : "the server.mjs in the installed app's mcp folder";
  return [
    `The Lime Slice engine (${engineLibraryName()}) was not found. Looked in: ${searched.join(", ")}.`,
    `If Lime Slice is installed, point the MCP client's node at the installed server, ${installed}, which finds its engine and Open CASCADE itself.`,
    "From a checkout, build the engine with cargo build -p lime-mcp-engine --release, or set LIME_MCP_ENGINE to the library's full path.",
    "The next call looks again; the client does not need to reconnect.",
  ].join(" ");
}

/** The release a bundled server.mjs in `dir` was built for, read from its text; null when it cannot be read. */
export function bundledVersion(dir: string): string | null {
  try {
    const text = readFileSync(join(dir, "server.mjs"), "utf8");
    return /function appVersion\(\)\s*\{\s*if \(true\) return "([^"]+)"/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The installed engine is used only when it is the same release as this server, so its replies match these tools. */
export function installedVersionRefusal(path: string, engine: string, server: string): string | null {
  if (engine === server) return null;
  return `The installed engine at ${path} is ${engine}, but this server is ${server}. Build the engine from this checkout with cargo build -p lime-mcp-engine --release, or point the MCP client at the installed server.mjs.`;
}

export function loadNativeEngine(root: string, expectVersion?: string): Engine & { path: string; installed: boolean } {
  const searched = engineCandidates(root);
  let path = searched.find((candidate) => existsSync(candidate));
  let installed = false;
  if (!path) {
    const fallback = installedEngineFallback();
    const dir = BUNDLED || process.env.LIME_MCP_ENGINE ? null : installedMcpDir();
    if (!fallback) throw new ProtocolError(engineNotFound([...searched, ...(dir ? [join(dir, engineLibraryName())] : [])]));
    // The installed server beside the engine names its release: another release is refused before its library is
    // loaded, so it is neither run nor held open.
    const theirs = bundledVersion(dirname(fallback));
    if (expectVersion && theirs) {
      const refusal = installedVersionRefusal(fallback, theirs, expectVersion);
      if (refusal) throw new ProtocolError(refusal);
    }
    path = fallback;
    installed = true;
  }
  const mod = { exports: {} as NativeExports };
  process.dlopen(mod, path);
  const native = mod.exports;
  if (typeof native.sliceStart !== "function") {
    throw new ProtocolError("The in-process engine loaded, but it did not export the slicer.");
  }
  if (installed && expectVersion) {
    const refusal = installedVersionRefusal(path, native.version(), expectVersion);
    if (refusal) throw new ProtocolError(refusal);
    // The installed engine brings the installed Open CASCADE, unless the client chose another.
    const bridge = join(dirname(path), "..", "occt", "lib", occtLibraryName());
    if (!process.env.LIME_OCCT_BRIDGE && existsSync(bridge)) process.env.LIME_OCCT_BRIDGE = bridge;
  }
  return {
    path,
    installed,
    version: () => native.version(),
    occt: () => native.occt() === "true",
    meshPreview: (body, bytes) => native.meshPreview(withMesh(body, bytes)),
    modelTree: (body) => native.modelTree(body),
    sliceStart: (body, bytes) => native.sliceStart(withMesh(body, bytes)),
    slicePoll: (id) => native.slicePoll(id),
    sliceCancel: (id) => native.sliceCancel(id),
    calibrate: (body) => native.calibrate?.(body) ?? JSON.stringify({ error: "Rebuild the in-process engine. This one has no calibration." }),
    pareto: (body) => native.pareto?.(body) ?? JSON.stringify({ error: "Rebuild the in-process engine. This one has no blend comparison." }),
    simStudy: (body) => native.simStudy?.(body) ?? JSON.stringify({ ok: false, reason: "Rebuild the in-process engine. This one has no stress study." }),
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
 * process; its memory goes with it. A load failure fails the calls waiting on
 * it, and the next call starts a fresh process, so an engine built or installed
 * later is found without reconnecting the client.
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
      fail(new ProtocolError(`The engine stopped (code ${code}). The next call starts it again.`));
    });
    // An idle engine does not keep the server alive; the stdio loop does.
    child.unref();
    child.channel?.unref();
    return child;
  }

  call(method: string, arg = "", bytes?: Uint8Array): Promise<unknown> {
    // A load failure is not kept: the engine may have been built or installed since, so each call starts a fresh process.
    if (this.failed) this.respawn();
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

  private respawn(): void {
    this.generation += 1;
    this.failed = null;
    children.delete(this.child);
    this.child.kill("SIGKILL");
    this.child = this.spawn();
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
    where: () => slice.call("enginePath").then((value) => JSON.parse(String(value)) as { path: string; installed: boolean }),
    meshPreview: (body, bytes) => preview.call("meshPreview", body, bytes) as Promise<string>,
    modelTree: (body) => model.call("modelTree", body) as Promise<string>,
    sliceStart: (body, bytes) => slice.call("sliceStart", body, bytes) as Promise<string>,
    slicePoll: (id) => slice.call("slicePoll", id) as Promise<string>,
    sliceCancel: (id) => slice.call("sliceCancel", id) as Promise<string>,
    calibrate: (body) => slice.call("calibrate", body) as Promise<string>,
    pareto: (body) => slice.call("pareto", body) as Promise<string>,
    simStudy: (body) => slice.call("simStudy", body) as Promise<string>,
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

/**
 * A split to print on the stand-in's box: every cut is square to an axis, and the box falls into the boxes between the
 * cuts, in the kernel's order (the first cut's axis outermost, negative side first). Null when a cut misses the box.
 */
function partitioned(prior: KeptSolid, op: { cuts?: { origin?: number[]; normal?: number[] }[] }): KeptSolid[] | null {
  const stops = new Map<number, number[]>();
  for (const cut of op.cuts ?? []) {
    const normal = cut.normal ?? [0, 0, 1];
    const axis = [0, 1, 2].reduce((best, i) => (Math.abs(normal[i] ?? 0) > Math.abs(normal[best] ?? 0) ? i : best), 0);
    const at = cut.origin?.[axis] ?? 0;
    if (!(at > (prior.min[axis] ?? 0) && at < (prior.max[axis] ?? 0))) return null;
    stops.set(axis, [...(stops.get(axis) ?? []), at].sort((a, b) => a - b));
  }
  let boxes: { min: number[]; max: number[] }[] = [{ min: [...prior.min], max: [...prior.max] }];
  for (const [axis, at] of [...stops].reverse()) {
    const bounds = [prior.min[axis] ?? 0, ...at, prior.max[axis] ?? 0];
    boxes = bounds.slice(1).flatMap((hi, k) => boxes.map((box) => {
      const min = [...box.min];
      const max = [...box.max];
      min[axis] = bounds[k]!;
      max[axis] = hi;
      return { min, max };
    }));
  }
  const whole = [0, 1, 2].reduce((v, i) => v * ((prior.max[i] ?? 0) - (prior.min[i] ?? 0)), 1) || 1;
  return boxes.map(({ min, max }) => {
    const volume = (prior.volume * [0, 1, 2].reduce((v, i) => v * ((max[i] ?? 0) - (min[i] ?? 0)), 1)) / whole;
    return { volume, positions: boxSolid(min, max, volume).positions, min, max };
  });
}

/** What the stand-in makes of an op: a scale, a hole's mark, a box cut that cleaves the part in two, or a group's steps in order. */
function applied(prior: KeptSolid, op: { kind?: string; factor?: number; op?: string; primitive?: string; origin?: number[]; size?: number[]; steps?: unknown[] } | undefined): KeptSolid {
  // --- A9. A group is the steps that landed, walked from the shape before them. Touch and lost-fuse checks stay on the outer op. ---
  if (op?.kind === "group" && Array.isArray(op.steps)) {
    let solid = prior;
    for (const step of op.steps) {
      if (step && typeof step === "object") solid = applied(solid, step as { kind?: string });
    }
    return solid;
  }
  const next: KeptSolid = { volume: prior.volume, positions: new Float32Array(prior.positions), min: [...prior.min], max: [...prior.max] };
  if (op?.kind === "scale" && typeof op.factor === "number") {
    const factor = op.factor;
    for (let i = 0; i < next.positions.length; i += 1) next.positions[i] = (next.positions[i] ?? 0) * factor;
    next.min = next.min.map((value) => value * factor);
    next.max = next.max.map((value) => value * factor);
    next.volume *= factor ** 3;
  } else if (op?.kind === "hole") {
    next.volume = Math.max(1, next.volume - 100);
    const extra = new Float32Array(next.positions.length + 36);
    extra.set(next.positions);
    const z = (next.max[2] ?? 0) + 0.2;
    const x0 = next.min[0] ?? 0;
    const y0 = next.min[1] ?? 0;
    // A closed tetrahedron whose one corner is the part's own, so the mark stays one piece with it and the mesh closes.
    const a = [x0, y0, z - 0.2];
    const b = [x0, y0 + 6, z];
    const c = [x0 + 6, y0, z];
    const d = [x0 + 2, y0 + 2, z + 0.4];
    extra.set([...a, ...b, ...c, ...a, ...d, ...b, ...b, ...d, ...c, ...c, ...d, ...a], next.positions.length);
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
/** What the fake engine answers for `partHold`: two patches of unheld part beads. */
export const FAKE_PART_HOLD = {
  partMm: 1234.56,
  noBeadUnderMm: 80.04,
  unheldMm: 61.25,
  danglingMm: 40.5,
  patches: 2,
  largest: [
    { mm: 50.04, danglingMm: 38.2, layers: [12, 13], at: [10.123, 20.456, 2.6] },
    { mm: 11.21, danglingMm: 2.3, layers: [30, 30], at: [1, 2, 6.2] },
  ],
};

export function fakeEngine(): Engine & { lastSlice: string; calls: string[]; opens: Record<string, unknown>[]; lastProbe: unknown; lastProbeBody: unknown; resets: number; previewResets: number; folds: number } {
  const jobs = new Map<number, { status: string; body: string; polls: number }>();
  const kept = new Map<string, KeptSolid>();
  // --- A9. One solid per history node, so goto restores that step instead of a fresh cube. ---
  const atNode = new Map<string, Map<number, KeptSolid>>();
  const cloneSolid = (solid: KeptSolid): KeptSolid => ({ volume: solid.volume, positions: new Float32Array(solid.positions), min: [...solid.min], max: [...solid.max] });
  const keepNode = (key: string, id: number, solid: KeptSolid) => {
    let map = atNode.get(key);
    if (!map) {
      map = new Map();
      atNode.set(key, map);
    }
    map.set(id, cloneSolid(solid));
  };
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
    /** Every open's request, so a test can tell a whole-history rebuild (it carries `nodes`) from a first open. */
    opens: [] as Record<string, unknown>[],
    /** Trees a reset dropped: a call on one fails until it is opened again, as the real modeler's do. */
    lost: new Set<string>(),
    lastProbe: null as unknown,
    lastProbeBody: null as unknown,
    resets: 0,
    previewResets: 0,
    /** Composite runs the engine folded into a group without building it again. */
    folds: 0,
    hung: false,
    version: () => appVersion(),
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
    slowing: false,
    modelTree: (body: string): string | Promise<string> => {
      // A slow whole-history open, as a project with no saved solids replays every step.
      const slowOpen = Number(process.env.LIME_MCP_FAKE_OPEN_MS ?? 0);
      if (slowOpen > 0 && !engine.slowing && /"call":"open"/.test(body) && /"nodes":\[\{/.test(body)) {
        return new Promise((resolve) => setTimeout(resolve, slowOpen)).then(() => {
          engine.slowing = true;
          try {
            return engine.modelTree(body);
          } finally {
            engine.slowing = false;
          }
        });
      }
      // A slow kernel for long-call tests: each probe and apply waits this long first.
      const slow = Number(process.env.LIME_MCP_FAKE_MODEL_MS ?? 0);
      if (slow > 0 && !engine.slowing && /"call":"(apply|probe)"/.test(body)) {
        return new Promise((resolve) => setTimeout(resolve, slow)).then(() => {
          engine.slowing = true;
          try {
            return engine.modelTree(body);
          } finally {
            engine.slowing = false;
          }
        });
      }
      const req = JSON.parse(body) as {
        call?: string;
        key?: string;
        op?: { kind?: string; radius?: number; factor?: number; edges?: number[] };
        node?: number;
        parent?: number;
        otherKey?: string;
        pieceKeys?: (string | null)[];
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
      if (!req.call || req.call === "open") {
        engine.opens.push(JSON.parse(body) as Record<string, unknown>);
        engine.lost.delete(key);
      } else if (engine.lost.has(key)) {
        return JSON.stringify({ error: "unknown", missing: [0] });
      }
      if (req.call === "probe") {
        engine.lastProbe = req.op ?? null;
        engine.lastProbeBody = req;
      }
      if (process.env.LIME_MCP_HANG_MODEL === "1" && req.op?.kind === "fillet" && (req.call === "probe" || req.call === "apply") && !engine.hung) {
        engine.hung = true;
        return new Promise<string>(() => undefined);
      }
      const fallback = (): KeptSolid => ({ volume: 8000, positions: boxSolid([0, 0, 0], [20, 20, 20], 8000).positions, min: [0, 0, 0], max: [20, 20, 20] });
      // --- Split to print: the box between the cuts, each piece after the first a tree of its own under its key.
      const cut = (from: KeptSolid) => partitioned(from, req.op as { cuts?: { origin?: number[]; normal?: number[] }[] });
      const startPieces = (rest: KeptSolid[]) => {
        const keys = req.pieceKeys ?? [];
        return rest.map((piece, at) => {
          const pieceKey = keys[at];
          if (!pieceKey) return null;
          atNode.delete(pieceKey);
          keepNode(pieceKey, 0, piece);
          return { ...remember(pieceKey, piece), key: pieceKey, part: at + 2 };
        });
      };
      if (req.op?.kind === "partition" && (req.call === "probe" || req.call === "apply" || req.call === "edit")) {
        const from = atNode.get(key)?.get(req.call === "probe" ? (req.node ?? 0) : (req.parent ?? 0)) ?? kept.get(key) ?? fallback();
        const pieces = cut(from);
        const max = Math.min(24, Math.max(2, Math.round(Number((req.op as { maxPieces?: unknown }).maxPieces ?? 12))));
        const refused = !pieces ? "The plane is outside the part" : pieces.length > max ? `This cut makes ${pieces.length} pieces. Max pieces is ${max}.` : null;
        if (refused || !pieces) return JSON.stringify(req.call === "probe" ? { ok: false, error: refused } : { error: refused });
        const [first, ...rest] = pieces;
        // --- Milestone 5: every placed connector is built; the dowels' pins are a 10 mm cube of their own.
        const placedIds = ((req.op as { cuts?: { connectors?: { on?: boolean; placed?: { id?: string; type?: string }[] } }[] }).cuts ?? []).flatMap((one) => (one.connectors?.on ? (one.connectors.placed ?? []) : []));
        const dowels = placedIds.filter((row) => row.type === "dowel").length;
        const joints = placedIds.length > 0 ? { connectors: { placed: placedIds.map((row) => ({ id: row.id, at: [0, 0, 0], teardrop: false })), dropped: [] }, notes: [] } : {};
        const pinsSolid: KeptSolid | null = dowels > 0 ? { volume: 1000, positions: boxSolid([0, 30, 0], [10, 40, 10], 1000).positions, min: [0, 30, 0], max: [10, 40, 10] } : null;
        if (req.call === "probe") {
          const measure = (solid: KeptSolid) => ({ volumeMm3: solid.volume, solids: 1, shells: 1 });
          return JSON.stringify({ ok: true, ...measure(first!), before: measure(from), parts: pieces.map((piece) => ({ volumeMm3: piece.volume, min: piece.min, max: piece.max })), ...(pinsSolid ? { pins: { volumeMm3: 1000, count: dowels } } : {}), ...joints });
        }
        if ((req.pieceKeys?.length ?? 0) > 0 && rest.length > req.pieceKeys!.length) {
          return JSON.stringify({ error: `This cut makes ${pieces.length} pieces, and keys came for ${req.pieceKeys!.length + 1}.` });
        }
        const replay = req.call === "edit" && Array.isArray(req.replay) ? req.replay : [];
        const tip = replay.length > 0 ? (replay[replay.length - 1]!.id ?? 1) : (req.node ?? 1);
        keepNode(key, req.node ?? 1, first!);
        if (tip !== req.node) keepNode(key, tip, first!);
        const wire = remember(key, first!);
        wire.id = tip;
        const listed = startPieces(rest);
        const pinsKey = (req as { pinsKey?: string }).pinsKey;
        let pinsReply: Record<string, unknown> | null = null;
        if (pinsSolid && pinsKey) {
          atNode.delete(pinsKey);
          keepNode(pinsKey, 0, pinsSolid);
          pinsReply = { ...remember(pinsKey, pinsSolid), key: pinsKey };
        }
        const fields = { parts: pieces.length, ...((req.pieceKeys?.length ?? 0) > 0 ? { pieces: listed } : {}), ...(pinsReply ? { pins: pinsReply } : {}), ...joints };
        if (req.call === "apply") return JSON.stringify({ ...wire, op: req.op, ...fields });
        const steps = [{ id: req.node ?? 1, op: req.op }, ...replay.map((step) => ({ id: step.id, op: step.op }))];
        return JSON.stringify({ ...wire, built: steps.map((step) => ({ id: step.id, op: step.op, fingerprint: wire.fingerprint })), ...fields });
      }
      if (req.call === "probe") {
        const radius = req.op?.radius ?? 0;
        if (req.op?.kind === "hole" && radius > 8) return JSON.stringify({ ok: false, error: "The hole misses the solid." });
        // A shell wall over 3 mm does not fit the stand-in's smallest feature.
        if (req.op?.kind === "shell" && ((req.op as { thickness?: number }).thickness ?? 0) > 3) return JSON.stringify({ ok: false, error: "This wall is too thick for the part's smallest feature." });
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
        const fuse = req.op?.kind === "boolean" && (req.op as { op?: string }).op === "fuse";
        // Kernel failures the session must catch: a fuse that hands back only its tool, or a box that meets the part
        // only along an edge.
        if (fuse && process.env.LIME_MCP_FAKE_LOSE_FUSE === "1") nextSolid.volume = 307;
        // A mesher crack too wide to mend: one loose triangle beside the part.
        if (process.env.LIME_MCP_FAKE_OPEN === "1") {
          const [x, y, z] = [prior.max[0] ?? 20, prior.max[1] ?? 20, prior.max[2] ?? 20];
          const open = new Float32Array(nextSolid.positions.length + 9);
          open.set(nextSolid.positions, 0);
          open.set([x + 5, y, z, x + 6, y, z, x + 5, y + 1, z], nextSolid.positions.length);
          nextSolid.positions = open;
        }
        if (fuse && process.env.LIME_MCP_FAKE_TOUCH === "1") {
          // Outside the part's vertical edge nearest the tool, sharing that edge.
          const at = (req.op as { origin?: number[] }).origin ?? [0, 0, 0];
          const pick = (i: number): [number, number] => (Math.abs((at[i] ?? 0) - (prior.min[i] ?? 0)) < Math.abs((at[i] ?? 0) - (prior.max[i] ?? 0)) ? [prior.min[i] ?? 0, -5] : [prior.max[i] ?? 0, 5]);
          const [x1, dx] = pick(0);
          const [y1, dy] = pick(1);
          const touching = boxSolid([Math.min(x1, x1 + dx), Math.min(y1, y1 + dy), prior.min[2] ?? 0], [Math.max(x1, x1 + dx), Math.max(y1, y1 + dy), prior.max[2] ?? 20], 1).positions;
          const both = new Float32Array(nextSolid.positions.length + touching.length);
          both.set(nextSolid.positions, 0);
          both.set(touching, nextSolid.positions.length);
          nextSolid.positions = both;
        }
        // --- A9. Snapshot after the volume changes, so a later goto of this node is this solid. ---
        keepNode(key, req.node ?? 1, nextSolid);
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
        // --- D9. A hole whose origin is off the stand-in's box misses it: the edit keeps nothing, or with keepBroken
        // the first step that misses is kept broken with the rest, and the tree shows the last step that built.
        const misses = (op: unknown) => {
          const hole = op as { kind?: string; origin?: number[] } | undefined;
          return !!prior && hole?.kind === "hole" && Array.isArray(hole.origin) && [0, 1].some((i) => (hole.origin![i] ?? 0) < (prior.min[i] ?? 0) - 1e-6 || (hole.origin![i] ?? 0) > (prior.max[i] ?? 0) + 1e-6);
        };
        const missed = steps.findIndex((step) => misses(step.op));
        if (missed === 0 && !(req as { keepBroken?: boolean }).keepBroken) return JSON.stringify({ error: "The hole missed this solid" });
        if (missed === 0 && prior) {
          const wire = remember(key, prior);
          wire.id = req.parent ?? 0;
          return JSON.stringify({ ...wire, built: [], broken: { id: steps[0]!.id, error: "The hole missed this solid" } });
        }
        const volume = prior ? Math.max(1, prior.volume / 2) : 500;
        const base = prior ?? { volume, positions: boxSolid([0, 0, 0], [20, 20, 20], volume).positions, min: [0, 0, 0], max: [20, 20, 20] };
        const edited = { ...base, volume, positions: new Float32Array(base.positions) };
        keepNode(key, steps[steps.length - 1]?.id ?? 1, edited);
        const wire = remember(key, edited);
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
        // A `brep` export starts as the real engine's binary solid does; the mark still carries the mesh.
        const head = (req as { format?: string }).format === "brep" ? "LIMEBREP 1 fake 0 *\n" : "ISO-10303-21;\n";
        // --- Split to print: a STEP of a partition's pieces holds one solid for this tree and one for each piece named,
        // each a product of the name sent for it.
        const pieces = (req as { pieces?: unknown[] }).pieces;
        const products = Array.isArray(pieces) ? ((req as { names?: string[] }).names ?? []).map((name, at) => `#${at + 1}=PRODUCT('${name}','${name}','',());\n`).join("") : "";
        const step = `${head}/* ${SOLID_MARK}${encoded} */\n${products}ENDSEC;\n`;
        const bytes = Buffer.from(step, "utf8");
        return JSON.stringify({ bytesBase64: bytes.toString("base64"), byteLength: bytes.length, ...(Array.isArray(pieces) ? { solids: 1 + pieces.length } : {}) });
      }
      if (req.call === "close") return JSON.stringify({ ok: true });
      // --- 3.1 F1. A run folds into one group with the solid its last step left. LIME_MCP_FAKE_NO_FOLD acts as an engine
      // that cannot, so the group is built instead.
      if (req.call === "fold") {
        const solid = kept.get(key);
        if (!solid || process.env.LIME_MCP_FAKE_NO_FOLD === "1") return JSON.stringify({ error: "The last step's solid is no longer held, so the group is built instead" });
        engine.folds += 1;
        keepNode(key, req.node ?? 1, solid);
        const wire = remember(key, cloneSolid(solid));
        wire.id = req.node ?? 1;
        return JSON.stringify(wire);
      }
      // --- A9. goto returns the solid that node held. A node with no snapshot keeps the current solid. ---
      if (req.call === "goto") {
        const id = typeof req.node === "number" ? req.node : 0;
        const saved = atNode.get(key)?.get(id) ?? kept.get(key);
        const solid = saved ?? { volume: 8000, positions: boxSolid([0, 0, 0], [20, 20, 20], 8000).positions, min: [0, 0, 0], max: [20, 20, 20] };
        return JSON.stringify(remember(key, cloneSolid(solid), id));
      }
      const spec = req.primitive;
      const origin = spec?.origin ?? [0, 0, 0];
      const size = spec?.size && spec.size.some((value) => value > 0) ? spec.size : [20, 20, 20];
      const min = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
      const max = [min[0]! + (size[0] ?? 20), min[1]! + (size[1] ?? 20), min[2]! + (size[2] ?? 20)];
      const volume = Math.abs((max[0]! - min[0]!) * (max[1]! - min[1]!) * (max[2]! - min[2]!)) || 8000;
      const solid = { volume, positions: boxSolid(min, max, volume).positions, min, max };
      // --- A9. A fresh open replaces that tree's snapshots. The root is node 0. ---
      if (!req.call || req.call === "open") {
        atNode.delete(key);
        keepNode(key, 0, solid);
      }
      return JSON.stringify(remember(key, solid));
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
      const request = JSON.parse(job.body) as { layerActions?: { kind?: string; gcode?: string }[]; partHold?: boolean };
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
          ...(request.partHold ? { partHold: FAKE_PART_HOLD } : {}),
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
      for (const key of kept.keys()) if (!key.includes("#")) engine.lost.add(key);
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
    simStudy: () => JSON.stringify({ ok: false, reason: SOLVER_STAND_IN }),
  };
  return engine;
}
