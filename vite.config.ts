import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

function serveSamples(): Plugin {
  const root = path.resolve(__dirname, "samples");
  return {
    name: "serve-samples",
    configureServer(server) {
      server.middlewares.use("/samples", (req, res, next) => {
        const raw = (req.url ?? "/").split("?")[0];
        const file = path.join(root, decodeURIComponent(raw));
        if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        fs.createReadStream(file).pipe(res);
      });
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
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
