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

export type PatchedMany = { ops: Op[]; first: number; changed: string[] } | { reason: string; code: "missing-argument" | "bad-argument" | "step-not-found" | "bad-op" };

/** A step of the build by its label, or by its number in the ops (from 1), which also tells two steps of one label apart. */
function findStep(ops: Op[], node: unknown): { index: number } | { reason: string; code: "bad-argument" | "step-not-found" } {
  if (typeof node === "number") {
    if (!Number.isInteger(node) || node < 1 || node > ops.length) return { code: "step-not-found", reason: `This build has ${ops.length} steps; ${node} is not one of them.` };
    return { index: node - 1 };
  }
  if (typeof node !== "string" || !node.trim()) return { code: "bad-argument", reason: "node is the step's label, or its number in the build's ops, from 1." };
  if (/^node_\d+$/i.test(node.trim())) return { code: "bad-argument", reason: "A patch finds its step by the label it was built with, or by its number in the build's ops. node_N is a history step: pass op to replace one." };
  const wanted = node.trim().toLowerCase();
  const hits = ops.map((op, index) => ({ op, index })).filter((row) => typeof row.op.label === "string" && row.op.label.trim().toLowerCase() === wanted);
  if (hits.length === 1) return { index: hits[0]!.index };
  if (hits.length > 1) return { code: "bad-argument", reason: `${hits.length} steps are labelled "${node}" (steps ${hits.map((row) => row.index + 1).join(", ")}). Pass one's number as node.` };
  const labels = ops.map((op) => op.label).filter((label): label is string => typeof label === "string");
  return { code: "step-not-found", reason: `No step of this build is labelled "${node}".${labels.length ? ` Its labels: ${[...new Set(labels)].slice(0, 20).join(", ")}.` : " None of its steps has a label; pass the step's number."}` };
}

/**
 * model_edit {object, patches: [...]}: several changes to a model_build object's ops in one call and one rebuild, so an
 * iteration sends what changed and not the build again (in the audited sessions 65% of the ops bytes of back-to-back
 * model_build calls were unchanged). Each entry, in order, on the ops as the entries before it left them:
 *   {node, patch: {field: value}}        set fields of a step (a dotted key reaches into an object; null removes one)
 *   {node, remove: true}                 take the step out
 *   {insert: op, after: node | before: node}   put a new op there; with neither, at the end
 * `node` is a label or the step's number, from 1. Nothing changes unless every entry is good.
 */
export function patchSteps(ops: Op[], patches: unknown, check: (op: Op) => string | null): PatchedMany {
  if (!Array.isArray(patches) || patches.length === 0) return { code: "bad-argument", reason: "patches is a list such as [{node: \"lug\", patch: {dx: 5}}, {node: \"old\", remove: true}, {insert: {kind: ...}, after: \"lug\"}]." };
  let next = ops.map((op) => structuredClone(op));
  let first = ops.length;
  const changed: string[] = [];
  for (let i = 0; i < patches.length; i += 1) {
    const entry = patches[i] as Record<string, unknown> | null;
    const where = `patches[${i}]`;
    const fail = (code: "missing-argument" | "bad-argument" | "step-not-found" | "bad-op", reason: string): PatchedMany => ({ code, reason: `${where}: ${reason} Nothing changed.` });
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail("bad-argument", "an entry is {node, patch}, {node, remove: true}, or {insert: op, after | before: node}.");
    const forms = ["patch", "remove", "insert"].filter((key) => entry[key] !== undefined);
    if (forms.length !== 1) return fail("bad-argument", "an entry takes one of patch, remove: true, or insert.");
    if (entry.insert !== undefined) {
      const op = entry.insert;
      if (!op || typeof op !== "object" || Array.isArray(op)) return fail("bad-argument", "insert is the new op.");
      if (entry.after !== undefined && entry.before !== undefined) return fail("bad-argument", "insert takes after or before, not both.");
      const anchor = entry.after ?? entry.before;
      let at = next.length;
      if (anchor !== undefined) {
        const found = findStep(next, anchor);
        if ("reason" in found) return fail(found.code, found.reason);
        at = entry.after !== undefined ? found.index + 1 : found.index;
      }
      const bad = check(structuredClone(op as Op));
      if (bad) return fail("bad-op", `the inserted op is refused: ${bad.replace(/^(ops\[\d+\]|op)\./, "")}`);
      next.splice(at, 0, structuredClone(op as Op));
      first = Math.min(first, at);
      changed.push(`inserted ${String((op as Op).label ?? (op as Op).kind)} as step ${at + 1}`);
      continue;
    }
    const found = findStep(next, entry.node);
    if ("reason" in found) return fail(found.code, found.reason);
    const op = next[found.index]!;
    const name = typeof op.label === "string" ? op.label : `step ${found.index + 1}`;
    if (entry.remove !== undefined) {
      if (entry.remove !== true) return fail("bad-argument", "remove is true.");
      next = next.filter((_, at) => at !== found.index);
      first = Math.min(first, found.index);
      changed.push(`removed ${name}`);
      continue;
    }
    const patch = entry.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) return fail("bad-argument", "patch must be an object of fields to change, such as {dx: 5}.");
    for (const key of Object.keys(patch)) {
      if (key === "kind") return fail("bad-argument", "a patch cannot change a step's kind. Remove the step and insert the new op.");
      const problem = setPath(op, key, (patch as Record<string, unknown>)[key]);
      if (problem) return fail("bad-argument", problem);
    }
    const bad = check(structuredClone(op));
    if (bad) return fail("bad-op", `the patched ${String(op.kind)} step ${name} is refused: ${bad.replace(/^(ops\[\d+\]|op)\./, "")}`);
    first = Math.min(first, found.index);
    changed.push(`${name}: ${Object.keys(patch).join(", ")}`);
  }
  return { ops: next, first, changed };
}
