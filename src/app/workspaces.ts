/**
 * Model (with Sketch, Stress, Split to print and Plugins) loads on first use, not with the app: its tab, a Model command
 * or shortcut, a project with Model steps, a plugin file, or the idle prefetch after the first paint. Prepare and Preview
 * never wait for it.
 *
 * Code that is always loaded reaches Model through here only:
 * - `modelApi()` when there is nothing to do before Model has loaded (no solid is open, no tree is held);
 * - `withModel(run)` for an action the user asked for: it runs at once when Model is there, else as soon as it loads;
 * - `await loadModel()` in an async flow that needs Model's answer (save, open, export).
 * `modelTrees` (./model-trees) is only ever filled by Model, so an empty map is the truth until it loads.
 */
import type * as ModelWorkspace from "./model-workspace";
import { pushToast } from "../ui/toasts";

export type ModelApi = typeof ModelWorkspace;

let api: ModelApi | null = null;
let loading: Promise<ModelApi> | null = null;

/** Model's calls once it has loaded and mounted, else null. */
export function modelApi(): ModelApi | null {
  return api;
}

/** Loads and mounts Model once; every caller gets the same promise. A failed load can be tried again. */
export function loadModel(): Promise<ModelApi> {
  if (api) return Promise.resolve(api);
  loading ??= import("./model-workspace").then(
    (module) => {
      module.mountModelWorkspace();
      api = module;
      return module;
    },
    (err: unknown) => {
      loading = null;
      throw err;
    },
  );
  return loading;
}

/**
 * Runs `run` with Model: now when it has loaded, so a click or a key behaves as it always did, else once it loads. A
 * request made while it loads is kept, never dropped, and a load that fails says so instead of throwing.
 */
export function withModel(run: (model: ModelApi) => void): void {
  if (api) {
    run(api);
    return;
  }
  loadModel().then(run, (err: unknown) => {
    pushToast(`Model could not load: ${err instanceof Error ? err.message : String(err)}`, "error");
  });
}

/**
 * After the first paint, when the window is idle (or after `timeoutMs` at the latest), load Model so a first click on
 * it does not wait. Its parts then sit hidden, as they did when the app wrote them at start.
 */
export function prefetchWorkspaces(timeoutMs = 2000): void {
  const load = () => {
    void loadModel().catch(() => {
      // A later use tries again and says so; the prefetch stays quiet.
    });
  };
  const idle = (window as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  requestAnimationFrame(() => {
    window.setTimeout(() => {
      if (typeof idle === "function") idle.call(window, load, { timeout: timeoutMs });
      else window.setTimeout(load, timeoutMs / 2);
    }, 0);
  });
}
