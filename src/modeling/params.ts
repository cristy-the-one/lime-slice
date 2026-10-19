/**
 * --- A6. Project parameters and the expression text stored beside a Model op.
 * Parameters evaluate in order, as `mergeParams` does: a later name may use an earlier one.
 * A bad row keeps its sentence and does not enter the table the later rows see.
 */
import { evaluate, ExprError, PARAM_NAME, type Params } from "./expr.ts";
import type { ModelOp } from "../model-tree.ts";
import type { SketchData } from "../sketch/model.ts";

/** A name mapped to a plain number, or to expression text. Insertion order is evaluation order. */
export type ParamTable = Record<string, string | number>;

export interface ParamRow {
  name: string;
  text: string;
  value: number | null;
  error: string | null;
}

export interface EvaluatedTable {
  /** Successful names, in order. Later rows were evaluated against these. */
  values: Params;
  rows: ParamRow[];
}

/** "12", "-3.5" and "1e-2" are plain numbers. An expression is anything else with text. */
export function isPlainNumber(text: string): boolean {
  const trimmed = text.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return false;
  return Number.isFinite(Number(trimmed));
}

/**
 * Evaluate `table` in insertion order. A duplicate or a bad name is an error on that row.
 * An expression error is the evaluator's own sentence. Later rows still see earlier successes.
 */
export function evaluateTable(table: ParamTable): EvaluatedTable {
  const values: Record<string, number> = {};
  const rows: ParamRow[] = [];
  const seen = new Set<string>();
  for (const [name, raw] of Object.entries(table)) {
    const text = typeof raw === "number" ? String(raw) : raw;
    if (!name.trim()) {
      rows.push({ name, text, value: null, error: "Type a name." });
      continue;
    }
    if (!PARAM_NAME.test(name)) {
      rows.push({ name, text, value: null, error: `"${name}" is not a parameter name. Use letters, digits, and underscores.` });
      continue;
    }
    if (seen.has(name)) {
      rows.push({ name, text, value: null, error: `"${name}" is already a parameter.` });
      continue;
    }
    seen.add(name);
    try {
      const value = typeof raw === "number" ? raw : evaluate(text, values);
      if (!Number.isFinite(value)) {
        rows.push({ name, text, value: null, error: `"${text}" is not a finite number.` });
        continue;
      }
      values[name] = value;
      rows.push({ name, text, value, error: null });
    } catch (err) {
      const message = err instanceof ExprError || err instanceof Error ? err.message : String(err);
      rows.push({ name, text, value: null, error: message });
    }
  }
  return { values, rows };
}

/** `name` as a whole word, and not as a function call (`sin(`). `wall` does not match `wallH`. */
export function expressionMentions(text: string, name: string): boolean {
  if (!name || !PARAM_NAME.test(name)) return false;
  const re = new RegExp(`\\b${name}\\b`, "g");
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const after = text.slice(match.index + name.length).trimStart();
    if (after.startsWith("(")) continue;
    return true;
  }
  return false;
}

/** True when `text` names a parameter whose value differs. */
export function expressionChanged(text: string, before: Params, after: Params): boolean {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of names) {
    if (before[name] === after[name]) continue;
    if (expressionMentions(text, name)) return true;
  }
  return false;
}

function sketchesOf(op: ModelOp): SketchData[] {
  const found: SketchData[] = [];
  const take = (sketch: SketchData | null | undefined) => {
    if (sketch) found.push(sketch);
  };
  if (op.kind === "extrude" || op.kind === "revolve") take(op.sketch);
  if (op.kind === "loft" && op.drawing) {
    for (const sketch of op.drawing.sketches ?? []) take(sketch);
    take(op.drawing.sweep?.profile);
    take(op.drawing.sweep?.pathSketch);
  }
  if (op.kind === "group") {
    const source = op.source;
    if (source && typeof source === "object" && "sketch" in source) {
      const sketch = (source as { sketch?: SketchData }).sketch;
      take(sketch);
    }
    for (const step of op.steps) found.push(...sketchesOf(step));
  }
  return found;
}

function textsOf(op: ModelOp): string[] {
  const texts = op.exprs ? Object.values(op.exprs) : [];
  for (const sketch of sketchesOf(op)) {
    for (const dim of sketch.dims ?? []) {
      if (typeof dim.expr === "string") texts.push(dim.expr);
    }
  }
  if (op.kind === "group") {
    for (const step of op.steps) texts.push(...textsOf(step));
  }
  return texts;
}

/** Whether this step, including a group's pieces and a stored sketch's dimensions, names `name`. */
export function stepUses(name: string, op: ModelOp): boolean {
  return textsOf(op).some((text) => expressionMentions(text, name));
}

/**
 * How many history steps use `name`. A group is one step. `rootExprs` counts as the new solid
 * when no later root op has taken its place; the caller leaves it out once one has.
 */
export function usedByCount(name: string, ops: readonly (ModelOp | null)[], rootExprs?: Record<string, string> | null): number {
  let count = 0;
  if (rootExprs && Object.values(rootExprs).some((text) => expressionMentions(text, name))) count += 1;
  for (const op of ops) if (op && stepUses(name, op)) count += 1;
  return count;
}

const NEAR = 1e-6;

function blend(current: number, oldValue: number, newValue: number, absolute: boolean): number {
  return absolute || Math.abs(current - oldValue) <= NEAR ? newValue : current + (newValue - oldValue);
}

type Path = readonly (string | number)[];

/** Panel field id → where that number sits on a plain op. */
const FIELD_PATH: Record<string, Path> = {
  modelDx: ["size", 0],
  modelDy: ["size", 1],
  modelDz: ["size", 2],
  modelRadius: ["radius"],
  modelHeight: ["height"],
  modelTopX: ["topX"],
  modelTopR: ["topRadius"],
  modelTube: ["tubeRadius"],
  modelInnerR: ["innerRadius"],
  modelSides: ["sides"],
  modelAcross: ["across"],
  modelHoleR: ["radius"],
  modelHoleD: ["depth"],
  modelBoreR: ["counterboreRadius"],
  modelBoreD: ["counterboreDepth"],
  modelBlend: ["size"],
  modelShell: ["thickness"],
  modelFactor: ["factor"],
  modelX: ["origin", 0],
  modelY: ["origin", 1],
  modelZ: ["origin", 2],
  modelRx: ["turn", 0],
  modelRy: ["turn", 1],
  modelRz: ["turn", 2],
  depth: ["depth"],
  depth2: ["depth2"],
  draftDeg: ["draftDeg"],
  draft: ["draftDeg"],
  angle: ["angleDeg"],
  distance: ["depth"],
  modelPull: ["distance"],
};

const SOURCE_PATH: Record<string, Path> = {
  modelFeatDepth: ["depth"],
  modelFeatW: ["width"],
  modelFeatH: ["height"],
  modelFeatDia: ["diameter"],
  modelFeatU: ["at", "u"],
  modelFeatV: ["at", "v"],
  modelFeatBarsV: ["bars", "vertical"],
  modelFeatBarsH: ["bars", "horizontal"],
  modelFeatBarW: ["bars", "width"],
  modelTexPitchU: ["pitch", 0],
  modelTexPitchV: ["pitch", 1],
  modelTexGroove: ["grooveWidth"],
  modelHoleR: ["radius"],
  modelHoleD: ["depth"],
  modelBoreR: ["counterboreRadius"],
  modelBoreD: ["counterboreDepth"],
};

function readPath(value: unknown, path: Path): number | null {
  let at: unknown = value;
  for (const key of path) {
    if (Array.isArray(at) && typeof key === "number") at = at[key];
    else if (at && typeof at === "object" && typeof key === "string") at = (at as Record<string, unknown>)[key];
    else return null;
  }
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

function writePath(value: unknown, path: Path, next: number): unknown {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  if (typeof head === "number" && Array.isArray(value)) {
    const copy = value.slice();
    copy[head] = writePath(copy[head], rest, next);
    return copy;
  }
  if (typeof head === "string" && value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return { ...record, [head]: writePath(record[head], rest, next) };
  }
  return value;
}

function patchRecord(record: Record<string, unknown>, path: Path, oldValue: number, newValue: number, absolute: boolean): Record<string, unknown> {
  const current = readPath(record, path);
  if (current == null) return record;
  return writePath(record, path, blend(current, oldValue, newValue, absolute)) as Record<string, unknown>;
}

/**
 * The op with each expression's number brought up to `after`. A stored number that still equals
 * the old evaluation is replaced. One that was edited by hand moves by the same delta.
 * Sketch geometry is left for the caller that can re-solve it.
 */
export function patchOpNumbers(op: ModelOp, before: Params, after: Params, absolute = false): { op: ModelOp; error?: string } {
  let next = op;
  const apply = (target: ModelOp, key: string, text: string, spread: boolean): ModelOp | { error: string } => {
    if (!expressionChanged(text, before, after)) return target;
    let oldValue: number;
    let newValue: number;
    try {
      newValue = evaluate(text, after);
      oldValue = absolute ? newValue : evaluate(text, before);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: message };
    }
    if (!Number.isFinite(oldValue) || !Number.isFinite(newValue)) return { error: `"${text}" is not a finite number.` };
    let patched = target as Record<string, unknown>;
    const pull = key === "distance" || key === "modelPull";
    if (pull && target.kind === "extrude" && typeof target.depth === "number") {
      patched = { ...patched, depth: blend(target.depth, Math.abs(oldValue), Math.abs(newValue), absolute) };
    } else if (pull && target.kind === "faceExtrude") {
      patched = { ...patched, distance: blend(target.distance, oldValue, newValue, absolute) };
    } else if (pull && target.kind === "moveFaces") {
      patched = {
        ...patched,
        faces: target.faces.map((face) => ({ ...face, distance: blend(face.distance, oldValue, newValue, absolute) })),
      };
    } else if (key === "modelBlend" && (target.kind === "fillet" || target.kind === "chamfer")) {
      patched = { ...patched, size: blend(target.size, oldValue, newValue, absolute) };
    } else {
      const direct = FIELD_PATH[key];
      if (direct && target.kind !== "group" && key !== "distance" && key !== "modelPull") {
        patched = patchRecord(patched, direct, oldValue, newValue, absolute);
      }
    }
    if (target.kind === "group" && target.source && typeof target.source === "object") {
      const sourcePath = SOURCE_PATH[key];
      if (sourcePath) {
        patched = { ...patched, source: patchRecord(target.source as Record<string, unknown>, sourcePath, oldValue, newValue, absolute) };
      }
    }
    if (key === "scale" && target.kind === "loft" && target.drawing?.sweep && typeof target.drawing.sweep.scale === "number") {
      const scale = blend(target.drawing.sweep.scale, oldValue, newValue, absolute);
      patched = { ...patched, drawing: { ...target.drawing, sweep: { ...target.drawing.sweep, scale } } };
    }
    if (spread && target.kind === "group") {
      const steps = ((patched.steps as ModelOp[] | undefined) ?? target.steps).map((step) => {
        if (step.exprs && Object.hasOwn(step.exprs, key)) return step;
        const child = apply(step, key, text, false);
        return "error" in child ? step : child;
      });
      patched = { ...patched, steps };
    }
    return patched as ModelOp;
  };
  if (next.exprs) {
    for (const [key, text] of Object.entries(next.exprs)) {
      const patched = apply(next, key, text, true);
      if ("error" in patched) return { op, error: patched.error };
      next = patched;
    }
  }
  if (next.kind === "group") {
    const group = next;
    const steps: ModelOp[] = [];
    for (const step of group.steps) {
      const child = patchOpNumbers(step, before, after, absolute);
      if (child.error) return { op, error: child.error };
      steps.push(child.op);
    }
    if (steps.some((step, index) => step !== group.steps[index])) next = { ...group, steps };
  }
  return { op: next };
}

function numbersDiffer(stored: number, expected: number): boolean {
  return Math.abs(stored - expected) > NEAR;
}

/** The stored number for `key` no longer matches `text` at `after`, or `text` does not evaluate. */
function fieldOutOfDate(op: ModelOp, key: string, text: string, after: Params): boolean {
  let value: number;
  try {
    value = evaluate(text, after);
  } catch {
    return true;
  }
  if (!Number.isFinite(value)) return true;
  const pull = key === "distance" || key === "modelPull";
  if (pull && op.kind === "extrude") return numbersDiffer(op.depth, Math.abs(value));
  if (pull && op.kind === "faceExtrude") return numbersDiffer(op.distance, value);
  if (pull && op.kind === "moveFaces") return op.faces.some((face) => numbersDiffer(face.distance, value));
  if (key === "modelBlend" && (op.kind === "fillet" || op.kind === "chamfer")) return numbersDiffer(op.size, value);
  if (key === "scale" && op.kind === "loft" && typeof op.drawing?.sweep?.scale === "number") return numbersDiffer(op.drawing.sweep.scale, value);
  if (op.kind === "group" && op.source && typeof op.source === "object") {
    const sourcePath = SOURCE_PATH[key];
    const stored = sourcePath ? readPath(op.source, sourcePath) : null;
    if (stored != null && numbersDiffer(stored, value)) return true;
  }
  const direct = FIELD_PATH[key];
  if (direct && op.kind !== "group" && !pull) {
    const stored = readPath(op, direct);
    if (stored != null && numbersDiffer(stored, value)) return true;
  }
  return false;
}

/** A step whose expression, or a driving dimension, does not match `after`. A group is one step. */
export function stepOutOfDate(op: ModelOp, after: Params): boolean {
  if (op.exprs) {
    for (const [key, text] of Object.entries(op.exprs)) {
      if (fieldOutOfDate(op, key, text, after)) return true;
    }
  }
  for (const sketch of sketchesOf(op)) {
    for (const dim of sketch.dims ?? []) {
      if (typeof dim.expr !== "string" || !dim.expr.trim()) continue;
      try {
        const value = evaluate(dim.expr, after);
        const stored = dim.value;
        if (typeof stored !== "number" || !Number.isFinite(value) || numbersDiffer(stored, value)) return true;
      } catch {
        return true;
      }
    }
  }
  if (op.kind === "group" && op.steps.some((step) => stepOutOfDate(step, after))) return true;
  return false;
}

/** Keep expression text that is not a plain number. A plain number drops that key. */
export function withExprs(op: ModelOp, texts: Record<string, string | null | undefined> | undefined): ModelOp {
  if (!texts) return op;
  const exprs: Record<string, string> = { ...(op.exprs ?? {}) };
  let touched = false;
  for (const [key, text] of Object.entries(texts)) {
    if (!text || !text.trim() || isPlainNumber(text)) {
      if (key in exprs) {
        delete exprs[key];
        touched = true;
      }
      continue;
    }
    exprs[key] = text.trim();
    touched = true;
  }
  if (!touched) return op;
  if (Object.keys(exprs).length === 0) {
    const { exprs: _drop, ...rest } = op;
    return rest;
  }
  return { ...op, exprs };
}
