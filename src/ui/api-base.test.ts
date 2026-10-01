import {
  authHeaders,
  DEFAULT_LOOPBACK_API,
  engineDownMessage,
  readApiTarget,
  resolveApiBase,
  resolveApiToken,
} from "./api-base.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq(name: string, actual: string, expected: string): void {
  check(name, actual === expected, `got ${JSON.stringify(actual)}`);
}

const lan = { protocol: "http:", hostname: "192.168.1.20" };

eq(
  "stored setting wins over query, env, and the page host",
  resolveApiBase({ stored: "http://engine.local:43118/", query: "http://query:9", env: "http://env:9", ...lan }),
  "http://engine.local:43118",
);
eq(
  "query wins over env and the page host",
  resolveApiBase({ stored: "  ", query: "http://query:9/", env: "http://env:9", ...lan }),
  "http://query:9",
);
eq(
  "env wins over the page host",
  resolveApiBase({ stored: null, query: null, env: "http://env:9", ...lan }),
  "http://env:9",
);
eq(
  "a non-loopback page uses its own host on 43118",
  resolveApiBase({ ...lan }),
  "http://192.168.1.20:43118",
);
eq(
  "https page keeps https",
  resolveApiBase({ protocol: "https:", hostname: "slice.tailnet.ts.net" }),
  "https://slice.tailnet.ts.net:43118",
);
eq("localhost stays on loopback", resolveApiBase({ protocol: "http:", hostname: "localhost" }), DEFAULT_LOOPBACK_API);
eq("127.0.0.1 stays on loopback", resolveApiBase({ hostname: "127.0.0.1" }), DEFAULT_LOOPBACK_API);
eq("ipv6 loopback stays on loopback", resolveApiBase({ hostname: "::1" }), DEFAULT_LOOPBACK_API);
eq(
  "ipv6 page host is bracketed",
  resolveApiBase({ protocol: "http:", hostname: "2001:db8::1" }),
  "http://[2001:db8::1]:43118",
);
eq("blank inputs stay on loopback", resolveApiBase({}), DEFAULT_LOOPBACK_API);

eq("stored token wins", resolveApiToken({ stored: "saved", query: "q", env: "e" }), "saved");
eq("query token wins over env", resolveApiToken({ stored: " ", query: "q", env: "e" }), "q");
eq("env token is last", resolveApiToken({ env: "e" }), "e");
eq("no token is empty", resolveApiToken({}), "");

const read = readApiTarget(
  { protocol: "http:", hostname: "10.0.0.4", search: "?api=http://from-query:43118&token=abc" },
  null,
  null,
  "http://from-env:43118",
  "env-token",
);
eq("readApiTarget uses the query before env", read.base, "http://from-query:43118");
eq("readApiTarget uses the query token", read.token, "abc");
const stored = readApiTarget(
  { protocol: "http:", hostname: "10.0.0.4", search: "?api=http://from-query:43118&token=abc" },
  "http://saved:43118",
  "saved-token",
  "http://from-env:43118",
  "env-token",
);
eq("readApiTarget prefers stored url", stored.base, "http://saved:43118");
eq("readApiTarget prefers stored token", stored.token, "saved-token");

const down = engineDownMessage("http://127.0.0.1:43118");
check("engine message names the url", down.includes("http://127.0.0.1:43118"));
check("engine message keeps the banner phrase", down.includes("Slicer engine not running"));

eq("auth header omitted without a token", JSON.stringify(authHeaders("")), "{}");
eq(
  "auth header is a bearer token",
  JSON.stringify(authHeaders("s3cret", { "Content-Type": "application/json" })),
  JSON.stringify({ "Content-Type": "application/json", Authorization: "Bearer s3cret" }),
);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("api-base: resolution priority ok");
