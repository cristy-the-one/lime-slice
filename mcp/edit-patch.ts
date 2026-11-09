/**
 * model_edit {object, node: "Lug A", patch: {dx: 5}}: change fields of one step of a model_build object by its label.
 * The patch lands on the op as it was typed (the recipe the build kept), and the caller rebuilds from it, so the
 * build's own resume reuses every step before the changed one.
 */

type Op = Record<string, unknown>;

export type Patched = { ops: Op[]; index: number; label: string; fields: string[] } | { reason: string; code: "missing-argument" | "bad-argument" | "step-not-found" | "bad-op" };

const SAFE = /^[A-Za-z0-9_]+$/;

/** A dotted key ("with.w") reaches into an object field, such as a `use` step's `with`. null removes the field. */
function setPath(op: Op, key: string, value: unknown): string | null {
  const parts = key.split(".");
  if (parts.some((part) => !SAFE.test(part))) return `${key} is not a field name.`;
  let at: Record<string, unknown> = op;
  for (const part of parts.slice(0, -1)) {
    const next = at[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) return `${parts[0]} has no field ${part}; patch ${key} reaches into an object.`;
    at = next as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (value === null) delete at[last];
  else at[last] = value;
  return null;
}

/**
 * `ops` are the build's ops as typed. `check` validates one patched op against the op schema and returns a sentence
 * or null; a field the op's kind does not take comes back from it by name.
 */
export function patchStep(ops: Op[], node: unknown, patch: unknown, check: (op: Op) => string | null): Patched {
  if (typeof node !== "string" || !node.trim()) return { code: "missing-argument", reason: "model_edit with patch needs node: the step's label." };
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) return { code: "bad-argument", reason: "patch must be an object of fields to change, such as {dx: 5}." };
  if (/^node_\d+$/i.test(node.trim())) return { code: "bad-argument", reason: "A patch finds its step by the label it was built with. Pass that label as node, or pass op to replace a history step." };
  const wanted = node.trim().toLowerCase();
  const hits = ops.map((op, index) => ({ op, index })).filter((row) => typeof row.op.label === "string" && row.op.label.trim().toLowerCase() === wanted);
  if (hits.length === 0) {
    const labels = ops.map((op) => op.label).filter((label): label is string => typeof label === "string");
    return { code: "step-not-found", reason: `No step of this build is labelled "${node}".${labels.length ? ` Its labels: ${[...new Set(labels)].slice(0, 20).join(", ")}.` : " None of its steps has a label; give them label in model_build."}` };
  }
  if (hits.length > 1) return { code: "bad-argument", reason: `${hits.length} steps are labelled "${node}" (steps ${hits.map((row) => row.index + 1).join(", ")}). Give each its own label in model_build, then patch one.` };
  const { op, index } = hits[0]!;
  const next = structuredClone(op);
  const fields = Object.keys(patch);
  for (const key of fields) {
    if (key === "kind") return { code: "bad-argument", reason: "A patch cannot change a step's kind. Pass op to replace the step." };
    const problem = setPath(next, key, (patch as Record<string, unknown>)[key]);
    if (problem) return { code: "bad-argument", reason: problem };
  }
  const bad = check(next);
  if (bad) return { code: "bad-op", reason: `The patched ${String(op.kind)} step "${node}" is refused: ${bad.replace(/^(ops\[\d+\]|op)\./, "")} Nothing changed.` };
  return { ops: ops.map((row, i) => i === index ? next : row), index, label: node.trim(), fields };
}
