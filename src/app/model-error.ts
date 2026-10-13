import { MODEL_TOOLS } from "../model-drag.ts";

/** Open CASCADE class names that should never reach the readout. */
const OCCT_NAME = /(?:BRep|TopoDS|StdFail|gp_)/;

/** Last technical string already printed, so a repeat failure does not spam the console. */
let warnedTechnical = "";

/** Text from a modeler failure.
 *
 * The desktop command rejects with the Rust `Err` string. That value is not an
 * `Error`, so reading only `err.message` hid the bridge's load failure.
 * An Open CASCADE exception is rewritten; the bridge's own load error is not.
 */
export function modelerFailure(err: unknown, tool?: string): string {
  const text = failureText(err);
  if (!text) return "The modeler returned an error.";
  return plainModelError(text, tool);
}

/** Plain readout for an Open CASCADE exception. Anything else is returned unchanged. */
export function plainModelError(message: string, tool?: string): string {
  const trimmed = message.trim();
  if (!OCCT_NAME.test(trimmed)) return trimmed;
  if (trimmed !== warnedTechnical) {
    warnedTechnical = trimmed;
    console.warn(trimmed);
  }
  const name = tool && (MODEL_TOOLS as readonly string[]).includes(tool) ? tool : "model";
  return `Could not complete this ${name} operation on the selected geometry. Try a smaller dimension or a different face or edge.`;
}

function failureText(err: unknown): string {
  if (typeof err === "string") return err.trim();
  if (err instanceof Error) return err.message.trim();
  if (err && typeof err === "object") {
    const record = err as { message?: unknown; error?: unknown };
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
  }
  return "";
}
