/**
 * Repo check: no new markup sink takes text it did not escape. Every `innerHTML =` / `outerHTML =` under src/ whose
 * right side is not a plain literal (a quoted string, or a template with no `${…}`), and every `insertAdjacentHTML`,
 * must either go through `setHtml` / `insertHtml` (src/ui/html.ts) with an `html` template, or be a reviewed exception
 * in tools/html-sinks-allow.txt. A listed exception that no longer matches a sink fails too, so the list stays true.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const ALLOW = "tools/html-sinks-allow.txt";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `\n${detail}` : ""}`);
}

/** Where a sink's right side is not a literal: the line it starts on. */
export function sinkLines(source: string): number[] {
  const out: number[] = [];
  const lineAt = (index: number) => source.slice(0, index).split("\n").length;
  const assign = /\.(?:innerHTML|outerHTML)\s*=(?!=)/g;
  for (let m = assign.exec(source); m; m = assign.exec(source)) {
    let i = m.index + m[0].length;
    while (/\s/.test(source[i] ?? "")) i++;
    const quote = source[i];
    let literal = false;
    if (quote === '"' || quote === "'") literal = true;
    else if (quote === "`") {
      literal = true;
      for (let j = i + 1; j < source.length; j++) {
        if (source[j] === "\\") {
          j++;
          continue;
        }
        if (source[j] === "`") break;
        if (source[j] === "$" && source[j + 1] === "{") {
          literal = false;
          break;
        }
      }
    }
    if (!literal) out.push(lineAt(m.index));
  }
  const adjacent = /\.insertAdjacentHTML\s*\(/g;
  for (let m = adjacent.exec(source); m; m = adjacent.exec(source)) out.push(lineAt(m.index));
  return out;
}

// The scanner itself.
check("a quoted string is a literal", sinkLines(`el.innerHTML = "";`).length === 0);
check("a template without values is a literal", sinkLines("el.innerHTML = `\n  <b>x</b>`;").length === 0);
check("a template with a value is a sink", sinkLines("el.innerHTML = `<b>${name}</b>`;").length === 1);
check("a call is a sink", sinkLines("el.innerHTML = rows.join('');").length === 1);
check("a comparison is not an assignment", sinkLines("if (el.innerHTML === html) {}").length === 0);
check("insertAdjacentHTML is a sink", sinkLines("row.insertAdjacentHTML('beforeend', x);").length === 1);
check("an escaped backtick does not end the template", sinkLines("el.innerHTML = `a\\`${b}`;").length === 1);

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(path);
  }
}

const files: string[] = [];
walk(join(root, "src"), files);
const found = new Set<string>();
for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, "/");
  if (rel === "src/ui/html.ts") continue;
  const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  for (const line of sinkLines(source)) found.add(`${rel} :: ${lines[line - 1]!.trim()}`);
}

const allowed = new Set(
  readFileSync(join(root, ALLOW), "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")),
);

const unreviewed = [...found].filter((key) => !allowed.has(key));
check(
  "every markup sink escapes, or is a reviewed exception",
  unreviewed.length === 0,
  `Use setHtml(el, html\`…\`) from src/ui/html.ts, or after review add the line to ${ALLOW}:\n${unreviewed.join("\n")}`,
);
const stale = [...allowed].filter((key) => !found.has(key));
check(`every line of ${ALLOW} is still a sink`, stale.length === 0, `Remove these lines:\n${stale.join("\n")}`);

if (failed) throw new Error(`${failed} markup sink checks failed`);
console.log(`html sinks: ${found.size} reviewed exceptions, every other sink escapes`);
