import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:43117";

/**
 * The app slices by itself after a change. Specs were written against a button press, so they start with the gear's
 * auto-slice preference off; a spec about auto-slice opts back in with an empty `storageState`.
 */
export function autoSliceOffState(origin: string) {
  return { cookies: [], origins: [{ origin, localStorage: [{ name: "lime-slice-auto-slice", value: "0" }] }] };
}

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  use: { baseURL, viewport: { width: 1280, height: 800 }, storageState: autoSliceOffState(baseURL) },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 43117",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
