import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin, type Connect } from "vite";

function serveSamples(): Plugin {
  const root = path.resolve(__dirname, "samples");
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const raw = (req.url ?? "/").split("?")[0];
    const file = path.join(root, decodeURIComponent(raw));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      next();
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  };
  return {
    name: "serve-samples",
    configureServer(server) {
      server.middlewares.use("/samples", handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/samples", handler);
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [serveSamples()],
  server: {
    host: "127.0.0.1",
    port: 43117,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 43117,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
