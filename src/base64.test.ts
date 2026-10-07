import { bytesToBase64 } from "./base64.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  if (actual === expected) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}`);
}

eq("every byte value, padded", bytesToBase64(new Uint8Array([0, 1, 2, 253, 254, 255, 77])), "AAEC/f7/TQ==");
eq("nothing", bytesToBase64(new Uint8Array()), "");
const big = new Uint8Array(100_000);
for (let i = 0; i < big.length; i++) big[i] = Math.imul(i, 2654435761) >>> 24;
const back = Uint8Array.from(atob(bytesToBase64(big)), (c) => c.charCodeAt(0));
eq("across chunks, the bytes come back", back.every((b, i) => b === big[i]) && back.length === big.length, true);
const withNative = Object.assign(new Uint8Array([1]), { toBase64: () => "native" });
eq("the native encoder when the engine has one", bytesToBase64(withNative), "native");

if (failed) throw new Error(`${failed} base64 checks failed`);
console.log("base64: ok");
