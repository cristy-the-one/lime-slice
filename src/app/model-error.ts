/** Text from a modeler failure.
 *
 * The desktop command rejects with the Rust `Err` string. That value is not an
 * `Error`, so reading only `err.message` hid the bridge's load failure.
 */
export function modelerFailure(err: unknown): string {
  const text = failureText(err);
  return text || "The modeler returned an error.";
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
