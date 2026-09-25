/// Base64-encode the mesh and parse the slice JSON off the main thread.

export interface WorkerRequest {
  id: number;
  bytes?: ArrayBuffer;
  filename?: string;
  payload?: Record<string, unknown>;
  api?: string;
  parseOnly?: string;
  cancel?: boolean;
}

const jobs = new Map<number, AbortController>();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.cancel) {
    jobs.get(msg.id)?.abort();
    jobs.delete(msg.id);
    return;
  }
  if (msg.parseOnly != null) {
    try {
      const body = JSON.parse(msg.parseOnly) as unknown;
      self.postMessage({ id: msg.id, ok: true, body });
    } catch (err) {
      self.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  void run(msg);
};

async function run(msg: WorkerRequest) {
  const ctrl = new AbortController();
  jobs.set(msg.id, ctrl);
  try {
    const payload = { ...(msg.payload ?? {}), dataB64: toBase64(new Uint8Array(msg.bytes ?? new ArrayBuffer(0))) };
    const res = await fetch(`${msg.api}/api/slice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const body = JSON.parse(text) as { error?: string };
    if (!res.ok) throw new Error(body.error || `slice failed (${res.status})`);
    self.postMessage({ id: msg.id, ok: true, body });
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

function toBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
