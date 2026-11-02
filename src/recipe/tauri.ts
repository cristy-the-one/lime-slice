/**
 * The app's recipe transport (docs/plan-recipe-plugins.md D16): the shared host (`./host.ts`) over the Tauri runner
 * (`src-tauri/src/recipe.rs`). A build is `recipe_build` in one of the app's four slots; a run is `recipe_start` with
 * a run id the window picks, its lines as `recipe-line` events, its end as one `recipe-exit`, and replies through
 * `recipe_send`. The runner holds the same limits and the memory cap, and kills every recipe when the window closes.
 *
 * `invoke` and `listen` are passed in, so tests drive this module with a scripted runner and the browser build never
 * loads Tauri.
 */
import { buildRecipe, DEFAULT_LIMITS, lfOnly, runRecipe, type BuildResult, type CompileResult, type RecipeCall, type RecipeLimits, type RecipeSpawn, type RunOutcome } from "./host.ts";

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type Listen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;

/** What the runner's events carry. */
export interface RecipeLinePayload {
  run: string;
  line: string;
}
export interface RecipeExitPayload {
  run: string;
  code: number | null;
  reason: string | null;
  stderr: string;
}

const SLOTS = 4;

/** The app's recipes: builds in warm slots and runs through the Tauri runner. */
export class AppRecipes {
  private readonly invoke: Invoke;
  private readonly listen: Listen;
  /** Recipe names in use order, most recent last, and the slot each holds (as the MCP server's host keeps them). */
  private slotOrder: string[] = [];
  private readonly slotOf = new Map<string, number>();
  private runs = 0;
  private ready: { ok: true; lust: string } | { ok: false; reason: string } | null = null;

  constructor(invoke: Invoke, listen: Listen) {
    this.invoke = invoke;
    this.listen = listen;
  }

  /** Whether recipes can run in this app, and why not. */
  async available(): Promise<{ ok: true; lust: string } | { ok: false; reason: string }> {
    this.ready ??= await this.invoke<{ ok: true; lust: string } | { ok: false; reason: string }>("recipe_available");
    return this.ready;
  }

  /** The slot a recipe name builds in: the one it had among the last four names used, else the least recently used. */
  slotFor(name: string): number {
    let index = this.slotOf.get(name);
    if (index === undefined) {
      const taken = new Set(this.slotOf.values());
      index = [...Array(SLOTS).keys()].find((i) => !taken.has(i));
      if (index === undefined) {
        const oldest = this.slotOrder.shift()!;
        index = this.slotOf.get(oldest)!;
        this.slotOf.delete(oldest);
      }
      this.slotOf.set(name, index);
    }
    this.slotOrder = this.slotOrder.filter((n) => n !== name).concat(name);
    return index;
  }

  /** Builds `source` (and its ingredients' `suffix`) in the name's slot, with lust's `auto` fixes when asked. */
  async build(name: string, source: string, autofix: boolean, suffix = ""): Promise<BuildResult> {
    source = lfOnly(source);
    const ready = await this.available();
    if (!ready.ok) return { ok: false, diagnostics: [], source, fixRounds: 0, ms: 0, reason: ready.reason };
    const slot = this.slotFor(name);
    return buildRecipe(async (text) => {
      try {
        const r = await this.invoke<{ code: number | null; stdout: string; stderr: string; exe: string | null; main: string }>("recipe_build", { slot, source: text });
        return { code: r.code, stdout: r.stdout, stderr: r.stderr, ...(r.exe ? { exe: r.exe } : {}), main: r.main } satisfies CompileResult;
      } catch (err) {
        return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err), main: "" };
      }
    }, source, autofix, suffix);
  }

  /** Runs a recipe this app built, answering its calls through `call`. */
  run(exe: string, start: Record<string, unknown>, call: RecipeCall, limits: RecipeLimits = DEFAULT_LIMITS, signal?: AbortSignal): Promise<RunOutcome> {
    this.runs += 1;
    return runRecipe(this.spawn(exe, `run-${Date.now().toString(36)}-${this.runs}`, limits), start, call, limits, signal);
  }

  /**
   * A run through the runner's events. Listening starts before the recipe does, and the lines the window writes go
   * out in order, each after the one before has reached the runner.
   */
  private spawn(exe: string, run: string, limits: RecipeLimits): RecipeSpawn {
    return (events) => {
      let ended = false;
      let unlisten: (() => void)[] = [];
      const end = () => {
        for (const stop of unlisten) stop();
        unlisten = [];
      };
      let outgoing: Promise<unknown> = Promise.all([
        this.listen<RecipeLinePayload>("recipe-line", ({ payload }) => {
          if (payload.run === run && !ended) events.stdout(`${payload.line}\n`);
        }),
        this.listen<RecipeExitPayload>("recipe-exit", ({ payload }) => {
          if (payload.run !== run || ended) return;
          ended = true;
          end();
          if (payload.stderr) events.stderr(payload.stderr);
          events.exit(payload.code, payload.reason ?? undefined);
        }),
      ]).then(async (stops) => {
        unlisten = stops;
        if (ended) end();
        await this.invoke("recipe_start", { run, exe, limits: { timeoutS: limits.timeoutS, maxCalls: limits.maxCalls, maxLineBytes: limits.maxLineBytes } });
      }).catch((err: unknown) => {
        ended = true;
        end();
        events.error(err instanceof Error ? err.message : String(err));
        events.exit(null);
      });
      const send = (command: string, args: Record<string, unknown>) => {
        outgoing = outgoing.then(() => (ended ? undefined : this.invoke(command, args))).catch(() => undefined);
      };
      return {
        write: (line) => send("recipe_send", { run, line }),
        closeInput: () => send("recipe_close_input", { run }),
        kill: () => {
          outgoing = outgoing.then(() => this.invoke("recipe_kill", { run })).catch(() => undefined);
        },
      };
    };
  }
}

/** The app's recipes through Tauri, loaded only inside the desktop shell. */
export async function tauriRecipes(): Promise<AppRecipes> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  return new AppRecipes(invoke as Invoke, listen as Listen);
}
