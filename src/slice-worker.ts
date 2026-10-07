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
  cancel?: boolean;
  /** Port to the geometry worker, sent once at startup. */
  geomPort?: MessagePort;
}

const jobs = new Map<number, AbortController>();
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
    return;
  }
  if (msg.parseOnly != null) {
    try {
      deliver(msg.id, JSON.parse(msg.parseOnly));
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
    const body = JSON.parse(text) as Parameters<typeof deliver>[1] & { error?: string };
    if (!res.ok) throw new Error(body.error || `slice failed (${res.status})`);
    deliver(msg.id, body);
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

