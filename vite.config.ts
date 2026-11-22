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
    writeBundle() {
      const dest = path.resolve(__dirname, "dist/samples");
      fs.cpSync(root, dest, { recursive: true });
    },
  };
}

// Dev only: `npm run build:analyze` prints what each large chunk is made of (rendered bytes, before
// minification) and writes dist-analysis.json. It only runs when LIME_ANALYZE is set.
function analyzeBundle(): Plugin {
  return {
    name: "analyze-bundle",
    apply: "build",
    generateBundle(_options, bundle) {
      const report: Record<string, { bytes: number; modules: Record<string, number> }> = {};
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        const modules: Record<string, number> = {};
        for (const [id, info] of Object.entries(chunk.modules)) {
          const name = path.relative(__dirname, id).replace(/\\/g, "/");
          modules[name] = info.renderedLength;
        }
        report[chunk.fileName] = { bytes: chunk.code.length, modules };
      }
      fs.writeFileSync(path.resolve(__dirname, "dist-analysis.json"), JSON.stringify(report, null, 1));
      for (const [file, entry] of Object.entries(report)) {
        if (entry.bytes < 50_000) continue;
        console.log(`\n${file}  ${(entry.bytes / 1024).toFixed(1)} kB`);
        const groups = new Map<string, number>();
        for (const [name, bytes] of Object.entries(entry.modules)) {
          const m = /node_modules\/three\/(?:src|examples\/jsm)\/[^/]+/.exec(name) ?? /node_modules\/[^/]+/.exec(name);
          const key = m ? m[0] : "src";
          groups.set(key, (groups.get(key) ?? 0) + bytes);
        }
        for (const [key, bytes] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
          console.log(`  ${(bytes / 1024).toFixed(1).padStart(8)} kB  ${key}`);
        }
      }
    },
  };
}

const appVersion: string = JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8")).version;
const devHost = process.env.LIME_DEV_HOST || "127.0.0.1";

export default defineConfig({
  clearScreen: false,
  plugins: [serveSamples(), ...(process.env.LIME_ANALYZE ? [analyzeBundle()] : [])],
  server: {
    host: devHost,
    port: 43117,
    strictPort: true,
  },
  preview: {
    host: devHost,
    port: 43117,
    strictPort: true,
  },
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
