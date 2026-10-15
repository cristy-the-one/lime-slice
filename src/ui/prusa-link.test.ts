import { parseLegacyPrusaLink } from "./prusa-link.ts";
import {
  busyMessage,
  gcodeFileName,
  hostProblem,
  isPrinterBusy,
  keyProblem,
  moonrakerConfigRequest,
  parsePrusaOrigin,
  readMoonrakerConfig,
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

// Moonraker (Klipper) tests
check("Moonraker allows an empty API key", keyProblem("", "moonraker") === null);
check("OctoPrint requires an API key", keyProblem("", "octoprint") === "Add the OctoPrint API key for this printer.");
const moonVersionReq = versionRequest("http://voron.local:7125", "", "moonraker");
check(
  "Moonraker version queries /printer/info without an empty key header",
  moonVersionReq.method === "GET" && moonVersionReq.url === "http://voron.local:7125/printer/info" && !("X-Api-Key" in moonVersionReq.headers),
);
const moonVersion = readVersion(200, JSON.stringify({ result: { state: "ready", software_version: "v0.12.0-114" } }), "moonraker");
check("Moonraker version summary names Klipper and state", moonVersion.ok && moonVersion.summary === "Klipper v0.12.0-114 · ready");

const moonUpload = uploadRequest("http://voron.local:7125", "", "cube.gcode", "G28\nG1 X10\n", true, "moonraker");
check(
  "Moonraker upload is a multipart POST to /server/files/upload",
  moonUpload.method === "POST" &&
    moonUpload.url === "http://voron.local:7125/server/files/upload" &&
    moonUpload.headers["Content-Type"]?.startsWith("multipart/form-data; boundary=") === true &&
    moonUpload.body?.includes('name="root"\r\n\r\ngcodes\r\n') === true &&
    moonUpload.body?.includes('name="print"\r\n\r\ntrue\r\n') === true &&
    moonUpload.body?.includes('filename="cube.gcode"') === true &&
    moonUpload.body?.includes("G28\nG1 X10\n") === true,
);

const moonSeen: PrusaLinkRequest[] = [];
const moonSent = await sendGcode(
  { url: "http://voron.local:7125", apiKey: "", startPrint: true, hostType: "moonraker" },
  "cube.gcode",
  "G28\n",
  async (req) => {
    moonSeen.push(req);
    if (req.url.includes("/printer/objects/query")) {
      const first = moonSeen.filter((r) => r.url.includes("/printer/objects/query")).length === 1;
      return {
        status: 200,
        text: JSON.stringify({
          result: {
            status: {
              print_stats: { state: first ? "standby" : "printing", print_duration: 120 },
              virtual_sdcard: { progress: first ? 0 : 0.25 },
            },
          },
        }),
      };
    }
    if (req.method === "POST" && req.url.endsWith("/server/files/upload")) {
      return { status: 201, text: JSON.stringify({ item: { path: "cube.gcode" } }) };
    }
    return { status: 500, text: "" };
  },
);
check("Moonraker sendGcode checks standby, uploads multipart, and reports printing status", moonSent.ok && moonSent.summary === "Uploaded. PRINTING · 25% · 6 min left");

// Moonraker printer.cfg import
const cfgReq = moonrakerConfigRequest("http://voron.local:7125", "");
check("Moonraker config request queries configfile=settings", cfgReq.url === "http://voron.local:7125/printer/objects/query?configfile=settings");
const parsedCfg = readMoonrakerConfig(
  200,
  JSON.stringify({
    result: {
      status: {
        configfile: {
          settings: {
            printer: {
              max_velocity: 500,
              max_accel: 12000,
              square_corner_velocity: 8,
              minimum_cruise_ratio: 0.4,
              max_z_velocity: 25,
              max_z_accel: 350,
            },
            extruder: {
              instantaneous_corner_velocity: 1.5,
              nozzle_diameter: 0.6,
              filament_diameter: 1.75,
              max_temp: 310,
            },
            heater_bed: {
              max_temp: 115,
            },
            stepper_x: { position_max: 350 },
            stepper_y: { position_max: 350 },
            stepper_z: { position_max: 330 },
          },
        },
      },
    },
  }),
);
check("a printer.cfg without [gcode_arcs] reads as arcs off", parsedCfg.ok && parsedCfg.config.firmwareArcs === false && parsedCfg.config.summary.includes("arcs off (no [gcode_arcs])"));
const arcCfg = readMoonrakerConfig(200, JSON.stringify({ result: { status: { configfile: { settings: { printer: { max_velocity: 300 }, gcode_arcs: { resolution: 0.1 } } } } } }));
check("a printer.cfg with [gcode_arcs] reads as arcs on", arcCfg.ok && arcCfg.config.firmwareArcs === true && arcCfg.config.summary === "Imported printer.cfg (300 mm/s · arcs on ([gcode_arcs]))");
check(
  "Moonraker printer.cfg parses kinematic limits, bed size, nozzle, and temperature caps",
  parsedCfg.ok &&
    parsedCfg.config.limits.maxVelocity === 500 &&
    parsedCfg.config.limits.maxAccel === 12000 &&
    parsedCfg.config.limits.squareCornerVelocity === 8 &&
    parsedCfg.config.limits.minimumCruiseRatio === 0.4 &&
    parsedCfg.config.limits.extruderCornerVelocity === 1.5 &&
    parsedCfg.config.limits.maxZVelocity === 25 &&
    parsedCfg.config.limits.maxZAccel === 350 &&
    parsedCfg.config.geometry.bedX === 350 &&
    parsedCfg.config.geometry.bedY === 350 &&
    parsedCfg.config.geometry.bedZ === 330 &&
    parsedCfg.config.geometry.nozzleDiameter === 0.6 &&
    parsedCfg.config.geometry.maxNozzleC === 310 &&
    parsedCfg.config.geometry.maxBedC === 115,
);

// OctoPrint tests
const octoJob = readStatus(
  200,
  JSON.stringify({ state: "Printing", progress: { completion: 50.4, printTimeLeft: 300 } }),
  "octoprint",
);
check("OctoPrint job status parses state, completion, and remaining time", octoJob.ok && octoJob.summary === "PRINTING · 50% · 5 min left");
const octoUpload = uploadRequest("http://octopi.local", "octo-key", "benchy.gcode", "G28\n", true, "octoprint");
check(
  "OctoPrint upload is a multipart POST to /api/files/local",
  octoUpload.method === "POST" &&
    octoUpload.url === "http://octopi.local/api/files/local" &&
    octoUpload.headers["X-Api-Key"] === "octo-key" &&
    octoUpload.body?.includes('name="select"\r\n\r\ntrue\r\n') === true &&
    octoUpload.body?.includes('name="print"\r\n\r\ntrue\r\n') === true,
);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("prusa-link: requests, status, and mocked send ok");
