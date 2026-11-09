/**
 * --- docs/plan-native-recipes.md 7.1, "What queues silently". The recipe lines whose `apply` reply the recipe does not
 * read, found in the built text (the recipe with its ingredients after it, as lust built it), so the host can hold
 * those applies back and build them together.
 *
 * The plan has lust mark these lines in its build output; the pinned lust does not yet, so the host reads the text
 * itself, and only claims a line when the shape of the call alone proves the reply is unread:
 *
 * - `s.apply(..);`, `s.apply(..)?;`, `s.apply(..).unwrap();`, `s.apply(..).expect("..");` as a whole statement, or
 *   after `let _ =`;
 * - `s.apply(..).is_ok()` or `.is_err()` anywhere (a bool says nothing of the reply);
 * - `match s.apply(..) { Ok(_) => .., Err(e) => .. }` and `if let Ok(_) | Err(..) = s.apply(..)`, where the `Ok` arm
 *   binds nothing.
 *
 * Anything else is read: `let r = s.apply(..)?;`, a tail expression, an argument, a field read. The text is a recipe
 * that built, so the receiver is a lime-recipe `Session`, unless the recipe or an ingredient defines a function called
 * `apply` of its own: then no line is claimed. A line that holds two applies is claimed only when both are unread.
 * Comments and strings are blanked first, keeping every line and column.
 *
 * When lust gains the mark (the request is in the plan's "As built" for milestone 3), its list replaces this one.
 */

/** Comments, string and char literals as spaces, newlines kept: what is left is code at the same line and column. */
export function codeOnly(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      // Rust block comments nest.
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text[j] === "/" && text[j + 1] === "*") { depth += 1; j += 2; continue; }
        if (text[j] === "*" && text[j + 1] === "/") { depth -= 1; j += 2; if (depth === 0) break; continue; }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    // Raw strings: r"..", r#".."#, br#".."#.
    const raw = /^b?r(#*)"/.exec(text.slice(i, i + 40));
    if (raw && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]!))) {
      const close = `"${raw[1]}`;
      const end = text.indexOf(close, i + raw[0].length);
      const stop = end < 0 ? text.length : end + close.length;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || (c === "b" && next === '"' && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]!)))) {
      let j = c === "b" ? i + 2 : i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      blank(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "'") {
      // A char literal ('a', '\n', '\u{1F600}'), not a lifetime ('a in <'a>).
      const lit = /^'(?:\\(?:u\{[0-9A-Fa-f]{1,6}\}|x[0-9A-Fa-f]{2}|.)|[^\\'\n])'/u.exec(text.slice(i, i + 16));
      if (lit) {
        blank(i, i + lit[0].length);
        i += lit[0].length;
        continue;
      }
    }
    i += 1;
  }
  return out.join("");
}

/** The index just past the bracket that closes the one at `open` (`(`, `[` or `{`), or -1. */
function closing(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < code.length; i += 1) {
    const c = code[i]!;
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

function skipSpace(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i]!)) i += 1;
  return i;
}

function backSpace(code: string, i: number): number {
  while (i >= 0 && /\s/.test(code[i]!)) i -= 1;
  return i;
}

/** The 1-based line of index `at`. */
function lineAt(at: number, starts: number[]): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Whether every arm of the `match` block at `open` binds nothing of an `Ok` value: each pattern is `Ok(_)`, `Ok(..)`,
 * `Err(..)` or `_`, with any guard.
 */
function armsBindNothing(code: string, open: number): boolean {
  const end = closing(code, open);
  if (end < 0) return false;
  // The block's own level: each `{..}` inside it (an arm's body) as `{}`.
  let flat = "";
  let depth = 0;
  for (const c of code.slice(open + 1, end - 1)) {
    if (c === "{") {
      if (depth === 0) flat += "{}";
      depth += 1;
    } else if (c === "}") depth -= 1;
    else if (depth === 0) flat += c;
  }
  const parts = flat.split("=>");
  if (parts.length < 2) return false;
  for (const part of parts.slice(0, -1)) {
    const pattern = part.split(/[,}]/).pop()!.trim();
    if (!/^(Ok\s*\(\s*(_|\.\.)\s*\)|Err\s*\([^()]*\)|_)(\s+if.*)?$/s.test(pattern)) return false;
  }
  return true;
}

/**
 * The 1-based lines of `text` holding an `apply` call (method `.apply(`) whose reply the recipe does not read. A line
 * is in the set only when every `.apply(` on it is unread. Also the line of the receiver when the call is split over
 * lines (`s\n    .apply(..)`), since that is where some compilers report it.
 */
export function unreadApplyLines(text: string): Set<number> {
  const code = codeOnly(text);
  const lines = new Set<number>();
  // A function of the recipe's own called `apply` could read what it got: claim nothing.
  if (/\bfn\s+apply\s*[<(]/.test(code)) return lines;
  const starts = [0];
  for (let i = 0; i < code.length; i += 1) if (code[i] === "\n") starts.push(i + 1);
  const read = new Set<number>();
  for (const m of code.matchAll(/\.\s*apply\s*\(/g)) {
    const dot = m.index!;
    const open = dot + m[0].length - 1;
    const close = closing(code, open);
    const nameAt = dot + m[0].indexOf("apply");
    const line = lineAt(nameAt, starts);
    // The receiver: a path like `s`, `self.s`, `ctx.session`, walked back from the dot.
    let r = backSpace(code, dot - 1);
    while (r >= 0 && /[A-Za-z0-9_.]/.test(code[r]!)) r -= 1;
    const receiverStart = r + 1;
    const receiverLine = lineAt(receiverStart, starts);
    const before = code.slice(0, receiverStart).replace(/\s+$/, "");
    const unread = close > 0 && isUnread(code, before, close);
    for (const at of new Set([line, receiverLine])) {
      if (unread) lines.add(at);
      else read.add(at);
    }
  }
  for (const at of read) lines.delete(at);
  return lines;
}

function isUnread(code: string, before: string, close: number): boolean {
  let after = skipSpace(code, close);
  const rest = code.slice(after, after + 40);
  // A bool of the result says nothing of the reply.
  if (/^\.\s*is_(ok|err)\s*\(\s*\)/.test(rest)) return true;
  const statementStart = before === "" || /[;{}]$/.test(before) || /\blet\s+_\s*=$/.test(before);
  // `match s.apply(..) {` and `if let Ok(_) = s.apply(..)`.
  if (/\bmatch$/.test(before)) {
    if (code[after] !== "{") return false;
    return armsBindNothing(code, after);
  }
  const letOk = /\b(if|while)\s+let\s+(Ok\s*\(\s*(_|\.\.)\s*\)|Err\s*\([^)]*\))\s*=$/.exec(before);
  if (letOk) return true;
  if (!statementStart) return false;
  // What follows the call, up to the statement's end.
  if (code[after] === ";") return true;
  if (code[after] === "?") {
    after = skipSpace(code, after + 1);
    return code[after] === ";";
  }
  const unwrap = /^\.\s*(unwrap\s*\(\s*\)|expect\s*\()/.exec(rest);
  if (unwrap) {
    let end: number;
    if (unwrap[1]!.startsWith("expect")) {
      const open = after + rest.indexOf("(");
      end = closing(code, open);
      if (end < 0) return false;
    } else end = after + unwrap[0].length;
    return code[skipSpace(code, end)] === ";";
  }
  return false;
}
