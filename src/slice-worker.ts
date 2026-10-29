/// Base64-encode the mesh and parse the slice JSON off the main thread.

import { bytesToBase64 } from "./base64";

export interface WorkerRequest {
  id: number;
  /** Absent when the worker already holds the mesh named by `meshKey`. */
  bytes?: ArrayBuffer;
  meshKey?: string;
  filename?: string;
  payload?: Record<string, unknown>;
  api?: string;
  token?: string;
  parseOnly?: string;
  /** An early preview's JSON, drawn with the shown result's bounds and object count. */
  early?: string;
  min?: number[];
  max?: number[];
  objects?: number;
  cancel?: boolean;
  /** Drop the mesh kept for the next slice of the same file. */
  dropMesh?: boolean;
  /** Port to the geometry worker, sent once at startup. */
  geomPort?: MessagePort;
  /** One part of the `layers` a `parseOnly` reply named in `layerParts`, in order. */
  part?: ArrayBuffer;
}

/** A reply sent as `"replyParts": true` names its `layers` instead of holding them. */
export interface LayerParts {
  token: string;
  count: number;
}

type Reply = Parameters<typeof deliver>[1] & { error?: string; layerParts?: LayerParts };

const jobs = new Map<number, AbortController>();
/** Replies whose `layers` the main thread is still sending, part by part. */
const pending = new Map<number, { body: Reply; layers: unknown[]; count: number }>();
/** The last mesh in Base64, so a slice of the same mesh skips encoding it again. */
let mesh = { key: "", b64: "" };
let geomPort: MessagePort | null = null;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.geomPort) {
    geomPort = msg.geomPort;
    return;
  }
  if (msg.cancel) {
    jobs.get(msg.id)?.abort();
    jobs.delete(msg.id);
    if (pending.delete(msg.id)) self.postMessage({ id: msg.id, ok: false, cancelled: true, error: "cancelled" });
    return;
  }
  if (msg.part) {
    const waiting = pending.get(msg.id);
    if (!waiting) return;
    try {
      addPart(waiting.layers, msg.part);
    } catch (err) {
      pending.delete(msg.id);
      self.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (--waiting.count > 0) return;
    pending.delete(msg.id);
    deliver(msg.id, whole(waiting.body, waiting.layers));
    return;
  }
  if (msg.dropMesh) {
    mesh = { key: "", b64: "" };
    return;
  }
  if (msg.early != null) {
    try {
      const body = JSON.parse(msg.early) as { layers?: unknown };
      if (body.layers) geomPort?.postMessage({ id: msg.id, layers: body.layers, min: msg.min, max: msg.max, objects: msg.objects ?? 1 });
    } catch {
      /* a broken early preview is skipped; the reply still comes */
    }
    return;
  }
  if (msg.parseOnly != null) {
    try {
      const body = JSON.parse(msg.parseOnly) as Reply;
      const parts = body.layerParts;
      if (!parts || parts.count === 0) {
        deliver(msg.id, parts ? whole(body, []) : body);
        return;
      }
      pending.set(msg.id, { body, layers: [], count: parts.count });
      self.postMessage({ id: msg.id, needParts: parts });
    } catch (err) {
      self.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  void run(msg);
};

/**
 * The geometry worker gets its own copy of the layers straight from here,
 * so the main thread never has to clone them a second time. A partial
 * preview goes to the main thread only, which holds the layers it patches.
 */
function deliver(id: number, body: { layers?: unknown; mesh?: { min: number[]; max: number[] }; previewPatch?: unknown; objects?: unknown[] }) {
  if (body.layers && body.mesh && !body.previewPatch) {
    geomPort?.postMessage({ id, layers: body.layers, min: body.mesh.min, max: body.mesh.max, objects: body.objects?.length ?? 1 });
  }
  self.postMessage({ id, ok: true, body });
}

const utf8 = new TextDecoder();

/** Appends one part's layers. One at a time: a spread of 100k arguments throws. */
function addPart(layers: unknown[], part: ArrayBuffer) {
  const chunk = JSON.parse(utf8.decode(part)) as unknown[];
  for (const layer of chunk) layers.push(layer);
}

/** The reply as if it had been sent whole. */
function whole(body: Reply, layers: unknown[]): Reply {
  const { layerParts: _, ...rest } = body;
  return { ...rest, layers };
}

async function run(msg: WorkerRequest) {
  const ctrl = new AbortController();
  jobs.set(msg.id, ctrl);
  try {
    // A plate request carries each object's mesh already.
    const plate = Array.isArray(msg.payload?.objects);
    if (!plate && (msg.bytes || msg.meshKey !== mesh.key)) mesh = { key: msg.meshKey ?? "", b64: bytesToBase64(new Uint8Array(msg.bytes ?? new ArrayBuffer(0))) };
    const payload = plate ? msg.payload : { ...(msg.payload ?? {}), dataB64: mesh.b64 };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (msg.token) headers.Authorization = `Bearer ${msg.token}`;
    const res = await fetch(`${msg.api}/api/slice`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const body = JSON.parse(text) as Reply;
    if (!res.ok) throw new Error(body.error || `slice failed (${res.status})`);
    const parts = body.layerParts;
    if (!parts) {
      deliver(msg.id, body);
      return;
    }
    const layers: unknown[] = [];
    for (let i = 0; i < parts.count; i++) {
      const part = await fetch(`${msg.api}/api/reply/${encodeURIComponent(parts.token)}/${i}`, { headers, signal: ctrl.signal });
      if (!part.ok) throw new Error(`slice reply part ${i} failed (${part.status})`);
      addPart(layers, await part.arrayBuffer());
    }
    deliver(msg.id, whole(body, layers));
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    self.postMessage({
      id: msg.id,
      ok: false,
      cancelled: aborted,
      error: aborted ? "cancelled" : err instanceof Error ? err.message : String(err),
    });
  } finally {
    jobs.delete(msg.id);
  }
}

