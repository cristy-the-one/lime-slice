import { base64ToBytes, bytesToBase64 } from "./base64.ts";

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

const decoded = base64ToBytes(bytesToBase64(big));
eq("decoding gives the bytes back", !!decoded && decoded.length === big.length && decoded.every((b, i) => b === big[i]), true);
eq("not base64", base64ToBytes("@@@@"), null);
eq("unpadded", Array.from(base64ToBytes("QQ") ?? []).join(), "65");
const host = Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array };
const before = host.fromBase64;
host.fromBase64 = function (this: unknown, text: string) {
  return this === Uint8Array ? new Uint8Array([text.length]) : new Uint8Array();
};
eq("the native decoder when the engine has one", Array.from(base64ToBytes("AAAA") ?? []).join(), "4");
host.fromBase64 = () => {
  throw new SyntaxError("bad");
};
eq("a native refusal is null", base64ToBytes("AAAA"), null);
if (before) host.fromBase64 = before;
else delete host.fromBase64;

if (failed) throw new Error(`${failed} base64 checks failed`);
console.log("base64: ok");
