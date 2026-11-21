/**
 * Bounded gzip+base64 save cache in src/project-pack.ts:
 * - unchanged bytes hit the cache on a second save;
 * - same hash + byteLength with different bytes misses and re-packs;
 * - eviction bounds raw.length + packed.length under the cap;
 * - entries whose raw base64 exceeds half the cap are skipped.
 */
import { bytesToBase64 } from "./base64.ts";
import {
  ENCODING_GZIP,
  PACK_CACHE_MAX_CHARS,
  PACK_CACHE_MAX_ENTRIES,
  finishProject,
  gunzip,
  packCacheStats,
  resetPackCache,
  type PreparedProject,
} from "./project-pack.ts";
import { base64ToBytes } from "./base64.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

function makeBytes(length: number, seed: number): Uint8Array {
  // Pseudo-random bytes so gzip does not collapse everything to a tiny constant.
  const out = new Uint8Array(length);
  let x = (seed >>> 0) || 1;
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

function preparedFor(hash: string, bytes: Uint8Array): { prepared: PreparedProject; record: Record<string, unknown> } {
  const bytesBase64 = bytesToBase64(bytes);
  const record: Record<string, unknown> = {
    name: `${hash}.stl`,
    byteLength: bytes.byteLength,
    hash,
    encoding: ENCODING_GZIP,
    data: "",
  };
  return {
    record,
    prepared: {
      wire: { version: 4, objects: [{ mesh: record }] },
      jobs: [{ record, bytesBase64 }],
    },
  };
}

// 1. A second save of unchanged bytes is a hit.
{
  resetPackCache();
  const bytes = makeBytes(600, 1);
  const first = preparedFor("deadbeef", bytes);
  await finishProject(first.prepared);
  const s1 = packCacheStats();
  const second = preparedFor("deadbeef", bytes);
  await finishProject(second.prepared);
  const s2 = packCacheStats();
  check(
    "unchanged bytes hit the save cache on second save",
    s1.misses === 1 && s1.hits === 0 && s2.misses === 1 && s2.hits === 1 && first.record.data === second.record.data && s2.entries === 1,
    { s1, s2 },
  );
  const rawLen = bytesToBase64(bytes).length;
  const packedLen = String(first.record.data).length;
  check(
    "cache accounts for both raw.length and packed.length",
    s2.chars === rawLen + packedLen,
    { chars: s2.chars, rawLen, packedLen, expected: rawLen + packedLen },
  );
}

// 2. Same hash and byteLength with different bytes is a miss and re-packs to the new bytes.
{
  resetPackCache();
  const bytesA = makeBytes(600, 11);
  const bytesB = makeBytes(600, 22);
  const a = preparedFor("samehash", bytesA);
  await finishProject(a.prepared);
  const b = preparedFor("samehash", bytesB);
  await finishProject(b.prepared);
  const stats = packCacheStats();
  const unpacked = await gunzip(base64ToBytes(String(b.record.data))!);
  const sameAsB = unpacked.byteLength === bytesB.byteLength && unpacked.every((v, i) => v === bytesB[i]);
  check(
    "hash collision with same byteLength misses and re-packs accurately",
    stats.hits === 0 && stats.misses === 2 && a.record.data !== b.record.data && sameAsB,
    { stats, sameAsB },
  );
}

// 3. Eviction keeps total raw.length + packed.length under the cap (and entries <= PACK_CACHE_MAX_ENTRIES).
{
  const cap = 4000;
  resetPackCache(cap);
  for (let i = 0; i < 10; i += 1) {
    const entry = preparedFor(`evict_${i}`, makeBytes(450, 100 + i));
    await finishProject(entry.prepared);
    const st = packCacheStats();
    if (st.chars > cap || st.entries > PACK_CACHE_MAX_ENTRIES) {
      check(`eviction cap respected at step ${i}`, false, st);
    }
  }
  const afterCharEvict = packCacheStats();
  check(
    "eviction keeps total raw+packed chars under cap",
    afterCharEvict.chars <= cap && afterCharEvict.entries < 10 && afterCharEvict.entries >= 1,
    afterCharEvict,
  );
  // Oldest entry was evicted (miss); newest entry is still cached (hit).
  const oldest = preparedFor("evict_0", makeBytes(450, 100));
  const beforeOld = packCacheStats().misses;
  await finishProject(oldest.prepared);
  const oldMissed = packCacheStats().misses === beforeOld + 1;
  const newest = preparedFor("evict_9", makeBytes(450, 109));
  const beforeNew = packCacheStats().hits;
  await finishProject(newest.prepared);
  const newHit = packCacheStats().hits === beforeNew + 1;
  check("eviction drops oldest entry while retaining newest", oldMissed && newHit, { oldMissed, newHit });
}

// 4. An entry whose raw base64 exceeds half the cap is not cached.
{
  const cap = 2000;
  resetPackCache(cap);
  // 800 bytes -> ~1068 base64 chars > cap / 2 (1000).
  const big = makeBytes(800, 777);
  const first = preparedFor("toobig", big);
  await finishProject(first.prepared);
  const s1 = packCacheStats();
  const second = preparedFor("toobig", big);
  await finishProject(second.prepared);
  const s2 = packCacheStats();
  check(
    "entry with raw.length > maxChars / 2 is skipped by the cache",
    s1.entries === 0 && s1.chars === 0 && s2.entries === 0 && s2.hits === 0 && s2.misses === 2 && PACK_CACHE_MAX_CHARS === 32 * 1024 * 1024,
    { s1, s2, rawLen: bytesToBase64(big).length, cap },
  );
}

resetPackCache();

if (failed > 0) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("project-pack: all checks passed");
