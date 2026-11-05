// Run: node tools/ci/bundle-budget.test.mjs (listed in tools/unit-tests.txt).
import { firstChunkFiles, judge } from "./bundle-budget.mjs";

let failed = 0;
function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

eq("exactly at the budget passes", judge(1000, 1000).ok, true);
eq("a small shrink passes", judge(900, 1000).ok, true);
eq("4.9 % over passes", judge(1049, 1000).ok, true);
eq("exactly +5 % passes", judge(1050, 1000).ok, true);
eq("5.1 % over fails", judge(1051, 1000).ok, false);
eq("limit is floor of budget * 1.05", judge(1, 1000).limit, 1050);
eq("percent is reported", Math.round(judge(1100, 1000).percent), 10);

const html = `<head>
<script type="module" crossorigin src="/assets/index-abc.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-def.js">
<link rel="stylesheet" crossorigin href="/assets/index-x.css">
<script src="/classic.js"></script></head>`;
eq("entry and preloads, not css or classic scripts", firstChunkFiles(html), ["assets/index-abc.js", "assets/vendor-def.js"]);
eq("no module script", firstChunkFiles("<html></html>"), []);

if (failed) process.exit(1);
console.log("bundle-budget: ok");
