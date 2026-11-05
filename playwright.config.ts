import { defineConfig } from "@playwright/test";

const port = process.env.LIME_PW_PORT ?? "43117";
const baseURL = `http://127.0.0.1:${port}`;
export const ORIGIN = baseURL;

/**
 * The app slices by itself after a change. Specs were written against a button press, so they start with the gear's
 * auto-slice preference off; a spec about auto-slice opts back in with `autoSliceOnState`. `LIME_PW_PORT` moves the server
 * when another run holds the port.
 */
export function autoSliceOffState(origin: string) {
  return { cookies: [], origins: [{ origin, localStorage: [{ name: "lime-slice-auto-slice", value: "0" }, ...expertLevel] }] };
}

/**
 * A launch with no saved settings level is a first run: Prepare, Simple (e2e/first-run.spec.ts). The specs were written
 * for a returning user who chose Expert, so they start with that choice saved. A spec about auto-slice keeps the default
 * (on) with this state instead of an empty one.
 */
const expertLevel = [{ name: "lime-slice-settings-level", value: "expert" }];
export function autoSliceOnState(origin: string) {
  return { cookies: [], origins: [{ origin, localStorage: expertLevel }] };
}

export default defineConfig({
  testDir: "e2e",
  testIgnore: ["scratch/**"],
  timeout: 90_000,
  use: { baseURL, viewport: { width: 1280, height: 800 }, storageState: autoSliceOffState(baseURL) },
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
