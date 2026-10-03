import { parsePrusaLink, serializePrusaLink } from "./prusa-link-store.ts";
import {
  gcodeFileName,
  parsePrusaOrigin,
  readStatus,
  readUpload,
  readVersion,
  statusRequest,
  uploadRequest,
  versionRequest,
} from "./prusa-link.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

check("origin keeps the host", parsePrusaOrigin("http://printer.local/extra") === "http://printer.local");
check("a bare name is refused", parsePrusaOrigin("printer.local") === null);
check("file name is a gcode stem", gcodeFileName("20 mm cube.stl") === "20_mm_cube.gcode");

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
check("upload conflict is an error", !readUpload(409).ok);

const stored = parsePrusaLink(serializePrusaLink({ version: 1, url: "http://printer.local", apiKey: "secret", startPrint: true }));
check("settings round-trip", stored.url === "http://printer.local" && stored.apiKey === "secret" && stored.startPrint);
check("a corrupt store is empty", parsePrusaLink("nope").apiKey === "" && parsePrusaLink("nope").url === "");

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("prusa-link: requests, status, and store ok");
