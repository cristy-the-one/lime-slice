/**
 * M6: the lime-slice skill over io.modelcontextprotocol/skills (SEP-2640).
 * A checkout reads mcp/skills/. The installer bundle reads skills/ beside server.mjs.
 * LIME_MCP_SKILLS points a server at another folder, so a bad skill can be tested
 * without shipping one.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = fileURLToPath(new URL("./server.ts", import.meta.url));
const skillFile = fileURLToPath(new URL("./skills/lime-slice/SKILL.md", import.meta.url));
const SKILLS = "io.modelcontextprotocol/skills";
const TASKS = "io.modelcontextprotocol/tasks";
const LIST_TTL_MS = 86_400_000;

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

function digestOf(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The file's own frontmatter, read here and not through the server. Flat key: value lines only. */
function frontmatterOf(bytes: Buffer): Record<string, string> | null {
  const lines = bytes.toString("utf8").split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fields;
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.LIME_MCP_FAKE = "1";
  env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-skills-"));
  return { ...env, ...extra };
}

function startRaw(args: string[], extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: childEnv(extra),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let buf = "";
  const pending: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else pending.push(line);
      nl = buf.indexOf("\n");
    }
  });
  let nextId = 1;
  const next = (ms = 20000) => new Promise<string>((resolve, reject) => {
    const queued = pending.shift();
    if (queued !== undefined) {
      resolve(queued);
      return;
    }
    const timer = setTimeout(() => reject(new Error(`no line within ${ms} ms\n${stderr}`)), ms);
    waiters.push((line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
  return {
    child,
    stderr: () => stderr,
    id: () => nextId++,
    send(text: string) {
      child.stdin.write(text);
    },
    next,
  };
}

type Raw = ReturnType<typeof startRaw>;

interface SkillResource {
  uri?: string;
  digest?: string;
  size?: number;
}

interface SkillEntry {
  uri?: string;
  frontmatter?: Record<string, unknown>;
  resources?: SkillResource[];
}

interface Extensions {
  [name: string]: { directoryRead?: boolean } | undefined;
}

interface Row {
  id?: number | null;
  result?: {
    resultType?: string;
    ttlMs?: number;
    cacheScope?: string;
    nextCursor?: string;
    instructions?: string;
    capabilities?: { resources?: unknown; tools?: { listChanged?: boolean }; extensions?: Extensions };
    tools?: { name: string }[];
    resources?: { uri?: string }[];
    skills?: SkillEntry[];
    skill?: SkillEntry;
    contents?: { uri?: string; mimeType?: string; text?: string; blob?: string }[];
  };
  error?: { code?: number; message?: string };
}

function rpc(id: number, method: string, params?: Record<string, unknown>): string {
  const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params) message.params = params;
  return `${JSON.stringify(message)}\n`;
}

function modern(params: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...params,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "skills-test", version: "0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
}

async function call(io: Raw, method: string, params?: Record<string, unknown>): Promise<Row> {
  const id = io.id();
  io.send(rpc(id, method, params));
  for (;;) {
    const row = JSON.parse(await io.next()) as Row;
    if (row.id === id) return row;
  }
}

function extensionOf(row: Row): { directoryRead?: boolean } | undefined {
  return row.result?.capabilities?.extensions?.[SKILLS];
}

const sourceArgs = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", server];
const real = startRaw(sourceArgs);
try {
  const init = await call(real, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "skills-test", version: "0" },
  });
  check(
    "initialize on 2025-11-25 declares io.modelcontextprotocol/skills as {}",
    JSON.stringify(extensionOf(init)) === "{}" && init.result?.capabilities?.resources !== undefined,
    JSON.stringify(init.result?.capabilities ?? init.error),
  );
  check(
    "directoryRead stays off",
    JSON.stringify(extensionOf(init)) === "{}" && extensionOf(init)?.directoryRead !== true,
    JSON.stringify(extensionOf(init)),
  );

  const older = await call(real, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "skills-test", version: "0" },
  });
  check(
    "initialize on 2024-11-05 declares the skills extension",
    JSON.stringify(extensionOf(older)) === "{}",
    JSON.stringify(older.result?.capabilities?.extensions ?? older.error),
  );

  const discovered = await call(real, "server/discover", modern());
  check(
    "server/discover on 2026-07-28 declares the skills extension and keeps tasks",
    JSON.stringify(extensionOf(discovered)) === "{}" && JSON.stringify(discovered.result?.capabilities?.extensions?.[TASKS]) === "{}",
    JSON.stringify(discovered.result?.capabilities?.extensions ?? discovered.error),
  );

  const listed = await call(real, "skills/list");
  const entry = listed.result?.skills?.find((skill) => skill.uri === "skill://lime-slice/SKILL.md");
  check(
    "skills/list returns the lime-slice skill",
    listed.error === undefined && listed.result?.resultType === "complete" && listed.result.skills?.length === 1 && entry?.uri === "skill://lime-slice/SKILL.md",
    JSON.stringify(listed.error ?? listed.result).slice(0, 500),
  );
  const fileBytes = readFileSync(skillFile);
  const skillRoot = fileURLToPath(new URL("./skills/lime-slice", import.meta.url));
  const fileFrontmatter = frontmatterOf(fileBytes);
  check(
    "the frontmatter matches the file",
    fileFrontmatter !== null && JSON.stringify(entry?.frontmatter) === JSON.stringify(fileFrontmatter),
    JSON.stringify({ served: entry?.frontmatter, file: fileFrontmatter }),
  );
  const lastSegment = entry?.uri?.slice("skill://".length).split("/").slice(0, -1).at(-1);
  check(
    "the URI's last skill-path segment equals the frontmatter name",
    lastSegment !== undefined && lastSegment === entry?.frontmatter?.name,
    JSON.stringify({ uri: entry?.uri, name: entry?.frontmatter?.name }),
  );
  check(
    "each digest and size match the file",
    (entry?.resources ?? []).length > 0 && (entry?.resources ?? []).every((resource) => {
      if (typeof resource.uri !== "string" || !resource.uri.startsWith("skill://lime-slice/")) return false;
      const rel = resource.uri.slice("skill://lime-slice/".length);
      if (rel === "" || rel.includes("..") || resource.digest === undefined) return false;
      const bytes = readFileSync(join(skillRoot, rel));
      return resource.digest === digestOf(bytes) && resource.size === bytes.length && /^sha256:[0-9a-f]{64}$/.test(resource.digest);
    }),
    JSON.stringify(entry?.resources),
  );

  const got = await call(real, "skills/get", modern({ uri: "skill://lime-slice/SKILL.md" }));
  check(
    "skills/get returns the same entry as skills/list, with ttlMs, cacheScope, and no nextCursor",
    got.error === undefined
      && got.result?.resultType === "complete"
      && got.result.ttlMs === LIST_TTL_MS
      && got.result.cacheScope === "public"
      && got.result.nextCursor === undefined
      && JSON.stringify(got.result.skill) === JSON.stringify(entry),
    JSON.stringify(got.error ?? {
      resultType: got.result?.resultType,
      ttlMs: got.result?.ttlMs,
      cacheScope: got.result?.cacheScope,
      nextCursor: got.result?.nextCursor,
      skill: got.result?.skill,
    }).slice(0, 400),
  );

  const modernList = await call(real, "skills/list", modern());
  check(
    "a 2026-07-28 skills/list carries ttlMs and cacheScope, like tools/list",
    modernList.result?.resultType === "complete" && modernList.result.ttlMs === LIST_TTL_MS && modernList.result.cacheScope === "public"
      && JSON.stringify(modernList.result.skills) === JSON.stringify(listed.result?.skills),
    JSON.stringify({ resultType: modernList.result?.resultType, ttlMs: modernList.result?.ttlMs, cacheScope: modernList.result?.cacheScope, error: modernList.error }),
  );

  const badCursor = await call(real, "skills/list", modern({ cursor: "not-a-cursor" }));
  check(
    "skills/list rejects an unknown pagination cursor with -32602",
    badCursor.error?.code === -32602 && badCursor.result === undefined,
    JSON.stringify(badCursor.error ?? badCursor.result),
  );

  const dirRead = await call(real, "resources/directory/read", modern({ uri: "skill://lime-slice" }));
  check(
    "resources/directory/read returns -32601 when directoryRead is not declared",
    dirRead.error?.code === -32601 && dirRead.result === undefined,
    JSON.stringify(dirRead.error ?? dirRead.result),
  );

  const unknown = await call(real, "skills/get", { uri: "skill://no-such/SKILL.md" });
  check(
    "an unknown skill URI is -32602",
    unknown.error?.code === -32602 && unknown.result === undefined,
    JSON.stringify(unknown.error ?? unknown.result),
  );

  const read = await call(real, "resources/read", { uri: "skill://lime-slice/SKILL.md" });
  const servedText = read.result?.contents?.[0]?.text ?? "";
  const servedBytes = Buffer.from(servedText, "utf8");
  check(
    "resources/read serves the skill as text/markdown, the same bytes the digest used",
    read.error === undefined
      && read.result?.contents?.[0]?.mimeType === "text/markdown"
      && read.result.contents[0]?.uri === "skill://lime-slice/SKILL.md"
      && servedBytes.equals(fileBytes)
      && digestOf(servedBytes) === entry?.resources?.[0]?.digest,
    JSON.stringify({ error: read.error, mimeType: read.result?.contents?.[0]?.mimeType, served: servedBytes.length, file: fileBytes.length }),
  );

  const missingFile = await call(real, "resources/read", { uri: "skill://lime-slice/missing.md" });
  check(
    "an unknown skill file is -32602",
    missingFile.error?.code === -32602,
    JSON.stringify(missingFile.error ?? missingFile.result),
  );

  const resources = await call(real, "resources/list");
  const resourceUris = (resources.result?.resources ?? []).map((row) => row.uri);
  check(
    "resources/list does not name the skill",
    resources.error === undefined && resourceUris.every((uri) => !String(uri).startsWith("skill://")),
    resourceUris.filter((uri) => String(uri).startsWith("skill://")).join(","),
  );

  const tools = await call(real, "tools/list", modern());
  const toolNames = (tools.result?.tools ?? []).map((tool) => tool.name).sort();
  check(
    "the default tools/list and instructions do not carry the skill",
    JSON.stringify(toolNames) === JSON.stringify(["call", "guide", "plan_run", "session_info"])
      && !(init.result?.instructions ?? "").includes("skill://")
      && !(init.result?.instructions ?? "").includes("SKILL.md")
      && !(discovered.result?.instructions ?? "").includes("skill://"),
    JSON.stringify({ tools: toolNames, instructions: init.result?.instructions?.slice(0, 120) }),
  );
} finally {
  real.child.kill();
}

const scratch = mkdtempSync(join(tmpdir(), "lime-mcp-skills-dir-"));
const crlfBody = Buffer.from("---\r\nname: line-endings\r\ndescription: Digests the bytes on disk.\r\n---\r\n\r\n# Body\r\n", "utf8");
mkdirSync(join(scratch, "line-endings"), { recursive: true });
mkdirSync(join(scratch, "wrong-name"), { recursive: true });
mkdirSync(join(scratch, "no-description"), { recursive: true });
writeFileSync(join(scratch, "line-endings", "SKILL.md"), crlfBody);
writeFileSync(join(scratch, "line-endings", "notes.md"), Buffer.from("a note\n", "utf8"));
writeFileSync(join(scratch, "wrong-name", "SKILL.md"), "---\nname: not-wrong-name\ndescription: The name is not the directory.\n---\n\n# No\n");
writeFileSync(join(scratch, "no-description", "SKILL.md"), "---\nname: no-description\n---\n\n# No\n");
const filtered = startRaw(sourceArgs, { LIME_MCP_SKILLS: scratch });
try {
  const listed = await call(filtered, "skills/list", modern());
  const uris = (listed.result?.skills ?? []).map((skill) => skill.uri);
  const kept = listed.result?.skills?.find((skill) => skill.uri === "skill://line-endings/SKILL.md");
  check(
    "a skill whose name matches its path is listed",
    listed.error === undefined && uris.length === 1 && kept?.frontmatter?.name === "line-endings",
    JSON.stringify(listed.error ?? uris),
  );
  check(
    "a bad name/path pair is not listed",
    listed.error === undefined && !uris.some((uri) => String(uri).includes("wrong-name")) && !(listed.result?.skills ?? []).some((skill) => skill.frontmatter?.name === "not-wrong-name"),
    JSON.stringify(uris),
  );
  check(
    "a skill with no description is not listed",
    listed.error === undefined && !uris.some((uri) => String(uri).includes("no-description")),
    JSON.stringify(uris),
  );
  const byUri = new Map((kept?.resources ?? []).map((resource) => [resource.uri, resource]));
  const noteBytes = readFileSync(join(scratch, "line-endings", "notes.md"));
  const skillResource = byUri.get("skill://line-endings/SKILL.md");
  const noteResource = byUri.get("skill://line-endings/notes.md");
  check(
    "a CRLF skill's digest and size are the raw bytes, and so is the other file",
    skillResource?.digest === digestOf(crlfBody) && skillResource.size === crlfBody.length
      && noteResource?.digest === digestOf(noteBytes) && noteResource.size === noteBytes.length,
    JSON.stringify({ skill: skillResource, note: noteResource, wantSkill: digestOf(crlfBody), wantNote: digestOf(noteBytes) }),
  );
  const read = await call(filtered, "resources/read", { uri: "skill://line-endings/SKILL.md" });
  const served = Buffer.from(read.result?.contents?.[0]?.text ?? "", "utf8");
  check(
    "resources/read serves those same CRLF bytes",
    read.result?.contents?.[0]?.mimeType === "text/markdown" && served.equals(crlfBody) && served.includes(Buffer.from("\r\n")),
    JSON.stringify({ mimeType: read.result?.contents?.[0]?.mimeType, crlf: served.includes("\r\n"), length: served.length }),
  );
  const hidden = await call(filtered, "skills/get", { uri: "skill://wrong-name/SKILL.md" });
  check(
    "a bad name/path pair is not served by skills/get",
    hidden.error?.code === -32602,
    JSON.stringify(hidden.error ?? hidden.result),
  );
} finally {
  filtered.child.kill();
  rmSync(scratch, { recursive: true, force: true });
}

const conformScratch = mkdtempSync(join(tmpdir(), "lime-mcp-skills-conform-"));
// 1. Flat frontmatter behind a byte-order mark, with a comment line and a blank line.
mkdirSync(join(conformScratch, "acme", "billing", "refunds", "scripts"), { recursive: true });
mkdirSync(join(conformScratch, "acme", "billing", "refunds", "assets"), { recursive: true });
const richSkillBytes = Buffer.from(
  "\uFEFF---\n"
  + "# Leading YAML comment\n"
  + "name: refunds\n"
  + "\n"
  + "description: Process customer refund requests per company policy.\n"
  + "license: Apache-2.0\n"
  + "compatibility: Requires Python 3.12+\n"
  + "---\n\n"
  + "# Refunds\n",
  "utf8",
);
// Frontmatter a YAML reader would not read as flat `key: value` text. Each is skipped, not served misread.
const notFlat: [string, string][] = [
  ["block-scalar", "---\nname: block-scalar\ndescription: >-\n  Folded over\n  two lines.\n---\n"],
  ["quoted", "---\nname: quoted\ndescription: \"Quoted.\"\n---\n"],
  ["nested-map", "---\nname: nested-map\ndescription: Has a map.\nmetadata:\n  author: acme\n---\n"],
  ["a-list", "---\nname: a-list\ndescription: Has a list.\ntags:\n  - one\n---\n"],
  ["flow-list", "---\nname: flow-list\ndescription: Has a flow list.\ntags: [one, two]\n---\n"],
  ["trailing-comment", "---\nname: trailing-comment\ndescription: Ends in a comment. # here\n---\n"],
  ["dots-closer", "---\nname: dots-closer\ndescription: Closed by dots.\n...\n"],
];
for (const [dirName, body] of notFlat) {
  mkdirSync(join(conformScratch, dirName), { recursive: true });
  writeFileSync(join(conformScratch, dirName, "SKILL.md"), body);
}
const pyScriptBytes = Buffer.from("print('ok')\n", "utf8");
const jsonAssetBytes = Buffer.from('{"ok":true}\n', "utf8");
// Valid PNG header + non-UTF-8 binary bytes (0x89, 0x00, 0xff) that UTF-8 decoding would corrupt.
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
writeFileSync(join(conformScratch, "acme", "billing", "refunds", "SKILL.md"), richSkillBytes);
writeFileSync(join(conformScratch, "acme", "billing", "refunds", "scripts", "extract.py"), pyScriptBytes);
writeFileSync(join(conformScratch, "acme", "billing", "refunds", "assets", "policy.json"), jsonAssetBytes);
writeFileSync(join(conformScratch, "acme", "billing", "refunds", "assets", "logo.png"), pngBytes);

// 2. Nested skills: outer encloses sub/inner; outer's manifest includes inner's files, and inner is published flat.
mkdirSync(join(conformScratch, "outer", "sub", "inner"), { recursive: true });
writeFileSync(join(conformScratch, "outer", "SKILL.md"), "---\nname: outer\ndescription: Enclosing skill.\n---\n\n# Outer\n");
writeFileSync(join(conformScratch, "outer", "sub", "inner", "SKILL.md"), "---\nname: inner\ndescription: Nested skill.\n---\n\n# Inner\n");

// 3. Invalid Agent Skills names & field limits (must be rejected).
const invalidSkills: [string, string][] = [
  ["UpperCase", "---\nname: UpperCase\ndescription: Uppercase is forbidden.\n---\n"],
  ["bad_under", "---\nname: bad_under\ndescription: Underscore is forbidden.\n---\n"],
  ["-leading", "---\nname: -leading\ndescription: Leading hyphen is forbidden.\n---\n"],
  ["trailing-", "---\nname: trailing-\ndescription: Trailing hyphen is forbidden.\n---\n"],
  ["double--dash", "---\nname: double--dash\ndescription: Consecutive hyphens are forbidden.\n---\n"],
  ["a".repeat(65), `---\nname: ${"a".repeat(65)}\ndescription: Name over 64 chars.\n---\n`],
  ["long-desc", `---\nname: long-desc\ndescription: ${"x".repeat(1025)}\n---\n`],
  ["long-compat", `---\nname: long-compat\ndescription: Valid.\ncompatibility: ${"y".repeat(501)}\n---\n`],
  ["dup-key", "---\nname: dup-key\ndescription: One.\ndescription: Two.\n---\n"],
];
for (const [dirName, body] of invalidSkills) {
  mkdirSync(join(conformScratch, dirName), { recursive: true });
  writeFileSync(join(conformScratch, dirName, "SKILL.md"), body);
}

// 4. Per-skill limits: >512 entries (513 files total) and >16 MiB total size.
mkdirSync(join(conformScratch, "too-many-files"), { recursive: true });
writeFileSync(join(conformScratch, "too-many-files", "SKILL.md"), "---\nname: too-many-files\ndescription: Exceeds 512 entries.\n---\n");
for (let i = 0; i < 512; i += 1) {
  writeFileSync(join(conformScratch, "too-many-files", `f${i}.txt`), "x");
}
mkdirSync(join(conformScratch, "too-big"), { recursive: true });
writeFileSync(join(conformScratch, "too-big", "SKILL.md"), "---\nname: too-big\ndescription: Exceeds 16 MiB.\n---\n");
writeFileSync(join(conformScratch, "too-big", "blob.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));

const conformServer = startRaw(sourceArgs, { LIME_MCP_SKILLS: conformScratch });
try {
  const listed = await call(conformServer, "skills/list", modern());
  const skills = listed.result?.skills ?? [];
  const uris = skills.map((s) => s.uri).sort();
  check(
    "only valid prefixed and nested skills are listed (invalid names, limits, and frontmatter that is not flat are excluded)",
    listed.error === undefined && JSON.stringify(uris) === JSON.stringify([
      "skill://acme/billing/refunds/SKILL.md",
      "skill://outer/SKILL.md",
      "skill://outer/sub/inner/SKILL.md",
    ]),
    JSON.stringify(listed.error ?? uris),
  );

  const refunds = skills.find((s) => s.uri === "skill://acme/billing/refunds/SKILL.md");
  const expectedFm = {
    name: "refunds",
    description: "Process customer refund requests per company policy.",
    license: "Apache-2.0",
    compatibility: "Requires Python 3.12+",
  };
  check(
    "flat frontmatter is read behind a byte-order mark, past a comment line and a blank line",
    JSON.stringify(refunds?.frontmatter) === JSON.stringify(expectedFm),
    JSON.stringify({ got: refunds?.frontmatter, want: expectedFm }),
  );

  const bomRead = await call(conformServer, "resources/read", modern({ uri: "skill://acme/billing/refunds/SKILL.md" }));
  const bomText = bomRead.result?.contents?.[0]?.text;
  const bomBytes = typeof bomText === "string" ? Buffer.from(bomText, "utf8") : Buffer.alloc(0);
  const bomManifest = refunds?.resources?.find((r) => r.uri === "skill://acme/billing/refunds/SKILL.md");
  check(
    "a text file that starts with a byte-order mark is served with it, so its text matches the digest and size",
    bomBytes.equals(richSkillBytes) && bomManifest?.digest === digestOf(bomBytes) && bomManifest.size === bomBytes.length,
    JSON.stringify({ served: bomBytes.length, file: richSkillBytes.length, manifest: bomManifest }),
  );

  const outer = skills.find((s) => s.uri === "skill://outer/SKILL.md");
  const inner = skills.find((s) => s.uri === "skill://outer/sub/inner/SKILL.md");
  const outerUris = (outer?.resources ?? []).map((r) => r.uri);
  const innerUris = (inner?.resources ?? []).map((r) => r.uri);
  check(
    "nested skill files are included in the enclosing skill's manifest and published flat as their own skill",
    outerUris[0] === "skill://outer/SKILL.md"
      && outerUris.includes("skill://outer/sub/inner/SKILL.md")
      && JSON.stringify(innerUris) === JSON.stringify(["skill://outer/sub/inner/SKILL.md"]),
    JSON.stringify({ outerUris, innerUris }),
  );

  const gotInner = await call(conformServer, "skills/get", modern({ uri: "skill://outer/sub/inner/SKILL.md" }));
  check(
    "skills/get retrieves a nested skill with cache attributes",
    gotInner.error === undefined
      && gotInner.result?.ttlMs === LIST_TTL_MS
      && gotInner.result.cacheScope === "public"
      && gotInner.result.skill?.uri === "skill://outer/sub/inner/SKILL.md",
    JSON.stringify(gotInner.error ?? gotInner.result),
  );

  const pyRead = await call(conformServer, "resources/read", modern({ uri: "skill://acme/billing/refunds/scripts/extract.py" }));
  const jsonRead = await call(conformServer, "resources/read", modern({ uri: "skill://acme/billing/refunds/assets/policy.json" }));
  const pngRead = await call(conformServer, "resources/read", modern({ uri: "skill://acme/billing/refunds/assets/logo.png" }));
  const pngItem = pngRead.result?.contents?.[0];
  const decodedPng = typeof pngItem?.blob === "string" ? Buffer.from(pngItem.blob, "base64") : Buffer.alloc(0);
  const pngManifest = refunds?.resources?.find((r) => r.uri === "skill://acme/billing/refunds/assets/logo.png");
  check(
    "supporting files use content-appropriate MIME types and binary files return base64 blob matching digest and size",
    pyRead.result?.contents?.[0]?.mimeType === "text/x-python"
      && pyRead.result.contents[0]?.text === pyScriptBytes.toString("utf8")
      && jsonRead.result?.contents?.[0]?.mimeType === "application/json"
      && jsonRead.result.contents[0]?.text === jsonAssetBytes.toString("utf8")
      && pngItem?.mimeType === "image/png"
      && pngItem.text === undefined
      && decodedPng.equals(pngBytes)
      && pngManifest?.digest === digestOf(decodedPng)
      && pngManifest.size === decodedPng.length,
    JSON.stringify({
      py: pyRead.result?.contents?.[0],
      json: jsonRead.result?.contents?.[0],
      png: pngItem,
      pngManifest,
    }),
  );
} finally {
  conformServer.child.kill();
  rmSync(conformScratch, { recursive: true, force: true });
}

const bundleDir = mkdtempSync(join(tmpdir(), "lime-mcp-skills-bundle-"));
const built = spawnSync(process.execPath, ["tools/mcp/bundle.mjs", bundleDir], { cwd: root, encoding: "utf8" });
const bundledSkill = join(bundleDir, "skills", "lime-slice", "SKILL.md");
check(
  "npm run build:mcp copies skills/lime-slice/SKILL.md beside server.mjs",
  built.status === 0 && existsSync(bundledSkill) && readFileSync(bundledSkill).equals(readFileSync(skillFile)),
  built.stderr || built.stdout,
);
if (existsSync(join(bundleDir, "server.mjs"))) {
  const bundled = startRaw([join(bundleDir, "server.mjs")]);
  try {
    const listed = await call(bundled, "skills/list", modern());
    const entry = listed.result?.skills?.find((skill) => skill.uri === "skill://lime-slice/SKILL.md");
    const bytes = existsSync(bundledSkill) ? readFileSync(bundledSkill) : Buffer.alloc(0);
    check(
      "a server started from the bundle serves the skill",
      listed.error === undefined && entry?.resources?.[0]?.digest === digestOf(bytes) && entry.resources[0]?.size === bytes.length,
      JSON.stringify(listed.error ?? entry ?? listed.result).slice(0, 500),
    );
    const read = await call(bundled, "resources/read", { uri: "skill://lime-slice/SKILL.md" });
    check(
      "the bundle server's resources/read is the bundled file",
      bytes.length > 0 && read.result?.contents?.[0]?.mimeType === "text/markdown" && Buffer.from(read.result.contents[0]?.text ?? "", "utf8").equals(bytes),
      JSON.stringify({ error: read.error, mimeType: read.result?.contents?.[0]?.mimeType, length: read.result?.contents?.[0]?.text?.length, file: bytes.length }),
    );
  } finally {
    bundled.child.kill();
  }
} else {
  check("a server started from the bundle serves the skill", false, "server.mjs was not built");
}
rmSync(bundleDir, { recursive: true, force: true });

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("skills: ok");
