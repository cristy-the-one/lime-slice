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
  "model_check", "model_history", "measure", "model_place", "object_place", "section", "log", "data", "pick", "text_outline", "checkpoint", "mesh_at_end", "native_geometry",
  // --- API 1.11 (docs/plan-native-recipes.md 7.1): build what is queued on a part now.
  "flush",
]);

/** Animation scripts may only describe a rig and request its animation, never edit the plate. */
export const ANIMATION_TOOLS: ReadonlySet<string> = new Set(["rig", "animate", "log", "progress", "data"]);

export interface RecipeLimits {
  /** Wall time for the run, kernel time included. */
  timeoutS: number;
  maxCalls: number;
  /** Longest line the recipe may write, in bytes. */
  maxLineBytes: number;
}

export const DEFAULT_LIMITS: RecipeLimits = { timeoutS: 30, maxCalls: 2000, maxLineBytes: 1 << 20 };

/** The Plugins window keeps at most this many parts from one fresh run. */
export const MAX_APP_RECIPE_PARTS = 100;

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
  /** Which program the build left: lust's optimised one (`--opt`, zig cc) or tinycc's. Unset when the host does not say. */
  compiler?: "opt" | "tcc";
  /**
   * The `s.apply` calls of the built text whose reply the recipe never reads, as lust marked them (`--mark-unread`).
   * Unset when lust was not asked: a lust older than 0.3.0, which has no such flag.
   */
  unread?: UnreadCall[];
}

/** A call the recipe made, as the caller sees it. */
export interface RecipeCallSite {
  id: number;
  tool: string;
  args: Record<string, unknown>;
  line: number;
  /** The call's column on that line, as `Location::caller()` reports it (lime-recipe sends it with every call). */
  col?: number;
}

/**
 * --- docs/plan-native-recipes.md 7.1, "What queues silently". The function whose unread results lust marks
 * (`lust build --json --mark-unread <fn>`): `s.apply`, the one call a host may hold back and build with others. lust
 * finds it by resolution, so a recipe's own `fn apply` is not it, and a call in lime-recipe itself (`lettering`'s) is
 * marked in the crate's file, which is not the recipe's.
 */
export const MARK_UNREAD_FN = "lime_recipe::Session::apply";

/** One unread call: where it reports its caller location, in the built text (1-based line and column). */
export interface UnreadCall {
  line: number;
  col: number;
}

/**
 * The caller's answer: the tool's result, or a refusal sentence (with any hint fields to pass on). `halt` ends the run
 * after this call without a failure (a partial dry run's step limit, I23): the recipe gets no reply and is stopped.
 */
export type RecipeReply = { ok: true; result: unknown; halt?: string } | { ok: false; error: string; extra?: Record<string, unknown>; fatal?: boolean };

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
  /** Which program the build left (`BuildResult.compiler`). */
  compiler?: "opt" | "tcc";
  /** True when lust was asked to mark unread `s.apply` calls (`MARK_UNREAD_FN`): its stdout then lists them. */
  marked?: boolean;
}

/** The text lust builds: the recipe, then its ingredients (`suffix`) on lines of their own, as `buildRecipe` joins them. */
export function builtText(source: string, suffix = ""): string {
  if (!suffix) return source;
  return (source.endsWith("\n") ? source : `${source}\n`) + suffix;
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
    if (r.code === 0) {
      return { ok: true, diagnostics, source: current, fixRounds: round, ...(r.exe ? { exe: r.exe } : {}), ...(r.compiler ? { compiler: r.compiler } : {}), ...(r.marked ? { unread: parseUnread(r.stdout, r.main, suffix ? own + suffix : current) } : {}), ms: Date.now() - started };
    }
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
export function runRecipe(spawn: RecipeSpawn, start: Record<string, unknown>, call: RecipeCall, limits: RecipeLimits = DEFAULT_LIMITS, signal?: AbortSignal, onProgress?: (fraction: number, message: string) => void): Promise<RunOutcome> {
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
      if (msg.progress && typeof msg.progress === "object") {
        const progress = msg.progress as Record<string, unknown>;
        if (typeof progress.fraction === "number" && Number.isFinite(progress.fraction)) {
          onProgress?.(Math.max(0, Math.min(1, progress.fraction)), String(progress.message ?? "").slice(0, 400));
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
      // --- API 1.11. `s.queue(on)`: silent queuing on or off for the rest of the run. Told to the caller as a call of
      // its own (`queue`), in order with the calls; it takes no reply and does not count.
      if (msg.queue && typeof msg.queue === "object") {
        const q = msg.queue as { silent?: unknown; line?: unknown };
        try {
          await call({ id: 0, tool: "queue", args: { silent: q.silent !== false }, line: typeof q.line === "number" ? q.line : 0 });
        } catch { /* A caller without a queue has nothing to turn off. */ }
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
      const at = (msg.at && typeof msg.at === "object" ? msg.at : {}) as { line?: unknown; col?: unknown };
      const site: RecipeCallSite = { id, tool, args: (msg.args && typeof msg.args === "object" ? msg.args : {}) as Record<string, unknown>, line: typeof at.line === "number" ? at.line : 0, ...(typeof at.col === "number" ? { col: at.col } : {}) };
      calls += 1;
      if (calls > limits.maxCalls) return stop(`The recipe made more than ${limits.maxCalls} calls and was stopped.`, site.line);
      let answer: RecipeReply;
      if (start.kind === "animation" && !ANIMATION_TOOLS.has(tool)) {
        answer = { ok: false, error: "An animation can only pose the assembly it was given." };
      } else if (start.kind !== "animation" && !RECIPE_TOOLS.has(tool)) {
        answer = { ok: false, error: `${tool || "(no call)"} is not a recipe call. A recipe may call: ${[...RECIPE_TOOLS].join(", ")}.` };
      } else {
        try {
          answer = await call(site);
        } catch (err) {
          answer = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (failure) return;
      if (!answer.ok && answer.fatal) return stop(answer.error, site.line);
      if (answer.ok && answer.halt) {
        halted = { reason: answer.halt, id, line: site.line };
        kill();
        return;
      }
      if (answer.ok) {
        reply(JSON.stringify({ id, ok: true, result: answer.result ?? null }));
      } else {
        // Native geometry is an optional acceleration; its recipe-side fallback handles a missing host.
        if (tool !== "native_geometry") refused.push({ id, tool, line: site.line, reason: answer.error });
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
    if (signal?.aborted) onAbort();
    else reply(JSON.stringify({ v: 1, ...start }));
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

/**
 * lust's `unread_result` lines for `MARK_UNREAD_FN` in the recipe's file (`--mark-unread`, on a passing build): one
 * per call whose result the program never reads, at the place the call reports through `Location::caller()`.
 *
 * lust's span names the line and the byte column; a call reports the line and the column as rustc counts it for
 * `Location` (the display column: a tab is four wide, a wide character two). `text` is what was built, so each mark is
 * turned into the column its call will report: one per character before it on the line, four per tab. A mark with
 * anything else before it on its line (a character outside ASCII, a control character) is left out, since its width
 * is not known for sure here: that call is then built in its place, which is always right.
 */
export function parseUnread(stdout: string, mainPath: string, text: string): UnreadCall[] {
  const out: UnreadCall[] = [];
  let lines: string[] | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{") || !line.includes('"unread_result"')) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d.kind !== "unread_result" || d.fn !== MARK_UNREAD_FN) continue;
    if (typeof d.file !== "string" || (d.file !== mainPath && !d.file.endsWith("main.rs"))) continue;
    const span = (d.span ?? {}) as Record<string, unknown>;
    if (typeof span.line !== "number" || typeof span.col !== "number") continue;
    lines ??= text.split("\n");
    const col = reportedColumn(lines[span.line - 1] ?? "", span.col);
    if (col !== null) out.push({ line: span.line, col });
  }
  return out;
}

/**
 * The column a call at byte column `byteCol` (1-based) of `line` reports as its caller location, or null when the
 * text before it holds a character whose width is not one or a tab's four.
 */
export function reportedColumn(line: string, byteCol: number): number | null {
  let col = 1;
  // Before the first character outside ASCII, a byte is a UTF-16 unit, so the byte column indexes the string.
  for (let i = 0; i < byteCol - 1; i += 1) {
    const c = line.charCodeAt(i);
    if (c === 9) col += 4;
    else if (c >= 0x20 && c < 0x7f) col += 1;
    else return null;
  }
  return col;
}

/**
 * The marks as the queue reads them (`src/recipe/queue.ts`): `line:col` of each unread call, or null when lust gave
 * none (`BuildResult.unread` unset), which turns silent queuing off.
 */
export function unreadKeys(unread: readonly UnreadCall[] | undefined): ReadonlySet<string> | null {
  return unread ? new Set(unread.map((u) => `${u.line}:${u.col}`)) : null;
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
