/**
 * The recipes guide's `api` section, read from the lime_recipe crate (docs/plan-agent-ergonomics.md E6).
 * An installed server reads the copy beside it (`lime-recipe/src/lib.rs`, as recipe_run does); a checkout
 * reads `crates/lime-recipe/src/lib.rs`. The text is not hand-written. mcp/recipe-api.test.ts fails when a
 * public item is missing from the section.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RecipeApiItem {
  /** `lime_recipe` or `lime_recipe::geom2d`. */
  module: string;
  kind: "fn" | "struct" | "enum" | "trait" | "type" | "const" | "static";
  /** The item's own name: `obj`, `Json`, `API`. */
  rawName: string;
  /** `Json::obj` for an inherent method, otherwise the same as rawName. */
  name: string;
  /** One line: `fn Json::obj() -> Json`. */
  signature: string;
  /** The first line of the doc comment, or empty. */
  doc: string;
}

const KEYWORDS = new Set(["fn", "struct", "enum", "trait", "type", "const", "static", "mod", "impl", "use"]);

function codeOnly(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|b?r(#*)"[\s\S]*?"\1|b?"(?:\\[\s\S]|[^"\\])*"|b?'(?:\\.|[^\\'\n])'/g, blank);
}

/** The crate source this process would build a recipe against. */
export function recipeCrateSource(): string {
  const named = process.env.LIME_RECIPE_CRATE;
  if (named) return readFileSync(join(named, "src", "lib.rs"), "utf8");
  const beside = fileURLToPath(new URL("./lime-recipe/src/lib.rs", import.meta.url));
  if (existsSync(beside)) return readFileSync(beside, "utf8");
  return readFileSync(fileURLToPath(new URL("../crates/lime-recipe/src/lib.rs", import.meta.url)), "utf8");
}

type Block = { kind: "mod" | "impl" | "fn" | "other"; pub: boolean; name: string; inherent: boolean };

/** Every public type, function and const in a public module, in source order. */
export function recipeApiItems(source: string): RecipeApiItem[] {
  const code = codeOnly(source);
  const items: RecipeApiItem[] = [];
  const stack: Block[] = [{ kind: "mod", pub: true, name: "lime_recipe", inherent: false }];
  let i = 0;
  const n = code.length;
  const space = (c: string | undefined) => c === " " || c === "\n" || c === "\t" || c === "\r";
  const skipWs = (at: number) => {
    while (at < n && space(code[at])) at += 1;
    return at;
  };
  const readIdent = (at: number) => {
    let j = at;
    while (j < n && /[A-Za-z0-9_]/.test(code[j]!)) j += 1;
    return { text: code.slice(at, j), end: j };
  };
  const modulePublic = () => stack.every((b) => b.kind !== "mod" || b.pub);
  const insideFn = () => stack.some((b) => b.kind === "fn");
  const moduleName = () => stack.filter((b) => b.kind === "mod").map((b) => b.name).join("::");
  const implOf = () => {
    for (let k = stack.length - 1; k >= 0; k -= 1) if (stack[k]!.kind === "impl") return stack[k];
    return undefined;
  };

  function skipAttr(at: number): number {
    let depth = 0;
    for (let j = at; j < n; j += 1) {
      if (code[j] === "[") depth += 1;
      else if (code[j] === "]" && --depth === 0) return j + 1;
    }
    return n;
  }

  /** The `{` or `;` that ends a header. A const's signature stops at `=`. */
  function headerEnd(at: number, stopAtEq: boolean): { end: number; sigEnd: number; opens: boolean } {
    let angle = 0;
    let paren = 0;
    let bracket = 0;
    for (let j = at; j < n; j += 1) {
      const c = code[j]!;
      if (c === "<") angle += 1;
      else if (c === ">" && angle > 0) angle -= 1;
      else if (c === "(") paren += 1;
      else if (c === ")") paren -= 1;
      else if (c === "[") bracket += 1;
      else if (c === "]") bracket -= 1;
      else if (angle === 0 && paren === 0 && bracket === 0) {
        if (c === "{") return { end: j, sigEnd: j, opens: true };
        if (c === ";") return { end: j, sigEnd: j, opens: false };
        if (c === "=" && stopAtEq) {
          const after = skipValue(j + 1);
          return { end: after, sigEnd: j, opens: false };
        }
      }
    }
    return { end: n, sigEnd: n, opens: false };
  }

  function skipValue(at: number): number {
    let angle = 0;
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    for (let j = at; j < n; j += 1) {
      const c = code[j]!;
      if (c === "<") angle += 1;
      else if (c === ">" && angle > 0) angle -= 1;
      else if (c === "(") paren += 1;
      else if (c === ")") paren -= 1;
      else if (c === "[") bracket += 1;
      else if (c === "]") bracket -= 1;
      else if (c === "{") brace += 1;
      else if (c === "}") {
        if (brace === 0) return j;
        brace -= 1;
      } else if (c === ";" && angle === 0 && paren === 0 && bracket === 0 && brace === 0) return j;
    }
    return n;
  }

  function firstDoc(at: number): string {
    let line = source.lastIndexOf("\n", at - 1) + 1;
    const docs: string[] = [];
    while (line > 0) {
      const prev = source.lastIndexOf("\n", line - 2) + 1;
      const text = source.slice(prev, line - 1);
      if (/^\s*#\[/.test(text) || text.trim() === "") {
        line = prev;
        continue;
      }
      const doc = /^\s*\/\/\/\s?(.*)$/.exec(text);
      if (!doc) break;
      docs.unshift(doc[1]!.trim());
      line = prev;
    }
    return (docs.find((row) => row !== "") ?? "").replace(/\s+/g, " ").trim();
  }

  function collapse(from: number, to: number): string {
    return source.slice(from, to).replace(/\s+/g, " ").trim();
  }

  function implType(header: string): { ty: string; inherent: boolean } {
    const flat = header.replace(/\s+/g, " ");
    const forM = /\bfor\s+((?:[A-Za-z_][\w]*::)*[A-Za-z_][\w]*)/.exec(flat);
    if (forM) return { ty: forM[1]!.split("::").pop()!, inherent: false };
    const m = /\bimpl(?:\s*<[^>]*>)?\s+((?:[A-Za-z_][\w]*::)*[A-Za-z_][\w]*)/.exec(flat);
    return { ty: m?.[1]?.split("::").pop() ?? "", inherent: true };
  }

  while (i < n) {
    i = skipWs(i);
    if (i >= n) break;
    if (code.startsWith("#[", i) || code.startsWith("#![", i)) {
      i = skipAttr(i);
      continue;
    }
    if (code[i] === "}") {
      if (stack.length > 1) stack.pop();
      i += 1;
      continue;
    }
    let cursor = i;
    let isPub = false;
    if (code.startsWith("pub", cursor) && (cursor + 3 >= n || !/[A-Za-z0-9_]/.test(code[cursor + 3]!))) {
      cursor += 3;
      if (code[cursor] === "(") {
        const close = code.indexOf(")", cursor);
        cursor = close < 0 ? n : close + 1;
        isPub = false;
      } else isPub = true;
      cursor = skipWs(cursor);
    }
    const ident = readIdent(cursor);
    if (!KEYWORDS.has(ident.text)) {
      if (code[i] === "{") {
        stack.push({ kind: "other", pub: false, name: "", inherent: false });
        i += 1;
        continue;
      }
      i = ident.end > i ? ident.end : i + 1;
      continue;
    }
    const keyword = ident.text;
    if (keyword === "use") {
      i = skipValue(cursor) + 1;
      continue;
    }
    if (keyword === "mod") {
      const name = readIdent(skipWs(ident.end));
      const after = skipWs(name.end);
      if (code[after] === "{") {
        stack.push({ kind: "mod", pub: isPub, name: name.text, inherent: false });
        i = after + 1;
      } else i = headerEnd(cursor, false).end + 1;
      continue;
    }
    if (keyword === "impl") {
      const end = headerEnd(cursor, false);
      if (end.opens) {
        const parsed = implType(collapse(cursor, end.sigEnd));
        stack.push({ kind: "impl", pub: true, name: parsed.ty, inherent: parsed.inherent });
        i = end.end + 1;
      } else i = end.end + 1;
      continue;
    }
    const end = headerEnd(cursor, keyword === "const" || keyword === "static");
    const impl = implOf();
    const named = readIdent(skipWs(ident.end));
    const record = isPub && modulePublic() && !insideFn() && stack.every((b) => b.kind !== "other") && !(impl && !impl.inherent);
    if (record && named.text) {
      const qual = keyword === "fn" && impl?.inherent ? `${impl.name}::${named.text}` : named.text;
      let signature = collapse(cursor, end.sigEnd);
      if (keyword === "fn" && impl?.inherent) signature = signature.replace(new RegExp(`\\bfn\\s+${named.text}\\b`), `fn ${impl.name}::${named.text}`);
      items.push({ module: moduleName(), kind: keyword as RecipeApiItem["kind"], rawName: named.text, name: qual, signature, doc: firstDoc(i) });
    }
    if (end.opens) {
      stack.push({ kind: keyword === "fn" ? "fn" : "other", pub: false, name: "", inherent: false });
      i = end.end + 1;
    } else i = end.end + 1;
  }
  return items;
}

/** The `api` section: a header the section splitter recognises, then one line per public item, by module. */
export function recipeApiSection(source = recipeCrateSource()): string {
  const items = recipeApiItems(source);
  const lines = ["The API (crate lime_recipe), generated from its source. Every public type and function, with its signature and the first line of its doc comment."];
  let module = "";
  for (const item of items) {
    if (item.module !== module) {
      module = item.module;
      lines.push("", module);
    }
    lines.push(`${item.signature}${item.doc ? ` — ${item.doc}` : ""}`);
  }
  return lines.join("\n");
}
