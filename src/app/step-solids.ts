/** The solids of a STEP file, each as a STEP file of its own, as the kernel's `stepSolids` writes them. */
import { base64ToBytes, bytesToBase64Async } from "../base64";
import type { StepSolidRow } from "../step-solids";
import { authHeaders, currentApiTarget } from "../ui/api-base";

/** Each solid of this STEP file in the file's order, with its product name and its own STEP file; or the refusal. */
export async function stepSolidFiles(bytes: ArrayBuffer): Promise<(StepSolidRow & { bytes: ArrayBuffer })[] | string> {
  const reply = await treeCall({ call: "stepSolids", dataB64: await bytesToBase64Async(new Uint8Array(bytes)), files: true });
  if (typeof reply.error === "string") return reply.error;
  const rows = Array.isArray(reply.solids) ? (reply.solids as { name?: unknown; bytesBase64?: unknown }[]) : [];
  const out: (StepSolidRow & { bytes: ArrayBuffer })[] = [];
  for (const row of rows) {
    const file = typeof row.bytesBase64 === "string" ? base64ToBytes(row.bytesBase64) : null;
    if (!file) return "The kernel did not write the solids of this STEP file.";
    out.push({ name: typeof row.name === "string" ? row.name : "", bytes: file.slice().buffer as ArrayBuffer });
  }
  return out;
}

export async function treeCall(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      const { invoke } = await import("@tauri-apps/api/core");
      return JSON.parse(await invoke<string>("model_tree", { payload: JSON.stringify(payload) })) as Record<string, unknown>;
    }
    const { base, token } = currentApiTarget();
    const res = await fetch(`${base}/api/model/tree`, {
      method: "POST",
      headers: authHeaders(token, { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as Record<string, unknown>;
    return res.ok || typeof body.error === "string" ? body : { error: "The modeler did not answer." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message === "Failed to fetch" ? `Opening a STEP file's solids needs the slicer engine at ${currentApiTarget().base}.` : message };
  }
}
