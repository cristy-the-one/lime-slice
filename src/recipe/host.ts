/**
 * The recipe protocol v1 host (docs/plan-recipes.md, docs/plan-recipe-plugins.md D16), shared by the MCP server and
 * the app. It holds no process and no file: a build goes through a `RecipeCompile` (the MCP writes the slot and runs
 * lust; the app asks its Tauri runner), and a run through a `RecipeSpawn` (a Node child process, or the runner's
 * events). The rest is the same for both: lust's diagnostics and its `auto` fix rounds, the start line, one call per
 * line and one reply per line back, the limits, refusals, `done`, describe mode, notes and late parameters.
 *
 * Nothing here knows the plate. Rollback and commit belong to the caller, which sees every call.
 */

/**
 * The MCP tools a recipe may call (S4). Each goes to the function its tool uses. `log`, `data` (recipe data by name,
 * R-A) and `pick` (a face or outline parameter resolved on the part, API 1.2, `src/recipe/picks.ts`) are the host's own.
 */
export const RECIPE_TOOLS: ReadonlySet<string> = new Set([
  "solid_new", "model_describe", "faces_find", "edges_find", "surface_at", "model_probe", "model_apply", "model_apply_batch",
  "model_check", "model_history", "measure", "model_place", "object_place", "section", "log", "data", "pick", "text_outline",
]);

export interface RecipeLimits {
  /** Wall time for the run, kernel time included. */
  timeoutS: number;
  maxCalls: number;
  /** Longest line the recipe may write, in bytes. */
  maxLineBytes: number;
}

export const DEFAULT_LIMITS: RecipeLimits = { timeoutS: 30, maxCalls: 2000, maxLineBytes: 1 << 20 };

/** One lust diagnostic, as `lust build --json` writes it, with the span's line in the recipe. */
export interface RecipeDiagnostic {
  code: string;
  message: string;
  line: number;
  col: number;
  fix: string;
  /** Byte edits in the recipe source; `auto` ones are safe to apply without review. */
  edits: { start: number; end: number; replacement: string; auto: boolean }[];
  /** True when the diagnostic is in lime-recipe, not the recipe. */
  inCrate?: boolean;
}

export interface BuildResult {
  ok: boolean;
  diagnostics: RecipeDiagnostic[];
  /** The source that was built: the input with every applied `auto` edit. */
  source: string;
  /** How many rounds of `auto` edits were applied. */
  fixRounds: number;
  exe?: string;
  ms: number;
  reason?: string;
}

/** A call the recipe made, as the caller sees it. */
export interface RecipeCallSite {
  id: number;
  tool: string;
  args: Record<string, unknown>;
  line: number;
}

/**
 * The caller's answer: the tool's result, or a refusal sentence (with any hint fields to pass on). `halt` ends the run
 * after this call without a failure (a partial dry run's step limit, I23): the recipe gets no reply and is stopped.
 */
export type RecipeReply = { ok: true; result: unknown; halt?: string } | { ok: false; error: string; extra?: Record<string, unknown> };

export type RecipeCall = (call: RecipeCallSite) => Promise<RecipeReply>;

export interface RunOutcome {
  ok: boolean;
  /** `done` was reached: the object the recipe named and its metrics. */
  done?: { object: string; metrics: Record<string, unknown> };
  calls: number;
  /** The refused calls, with the recipe line of each. */
  refused: { id: number; tool: string; line: number; reason: string }[];
  /** Why the run failed, when it did. */
  reason?: string;
  /** The recipe line the failure points at: a panic's, or the last refused call's. */
  line?: number;
  /** The caller halted the run after a call (RecipeReply.halt): why, and that call's id and recipe line. */
  halted?: { reason: string; id: number; line: number };
  exitCode?: number | null;
  stderr: string;
  ms: number;
  /** The recipe's own notes that are not calls: a value held inside its range, say (lime-recipe 1.1). */
  notes?: string[];
  /** Parameters declared after the first call, with their lines: a form drawn before the run could not show them. */
  lateParams?: { name: string; line: number }[];
  /**
   * Describe mode (`start.describe`): the parameters in declared order, whether the recipe read its object, and the
   * line of the first call, where describe mode ended.
   */
  described?: { params: Record<string, unknown>[]; readObject: boolean; ended: boolean; line?: number };
}

/** How many rounds of lust's `auto` edits a build applies before it gives up. */
export const MAX_FIX_ROUNDS = 3;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The length of `text` in UTF-8 bytes. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** The text with CRLF and lone CR line ends made LF. */
export function lfOnly(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** A panic line, rustc's form: `thread 'main' (123) panicked at path:line:col:` then the message. */
export function panicOf(stderr: string): { line: number; message: string } | null {
  // Windows writes `src\\main.rs` and CRLF line ends.
  const m = /panicked at ([^\r\n]*?):(\d+):(\d+):\r?\n([^\r\n]*)/.exec(stderr);
  return m ? { line: Number(m[2]), message: m[4]! } : null;
}

/** One `lust build --sandbox --json` of the text in a slot: its exit code and output, and the file it built. */
export interface CompileResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The program, when the build made one. */
  exe?: string;
  /** The path of the slot's `main.rs`, which lust's diagnostics name. */
  main: string;
}

/** Writes `text` as the slot's `main.rs` and builds it. */
export type RecipeCompile = (text: string) => Promise<CompileResult>;

/**
 * Builds `source` through `compile`. With `autofix`, applies lust's `auto` edits and builds again, up to three rounds.
 * `suffix` (the recipe's ingredients, I10) is built after the source on lines of its own; lust's edits never reach
 * it, and `source` in the result is the recipe without it. `source` is expected LF-only (lust's edits are byte offsets
 * in LF text).
 */
export async function buildRecipe(compile: RecipeCompile, source: string, autofix: boolean, suffix = ""): Promise<BuildResult> {
  const started = Date.now();
  let current = source;
  for (let round = 0; ; round += 1) {
    const own = current.endsWith("\n") || !suffix ? current : `${current}\n`;
    const ownLines = own.split("\n").length - 1;
    const ownBytes = utf8Bytes(own);
    const r = await compile(suffix ? own + suffix : current);
    const diagnostics = parseDiagnostics(r.stdout, r.main).map((d) => (suffix && (d.line > ownLines || d.edits.some((e) => e.end > ownBytes)) ? { ...d, edits: [] } : d));
    if (r.code === 0) return { ok: true, diagnostics, source: current, fixRounds: round, ...(r.exe ? { exe: r.exe } : {}), ms: Date.now() - started };
    if (diagnostics.length === 0) {
      return { ok: false, diagnostics, source: current, fixRounds: round, ms: Date.now() - started, reason: `lust failed: ${(r.stderr || r.stdout).trim().slice(0, 600)}` };
    }
    const fixed = autofix && round < MAX_FIX_ROUNDS ? applyAutoEdits(current, diagnostics) : null;
    if (fixed === null || fixed === current) return { ok: false, diagnostics, source: current, fixRounds: round, ms: Date.now() - started };
    current = fixed;
  }
}

/** What a running recipe process reports to the host. */
export interface RecipeProcessEvents {
  /** Text the recipe wrote to stdout, in chunks of any size. */
  stdout(chunk: string): void;
  /** Text the recipe wrote to stderr. */
  stderr(chunk: string): void;
  /**
   * The process ended and its output was read. `reason` is set when the process's own runner stopped it (a memory cap
   * or a limit the runner enforces); it becomes the run's reason.
   */
  exit(code: number | null, reason?: string): void;
  /** The process could not start, or broke. */
  error(message: string): void;
}

/** A started recipe process, as the host drives it. */
export interface RecipeProcess {
  /** Writes one line (the newline is added). */
  write(line: string): void;
  /** Closes the recipe's stdin. */
  closeInput(): void;
  kill(): void;
}

/** Starts the built recipe, with an empty environment, reporting through `events`. */
export type RecipeSpawn = (events: RecipeProcessEvents) => RecipeProcess;

/**
 * Runs a built recipe: the start line, then each call through `call`, until `done`, an exit, or a limit.
 */
export function runRecipe(spawn: RecipeSpawn, start: Record<string, unknown>, call: RecipeCall, limits: RecipeLimits = DEFAULT_LIMITS, signal?: AbortSignal): Promise<RunOutcome> {
  const started = Date.now();
  const refused: RunOutcome["refused"] = [];
  let calls = 0;
  let stderr = "";
  let buffer = "";
  let failure: { reason: string; line?: number } | null = null;
  let halted: RunOutcome["halted"];
  let done: RunOutcome["done"];
  const notes: string[] = [];
  const lateParams: { name: string; line: number }[] = [];
  const described: NonNullable<RunOutcome["described"]> | undefined = start.describe === true ? { params: [], readObject: false, ended: false } : undefined;
  let queue: Promise<void> = Promise.resolve();
  let child: RecipeProcess | null = null;
  let settled = false;
  return new Promise((resolve) => {
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const panic = panicOf(stderr);
      const lastRefused = refused[refused.length - 1];
      let reason = failure?.reason ?? halted?.reason;
      let line = failure?.line ?? halted?.line;
      const extra = { ...(notes.length ? { notes } : {}), ...(lateParams.length ? { lateParams } : {}), ...(described ? { described } : {}) };
      // Describe mode ends at the first call or at done; a panic after the recipe read its object means it needs one.
      if (described && !failure && (described.ended || (described.readObject && panic))) {
        resolve({ ok: true, calls, refused, exitCode: code, stderr: stderr.slice(-4000), ms: Date.now() - started, ...extra });
        return;
      }
      if (!reason && !done) {
        if (panic && lastRefused?.tool === "pick" && lastRefused.line === panic.line) {
          // --- API 1.2. A pick the recipe unwrapped: the pick's own sentence is the reason, not the panic around it.
          reason = lastRefused.reason;
          line = panic.line;
        } else if (panic) {
          reason = `The recipe panicked at line ${panic.line}: ${panic.message}`;
          line = panic.line;
        } else if (/error\[L0532\]/.test(stderr)) {
          reason = stderr.trim().split("\n").find((l) => l.includes("L0532")) ?? "The sandbox stopped the recipe.";
        } else {
          reason = `The recipe ended without done (exit ${code}).`;
        }
        if (line === undefined && lastRefused) line = lastRefused.line;
      }
      resolve({ ok: !reason && !!done, ...(done ? { done } : {}), calls, refused, ...(reason ? { reason } : {}), ...(line !== undefined ? { line } : {}), ...(halted && !failure ? { halted } : {}), exitCode: code, stderr: stderr.slice(-4000), ms: Date.now() - started, ...extra });
    };
    const kill = () => child?.kill();
    const stop = (reason: string, line?: number) => {
      if (!failure) failure = { reason, ...(line !== undefined ? { line } : {}) };
      kill();
    };
    const timer = setTimeout(() => stop(`The recipe ran past its ${limits.timeoutS} s limit and was stopped.`), limits.timeoutS * 1000);
    const onAbort = () => stop("The recipe was cancelled.");
    signal?.addEventListener("abort", onAbort, { once: true });
    const reply = (text: string) => child?.write(text);
    const handle = async (line: string): Promise<void> => {
      if (failure || halted || done || line.trim() === "") return;
      if (utf8Bytes(line) > limits.maxLineBytes) return stop(`A recipe line passed ${limits.maxLineBytes} bytes.`);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return stop(`The recipe wrote a line that is not JSON: ${line.slice(0, 120)}`);
      }
      // Lines that are not calls take no reply (lime-recipe 1.1): describe mode, notes, late parameters.
      if (msg.describe && typeof msg.describe === "object") {
        const d = msg.describe as Record<string, unknown>;
        if (!described) return stop("The recipe wrote a describe line outside describe mode.");
        if (d.param && typeof d.param === "object") described.params.push({ ...(d.param as Record<string, unknown>), ...(typeof d.line === "number" ? { line: d.line } : {}) });
        if (d.object === true) described.readObject = true;
        if (d.end === true) {
          described.ended = true;
          if (typeof d.line === "number") described.line = d.line;
          kill();
        }
        return;
      }
      // --- API 1.2. `s.refuse(sentence)`: the recipe ends the run with its own plain reason, taken back like a refusal.
      if (msg.refuse && typeof msg.refuse === "object") {
        const r = msg.refuse as { reason?: unknown; line?: unknown };
        const text = String(r.reason ?? "").trim().slice(0, 400) || "The recipe refused.";
        return stop(text, typeof r.line === "number" ? r.line : undefined);
      }
      if (typeof msg.note === "string") {
        if (notes.length < 200) notes.push(msg.note.slice(0, 400));
        return;
      }
      if (msg.late_param && typeof msg.late_param === "object") {
        const late = msg.late_param as { name?: unknown; line?: unknown };
        if (lateParams.length < 50) lateParams.push({ name: String(late.name ?? ""), line: typeof late.line === "number" ? late.line : 0 });
        return;
      }
      if (msg.done && typeof msg.done === "object") {
        const d = msg.done as Record<string, unknown>;
        done = { object: typeof d.object === "string" ? d.object : "", metrics: (d.metrics && typeof d.metrics === "object" ? d.metrics : {}) as Record<string, unknown> };
        child?.closeInput();
        return;
      }
      const id = typeof msg.id === "number" ? msg.id : -1;
      const tool = typeof msg.call === "string" ? msg.call : "";
      const at = (msg.at && typeof msg.at === "object" ? msg.at : {}) as { line?: unknown };
      const site: RecipeCallSite = { id, tool, args: (msg.args && typeof msg.args === "object" ? msg.args : {}) as Record<string, unknown>, line: typeof at.line === "number" ? at.line : 0 };
      calls += 1;
      if (calls > limits.maxCalls) return stop(`The recipe made more than ${limits.maxCalls} calls and was stopped.`, site.line);
      let answer: RecipeReply;
      if (!RECIPE_TOOLS.has(tool)) {
        answer = { ok: false, error: `${tool || "(no call)"} is not a recipe call. A recipe may call: ${[...RECIPE_TOOLS].join(", ")}.` };
      } else {
        try {
          answer = await call(site);
        } catch (err) {
          answer = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (failure) return;
      if (answer.ok && answer.halt) {
        halted = { reason: answer.halt, id, line: site.line };
        kill();
        return;
      }
      if (answer.ok) {
        reply(JSON.stringify({ id, ok: true, result: answer.result ?? null }));
      } else {
        refused.push({ id, tool, line: site.line, reason: answer.error });
        reply(JSON.stringify({ ...(answer.extra ?? {}), id, ok: false, error: answer.error }));
      }
    };
    child = spawn({
      stdout: (chunk) => {
        buffer += chunk;
        if (buffer.length > limits.maxLineBytes && !buffer.includes("\n")) stop(`A recipe line passed ${limits.maxLineBytes} bytes.`);
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          queue = queue.then(() => handle(line));
        }
      },
      stderr: (chunk) => {
        if (stderr.length < 64_000) stderr += chunk;
      },
      exit: (code, reason) => {
        if (reason && !failure) failure = { reason };
        void queue.then(() => finish(code));
      },
      error: (message) => stop(`The recipe could not start: ${message}`),
    });
    reply(JSON.stringify({ v: 1, ...start }));
  });
}

/** lust's `--json` lines, the diagnostics of the recipe file first. */
export function parseDiagnostics(stdout: string, mainPath: string): RecipeDiagnostic[] {
  const out: RecipeDiagnostic[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d.kind !== "diagnostic" || d.severity !== "error") continue;
    const span = (d.span ?? {}) as Record<string, number>;
    const inCrate = typeof d.file === "string" && d.file !== mainPath && !d.file.endsWith("main.rs");
    out.push({
      code: String(d.code ?? ""),
      message: String(d.message ?? ""),
      line: span.line ?? 0,
      col: span.col ?? 0,
      fix: String(d.fix ?? ""),
      edits: inCrate ? [] : ((d.edits ?? []) as RecipeDiagnostic["edits"]),
      ...(inCrate ? { inCrate: true } : {}),
    });
  }
  return out.sort((a, b) => Number(!!a.inCrate) - Number(!!b.inCrate));
}

/** `source` with every `auto` edit applied (byte offsets, last first, each span once). Null when there are none. */
export function applyAutoEdits(source: string, diagnostics: RecipeDiagnostic[]): string | null {
  const edits = diagnostics.flatMap((d) => d.edits.filter((e) => e.auto));
  if (edits.length === 0) return null;
  const seen = new Set<string>();
  const unique = edits.filter((e) => {
    const key = `${e.start}:${e.end}:${e.replacement}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => b.start - a.start || b.end - a.end);
  let bytes = encoder.encode(source);
  for (const e of unique) {
    if (e.start < 0 || e.end > bytes.length || e.start > e.end) return null;
    const replacement = encoder.encode(e.replacement);
    const next = new Uint8Array(e.start + replacement.length + (bytes.length - e.end));
    next.set(bytes.subarray(0, e.start), 0);
    next.set(replacement, e.start);
    next.set(bytes.subarray(e.end), e.start + replacement.length);
    bytes = next;
  }
  return decoder.decode(bytes);
}
