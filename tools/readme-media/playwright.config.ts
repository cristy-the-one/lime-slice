import { defineConfig } from "@playwright/test";

/**
 * The README's pictures and clips (docs/readme-media.md says how to run them). Not a test suite: each spec drives the
 * built app against a real engine and writes into docs/screenshots. Headless Chromium only, one worker.
 */
const port = process.env.LIME_PW_PORT ?? "43117";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.media\.ts$/,
  outputDir: "../../test-results/readme-media",
  timeout: 300_000,
  workers: 1,
  reporter: "line",
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
    storageState: {
      cookies: [],
      origins: [{ origin: baseURL, localStorage: [{ name: "lime-slice-settings-level", value: "expert" }, { name: "lime-slice-theme", value: "dark" }] }],
    },
  },
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${port}`,
    cwd: "../..",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
