import { parseLegacyPrusaLink } from "./prusa-link.ts";
import {
  busyMessage,
  gcodeFileName,
  hostProblem,
  isPrinterBusy,
  parsePrusaOrigin,
  readStatus,
  readUpload,
  readVersion,
  sendGcode,
  statusRequest,
  uploadRequest,
  versionRequest,
  type PrusaFetch,
  type PrusaLinkRequest,
} from "./prusa-link.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

check("origin keeps the host", parsePrusaOrigin("http://printer.local/extra") === "http://printer.local");
check("a bare name is refused", parsePrusaOrigin("printer.local") === null);
check("an empty host is named", hostProblem("  ") === "Add a Prusa Link host on this printer first.");
check("a bad host is named", hostProblem("printer.local") === "That host is not a Prusa Link URL. Use http:// or https:// and a host name.");
check("a good host has no problem", hostProblem("http://printer.local") === null);
check("file name is a gcode stem", gcodeFileName("20 mm cube.stl") === "20_mm_cube.gcode");
check("printing, busy, and paused block a start", isPrinterBusy("PRINTING") && isPrinterBusy("busy") && isPrinterBusy("Paused") && !isPrinterBusy("IDLE"));

const version = versionRequest("http://printer.local", "secret");
check("version is a keyed GET", version.method === "GET" && version.url === "http://printer.local/api/version" && version.headers["X-Api-Key"] === "secret");
const upload = uploadRequest("http://printer.local", "secret", "part.gcode", "G1 X1\n", true);
check("upload is a PUT of the gcode", upload.method === "PUT" && upload.url.endsWith("/api/v1/files/local/part.gcode") && upload.body === "G1 X1\n");
check("start print sets the Prusa header", upload.headers["Print-After-Upload"] === "?1" && upload.headers["Overwrite"] === "?1");
check("holding the print leaves the header off", uploadRequest("http://printer.local", "secret", "part.gcode", "G1", false).headers["Print-After-Upload"] === "?0");
check("status is the telemetry route", statusRequest("http://printer.local", "secret").url === "http://printer.local/api/v1/status");

const linked = readVersion(200, JSON.stringify({ api: "1.0.0", version: "0.7.0", printer: "1", text: "PrusaLink 0.7.0", firmware: "1" }));
check("version text is the summary", linked.ok && linked.summary === "PrusaLink 0.7.0");
const refused = readVersion(401, "");
check("a refused key is named", !refused.ok && refused.message === "Prusa Link refused the API key.");
const job = readStatus(200, JSON.stringify({ printer: { state: "PRINTING" }, job: { progress: 42.2, time_remaining: 520 } }));
check("job status names state, progress, and time", job.ok && job.summary === "PRINTING · 42% · 9 min left");
const created = readUpload(201);
check("upload created is success", created.ok && created.summary === "Uploaded.");
const conflict = readUpload(409);
check("upload conflict is the printer busy with that file", !conflict.ok && conflict.message === "The printer is busy with that file and would not replace it.");

const stored = parseLegacyPrusaLink(JSON.stringify({ version: 1, url: "http://printer.local", apiKey: "secret", startPrint: true }));
check("legacy settings parse", stored?.url === "http://printer.local" && stored.apiKey === "secret" && stored.startPrint);
check("a corrupt legacy store is dropped", parseLegacyPrusaLink("nope") === null);

const seen: PrusaLinkRequest[] = [];
const mock: PrusaFetch = async (request) => {
  seen.push(request);
  if (request.url.endsWith("/api/v1/status")) {
    const prior = seen.filter((row) => row.url.endsWith("/api/v1/status")).length;
    if (prior === 1) return { status: 200, text: JSON.stringify({ printer: { state: "IDLE" } }) };
    return { status: 200, text: JSON.stringify({ printer: { state: "PRINTING" }, job: { progress: 10, time_remaining: 60 } }) };
  }
  if (request.method === "PUT") return { status: 201, text: "" };
  return { status: 500, text: "" };
};
const sent = await sendGcode({ url: "http://printer.local/extra", apiKey: "secret", startPrint: true }, "part.gcode", "G1 X1\n", mock);
check("send reports the job after upload", sent.ok && sent.summary === "Uploaded. PRINTING · 10% · 1 min left");
const put = seen.find((row) => row.method === "PUT");
check(
  "mock fetch received the Prusa upload",
  put?.url === "http://printer.local/api/v1/files/local/part.gcode" && put.body === "G1 X1\n" && put.headers["X-Api-Key"] === "secret" && put.headers["Print-After-Upload"] === "?1" && put.headers["Content-Type"] === "text/x.gcode",
);

const busyCalls: string[] = [];
const busyFetch: PrusaFetch = async (request) => {
  busyCalls.push(request.method);
  return { status: 200, text: JSON.stringify({ printer: { state: "PRINTING" }, job: { progress: 3, time_remaining: 90 } }) };
};
const busy = await sendGcode({ url: "http://printer.local", apiKey: "secret", startPrint: true }, "part.gcode", "G1", busyFetch);
check("a printing printer is not started", !busy.ok && busy.message === busyMessage("PRINTING"));
check("upload is not sent while the printer is busy", busyCalls.length === 1 && busyCalls[0] === "GET");

const auth = await sendGcode({ url: "http://printer.local", apiKey: "nope", startPrint: false }, "part.gcode", "G1", async () => ({ status: 401, text: "" }));
check("an upload auth failure is named", !auth.ok && auth.message === "Prusa Link refused the API key.");

const down = await sendGcode({ url: "http://printer.local", apiKey: "secret", startPrint: false }, "part.gcode", "G1", async () => {
  throw new Error("Failed to fetch");
});
check("a thrown fetch is a network failure", !down.ok && down.message.startsWith("Could not reach Prusa Link at http://printer.local"));

const missing = await sendGcode({ url: "", apiKey: "", startPrint: false }, "part.gcode", "G1", async () => ({ status: 201, text: "" }));
check("a missing host is refused before fetch", !missing.ok && missing.message === "Add a Prusa Link host on this printer first.");

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("prusa-link: requests, status, and mocked send ok");
