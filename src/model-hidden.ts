/**
 * Hidden plate objects in the Model view: a view choice, kept for the session. A hidden object is not built into the
 * view at all, so it cannot be drawn, hovered, picked, measured against or snapped to. The plate, slicing, export, the
 * saved project and the checks never read this.
 */

const hidden = new Set<string>();

export function isHidden(id: string): boolean {
  return hidden.has(id);
}

export function hiddenCount(): number {
  return hidden.size;
}

/** A string that changes when the hidden set does, for repaint keys. */
export function hiddenKey(): string {
  return [...hidden].sort().join(",");
}

export function setHidden(id: string, on: boolean): void {
  if (on) hidden.add(id);
  else hidden.delete(id);
}

/** Show only `id`: every other object of `ids` is hidden. A second call for the same object shows all again. */
export function isolate(id: string, ids: readonly string[]): void {
  const others = ids.filter((other) => other !== id);
  const already = others.length > 0 && others.every((other) => hidden.has(other)) && !hidden.has(id);
  hidden.clear();
  if (!already) for (const other of others) hidden.add(other);
}

export function showAll(): void {
  hidden.clear();
}

/**
 * Forget ids that left the plate, and the open object, which is always shown: opening a hidden object shows it.
 * Returns whether anything changed.
 */
export function pruneHidden(plateIds: readonly string[], openId: string | null): boolean {
  const before = hidden.size;
  const live = new Set(plateIds);
  for (const id of [...hidden]) if (!live.has(id) || id === openId) hidden.delete(id);
  return hidden.size !== before;
}

/** The parts the view may build: everything but the hidden objects. */
export function visibleParts<T extends { id: string }>(parts: readonly T[]): T[] {
  return hidden.size === 0 ? [...parts] : parts.filter((part) => !hidden.has(part.id));
}
