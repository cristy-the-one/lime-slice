/**
 * Where the window's recipes run: the desktop app's Tauri runner (`./tauri.ts`). A page under test can set
 * `__limeRecipeRunner` to a scripted runner's `invoke` and `listen` and run plugins without a shell; the shared host
 * and the app's calls run as they do in the app. The browser has neither, and says so.
 */
import { isTauri } from "../platform.ts";
import { AppRecipes, tauriRecipes, type Invoke, type Listen } from "./tauri.ts";

export const RECIPES_NEED_APP = "Rebuilding a plugin step needs the desktop app, which runs plugins with the lust it ships.";

let runtime: Promise<AppRecipes | null> | null = null;

/** The app's recipes, or null in a browser. */
export function recipeRuntime(): Promise<AppRecipes | null> {
  const hook = (globalThis as { __limeRecipeRunner?: { invoke: Invoke; listen: Listen } }).__limeRecipeRunner;
  if (hook) return Promise.resolve(new AppRecipes(hook.invoke, hook.listen));
  if (typeof window === "undefined" || !isTauri()) return Promise.resolve(null);
  runtime ??= tauriRecipes().catch(() => null);
  return runtime;
}

/** Whether plugins can run here: null, or the sentence that says why not. */
export async function recipesUnavailable(): Promise<string | null> {
  const recipes = await recipeRuntime();
  if (!recipes) return RECIPES_NEED_APP;
  const ready = await recipes.available().catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }));
  return ready.ok ? null : ready.reason;
}
