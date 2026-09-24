import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:43117", viewport: { width: 1280, height: 800 } },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 43117",
    url: "http://127.0.0.1:43117",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
