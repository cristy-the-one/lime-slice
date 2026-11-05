// Run: node tools/ci/smoke-shards.test.mjs (listed in tools/unit-tests.txt).
// Every spec in package.json's test:smoke lands in exactly one of the four shards, and a spec that
// e2e/durations.json does not know still gets one.
import { durationsFromReport, parseSmokeScript, readDurations, readSmoke, splitShards } from "./smoke-shards.mjs";

let failed = 0;
function ok(name, condition, detail = "") {
  if (condition) return;
  failed += 1;
  console.error(`FAIL ${name} ${detail}`);
}

const { specs, flags } = readSmoke();
ok("the smoke list is not empty", specs.length > 100, `got ${specs.length}`);
ok("the @perf specs stay out", flags.includes("--grep-invert") && flags.includes("@perf"));
ok("no spec is listed twice", new Set(specs).size === specs.length);

function check(name, shards, list) {
  const seen = new Map();
  shards.forEach((shard, index) => {
    for (const spec of shard.specs) seen.set(spec, [...(seen.get(spec) ?? []), index + 1]);
  });
  for (const spec of list) {
    const where = seen.get(spec) ?? [];
    ok(`${name}: ${spec} is in exactly one shard`, where.length === 1, `shards ${where.join(",") || "none"}`);
  }
  ok(`${name}: nothing extra`, seen.size === list.length, `${seen.size} vs ${list.length}`);
}

const durations = readDurations();
check("with e2e/durations.json", splitShards(specs, durations, 4), specs);
check("with no durations at all", splitShards(specs, {}, 4), specs);

// A spec the durations file has never seen, next to ones it has: it is placed, at the median.
const unknown = [...specs, "e2e/brand-new.spec.ts"];
check("a new spec", splitShards(unknown, durations, 4), unknown);

// The split is balanced: the longest shard is within 10 % of the mean, and the result does not depend on order.
const shards = splitShards(specs, durations, 4);
const totals = shards.map((shard) => shard.ms);
const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
ok("balanced within 10 %", Math.max(...totals) <= mean * 1.1, `totals ${totals.join(",")}`);
const reversed = splitShards([...specs].reverse(), durations, 4);
ok("order does not matter", JSON.stringify(shards) === JSON.stringify(reversed));

// Greedy on a tiny case: 5, 4, 3, 3 over two shards is 8 and 7.
const tiny = splitShards(["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts", "e2e/d.spec.ts"], {
  "e2e/a.spec.ts": 5, "e2e/b.spec.ts": 4, "e2e/c.spec.ts": 3, "e2e/d.spec.ts": 3,
}, 2);
ok("tiny case", JSON.stringify(tiny.map((s) => s.ms)) === "[8,7]", JSON.stringify(tiny.map((s) => s.ms)));

// The script parser and the JSON report reader.
const parsed = parseSmokeScript("playwright test --grep-invert @perf e2e/a.spec.ts e2e/b.spec.ts");
ok("parse specs", parsed.specs.join() === "e2e/a.spec.ts,e2e/b.spec.ts");
ok("parse flags", parsed.flags.join(" ") === "--grep-invert @perf");
const report = {
  suites: [
    { file: "a.spec.ts", suites: [{ file: "a.spec.ts", specs: [{ file: "a.spec.ts", tests: [{ results: [{ duration: 1000 }] }, { results: [{ duration: 500 }, { duration: 250 }] }] }] }] },
    { file: "b.spec.ts", specs: [{ tests: [{ results: [{ duration: 7 }] }] }] },
  ],
};
const read = durationsFromReport(report);
ok("report a", read["e2e/a.spec.ts"] === 1750, JSON.stringify(read));
ok("report b", read["e2e/b.spec.ts"] === 7, JSON.stringify(read));

if (failed > 0) process.exit(1);
console.log("smoke-shards ok");
