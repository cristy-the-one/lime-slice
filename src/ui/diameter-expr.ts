/**
 * B24. Hole's fields show a diameter while the op keeps the radius. An expression typed in a diameter field is stored as
 * the radius's, and a stored radius expression is shown as the diameter's, so older files keep their meaning. A
 * wrapper this module added is taken off again rather than stacked.
 */

/** Whether `text` closes every bracket it opens and never closes one it did not open. */
function balanced(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/** `(inner) <op> 2` with `inner` one whole term, or null. */
function unwrap(text: string, op: "*" | "/"): string | null {
  const suffix = ` ${op} 2`;
  if (!text.startsWith("(") || !text.endsWith(`)${suffix}`)) return null;
  const inner = text.slice(1, -(suffix.length + 1));
  return balanced(inner) ? inner : null;
}

/** A diameter expression as the radius the op stores. */
export function radiusExpr(diameter: string): string {
  return unwrap(diameter, "*") ?? `(${diameter}) / 2`;
}

/** A stored radius expression as the diameter the field shows. */
export function diameterExpr(radius: string): string {
  return unwrap(radius, "/") ?? `(${radius}) * 2`;
}
