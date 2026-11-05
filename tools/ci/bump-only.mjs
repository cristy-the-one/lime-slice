// Decide whether a diff is a version bump and nothing else, for the CI fast lane.
//
//   node tools/ci/bump-only.mjs BASE HEAD     prints "true" or "false" (reason on stderr), exit 0
//   node tools/ci/bump-only.mjs --check [REV] checks that every version at REV (default HEAD) agrees; exit 1 if not
//
// Strict on purpose: any doubt answers false and the full CI runs. The functions are pure, so the unit test feeds
// them diff text and file contents. Only the CLI at the bottom touches git.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const VERSION_RE = new RegExp(`^${SEMVER}$`);

// Files whose version lines a bump may change. Markdown elsewhere and docs/ are not code, so they are ignored.
const BUMP_FILES = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "Cargo.toml",
  "Cargo.lock",
  "README.md",
];

export function isIgnoredDoc(path) {
  return path !== "README.md" && (path.startsWith("docs/") || path.endsWith(".md"));
}

const lines = (text) => text.replace(/\r/g, "").split("\n");

// Parse `git diff -U0 --no-renames` text into [{ path, hunks: [{ oldStart, newStart, removed, added }], bad }].
export function parseDiff(diffText) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const raw of diffText.replace(/\r/g, "").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      file = { path: m && m[1] === m[2] ? m[2] : (m ? m[2] : raw), hunks: [], bad: m && m[1] === m[2] ? null : "odd path" };
      files.push(file);
      hunk = null;
    } else if (!file) {
      continue;
    } else if (hunk === null && /^(old mode|new mode|new file mode|deleted file mode|rename |copy |similarity |Binary files|GIT binary patch)/.test(raw)) {
      file.bad = raw;
    } else if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (!m) {
        file.bad = raw;
        continue;
      }
      // With -U0 a count of 0 means the start is the line before; keep it, a pure add/remove fails the pairing below.
      hunk = { oldStart: Number(m[1]), newStart: Number(m[3]), removed: [], added: [] };
      file.hunks.push(hunk);
    } else if (hunk && raw.startsWith("-")) {
      hunk.removed.push(raw.slice(1));
    } else if (hunk && raw.startsWith("+")) {
      hunk.added.push(raw.slice(1));
    }
  }
  return files;
}

// The line's role in a file: "root" (app version of package.json, tauri.conf.json, package-lock root, the
// workspace version) or a workspace crate name for Cargo.lock; null when the line is any other line.
function versionLineRole(path, content, lineNo, workspaceNames) {
  const ls = lines(content);
  const line = ls[lineNo - 1];
  if (line === undefined) return null;
  const idx = lineNo - 1;
  if (path === "package.json" || path === "src-tauri/tauri.conf.json") {
    return new RegExp(`^  "version": "${SEMVER}",?$`).test(line) ? "root" : null;
  }
  if (path === "package-lock.json") {
    if (new RegExp(`^  "version": "${SEMVER}",?$`).test(line)) return "root";
    if (new RegExp(`^      "version": "${SEMVER}",?$`).test(line)) {
      // The first "version" after `    "": {` in `packages`.
      const open = ls.findIndex((l) => l === '    "": {');
      if (open < 0) return null;
      for (let i = open + 1; i < ls.length; i++) {
        if (/^      "version": /.test(ls[i])) return i === idx ? "root" : null;
        if (/^    \}/.test(ls[i])) return null;
      }
    }
    return null;
  }
  if (path === "Cargo.toml") {
    if (!new RegExp(`^version = "${SEMVER}"$`).test(line)) return null;
    for (let i = idx - 1; i >= 0; i--) {
      if (/^\[.*\]\s*$/.test(ls[i])) return ls[i].trim() === "[workspace.package]" ? "root" : null;
    }
    return null;
  }
  if (path === "Cargo.lock") {
    if (!new RegExp(`^version = "${SEMVER}"$`).test(line)) return null;
    let name = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (ls[i] === "[[package]]") break;
      const m = /^name = "(.+)"$/.exec(ls[i]);
      if (m) name = m[1];
    }
    // A package from a registry has a `source` line; workspace crates have none.
    if (name === null || !workspaceNames.includes(name)) return null;
    for (let i = idx + 1; i < ls.length && ls[i] !== "" && ls[i] !== "[[package]]"; i++) {
      if (ls[i].startsWith("source")) return null;
    }
    return name;
  }
  return null;
}

const versionOf = (line) => new RegExp(String.raw`version"?\s*[=:]\s*"(${SEMVER})"`).exec(line)?.[1];

// Replace each whole-token occurrence of `from` with `to`.
function swapVersion(text, from, to) {
  const re = new RegExp(`(?<![\\d.])${from.replace(/\./g, "\\.")}(?!\\d|\\.\\d)`, "g");
  return text.replace(re, to);
}

const normaliseThrough = (s) => s.replace(new RegExp(`through v${SEMVER}`, "g"), "through vV");

/**
 * @param {string} diffText git diff -U0 --no-renames BASE...HEAD
 * @param {{ read: (rev: "old" | "new", path: string) => string, workspaceNames: string[] }} ctx
 * @returns {{ bump: boolean, reason: string, from?: string, to?: string }}
 */
export function classifyDiff(diffText, ctx) {
  const files = parseDiff(diffText);
  let from = null;
  let to = null;
  let versionLines = 0;
  for (const f of files) {
    if (isIgnoredDoc(f.path)) continue; // added, deleted or edited: none of it is code
    if (f.bad) return no(`${f.path}: ${f.bad}`);
    if (f.path === "README.md") continue; // checked below, once the version pair is known
    if (!BUMP_FILES.includes(f.path)) return no(`${f.path} is not a version file`);
    const oldContent = ctx.read("old", f.path);
    const newContent = ctx.read("new", f.path);
    for (const h of f.hunks) {
      if (h.removed.length !== h.added.length || h.removed.length === 0) return no(`${f.path}: lines added or removed`);
      for (let i = 0; i < h.removed.length; i++) {
        const oldLine = h.removed[i];
        const newLine = h.added[i];
        const oldRole = versionLineRole(f.path, oldContent, h.oldStart + i, ctx.workspaceNames);
        const newRole = versionLineRole(f.path, newContent, h.newStart + i, ctx.workspaceNames);
        if (oldRole === null || oldRole !== newRole) return no(`${f.path}:${h.newStart + i} is not an app version line`);
        const a = versionOf(oldLine);
        const b = versionOf(newLine);
        if (!a || !b || !VERSION_RE.test(a) || !VERSION_RE.test(b) || a === b) return no(`${f.path}:${h.newStart + i} bad version pair`);
        if (swapVersion(oldLine, a, b) !== newLine) return no(`${f.path}:${h.newStart + i} changes more than the version`);
        if (from === null) {
          from = a;
          to = b;
        } else if (from !== a || to !== b) {
          return no(`${f.path}:${h.newStart + i} is ${a} to ${b}, not ${from} to ${to}`);
        }
        versionLines += 1;
      }
    }
  }
  if (versionLines === 0) return no("no version line changed");
  // README.md: any line may change, but only by the version (and the "Draft releases through vA" number).
  const readme = files.find((f) => f.path === "README.md");
  if (readme) {
    for (const h of readme.hunks) {
      if (h.removed.length !== h.added.length) return no("README.md: lines added or removed");
      for (let i = 0; i < h.removed.length; i++) {
        if (swapVersion(normaliseThrough(h.removed[i]), from, to) !== normaliseThrough(h.added[i])) {
          return no(`README.md:${h.newStart + i} changes more than the version`);
        }
      }
    }
  }
  const problems = checkConsistency(headFiles(ctx), to);
  if (problems.length) return no(`HEAD versions disagree: ${problems.join("; ")}`);
  return { bump: true, reason: `version bump ${from} to ${to}`, from, to };
}

function no(reason) {
  return { bump: false, reason };
}

function headFiles(ctx) {
  const read = (p) => ctx.read("new", p);
  return {
    packageJson: read("package.json"),
    packageLock: read("package-lock.json"),
    tauriConf: read("src-tauri/tauri.conf.json"),
    cargoToml: read("Cargo.toml"),
    cargoLock: read("Cargo.lock"),
    workspaceNames: ctx.workspaceNames,
  };
}

/**
 * Every app version agrees: package.json = package-lock root = packages[""] = tauri.conf = [workspace.package]
 * = every workspace crate in Cargo.lock. Returns a list of problems (empty when they agree).
 * `expected` is optional; when given, they must all equal it.
 */
export function checkConsistency(f, expected) {
  const found = [];
  const add = (where, v) => found.push([where, v]);
  try {
    add("package.json", JSON.parse(f.packageJson).version);
  } catch {
    return ["package.json does not parse"];
  }
  try {
    const lock = JSON.parse(f.packageLock);
    add("package-lock.json root", lock.version);
    add('package-lock.json packages[""]', lock.packages?.[""]?.version);
  } catch {
    return ["package-lock.json does not parse"];
  }
  try {
    add("tauri.conf.json", JSON.parse(f.tauriConf).version);
  } catch {
    return ["tauri.conf.json does not parse"];
  }
  const ws = /\[workspace\.package\][^[]*?^version = "([^"]+)"/ms.exec(f.cargoToml);
  add("Cargo.toml [workspace.package]", ws?.[1]);
  const seen = new Set();
  for (const block of f.cargoLock.replace(/\r/g, "").split("[[package]]").slice(1)) {
    const name = /^name = "(.+)"$/m.exec(block)?.[1];
    if (!name || !f.workspaceNames.includes(name)) continue;
    seen.add(name);
    add(`Cargo.lock ${name}`, /^version = "(.+)"$/m.exec(block)?.[1]);
  }
  const problems = [];
  for (const n of f.workspaceNames) if (!seen.has(n)) problems.push(`Cargo.lock has no ${n}`);
  const want = expected ?? found[0][1];
  for (const [where, v] of found) {
    if (!v || !VERSION_RE.test(v)) problems.push(`${where} has no version`);
    else if (v !== want) problems.push(`${where} is ${v}, expected ${want}`);
  }
  return problems;
}

// Workspace crate names: the `name` of each member's Cargo.toml listed in the root Cargo.toml.
export function workspaceMembers(cargoToml) {
  const m = /^members\s*=\s*\[([^\]]*)\]/ms.exec(cargoToml);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

export function packageName(manifest) {
  return /^\[package\][^[]*?^name = "([^"]+)"/ms.exec(manifest)?.[1];
}

// ---- CLI -------------------------------------------------------------------------------------------------------

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function namesAt(show) {
  const members = workspaceMembers(show("Cargo.toml"));
  return members.map((dir) => packageName(show(`${dir}/Cargo.toml`)) ?? "");
}

function main(argv) {
  if (argv[0] === "--check") {
    const rev = argv[1] ?? "HEAD";
    const show = (p) => git("show", `${rev}:${p}`);
    const problems = checkConsistency(
      {
        packageJson: show("package.json"),
        packageLock: show("package-lock.json"),
        tauriConf: show("src-tauri/tauri.conf.json"),
        cargoToml: show("Cargo.toml"),
        cargoLock: show("Cargo.lock"),
        workspaceNames: namesAt(show),
      },
      undefined,
    );
    if (problems.length) {
      for (const p of problems) console.error(`::error::${p}`);
      return 1;
    }
    console.log(`all versions agree at ${rev}`);
    return 0;
  }
  const [base, head] = argv;
  if (!base || !head) {
    console.error("usage: bump-only.mjs BASE HEAD | --check [REV]");
    return 2;
  }
  let result;
  try {
    const mergeBase = git("merge-base", base, head).trim();
    const diff = git("diff", "-U0", "--no-color", "--no-renames", `${base}...${head}`);
    const show = (rev) => (p) => git("show", `${rev}:${p}`);
    const read = (which, p) => {
      try {
        return show(which === "old" ? mergeBase : head)(p);
      } catch {
        return "";
      }
    };
    result = classifyDiff(diff, { read, workspaceNames: namesAt(show(head)) });
  } catch (e) {
    result = no(`error: ${e.message}`);
  }
  console.error(`bump-only: ${result.reason}`);
  console.log(result.bump ? "true" : "false");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
