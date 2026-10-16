/**
 * MCP over stdio. Content-Length framing, and one raw JSON message for tests.
 * Logs stay off stdout.
 */
import { TOOLS } from "./schema.ts";
import type { Session } from "./session.ts";

const VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];

export interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROMPTS = [
  {
    name: "slice-for-machine",
    description: "Import a mesh, pick a printer and filament, slice, and report time and grams. Do not send it to a printer.",
  },
  {
    name: "hole-on-face",
    description: "Describe the solid, set a face workplane, probe a through hole, and apply only if the probe fits.",
  },
  {
    name: "split-fillet-export",
    description: "Probe a split, apply it, probe a fillet on an edge from model_describe, export STEP, then slice.",
  },
  {
    name: "explain-slice-failure",
    description: "Read lime://slice/latest and the warnings, then propose one next tool call.",
  },
];

export async function handleRpc(session: Session, message: RpcMessage): Promise<Record<string, unknown> | null> {
  const id = message.id ?? null;
  const method = message.method ?? "";
  const params = message.params ?? {};
  if (method.startsWith("notifications/")) return null;
  try {
    if (method === "initialize") {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = VERSIONS.includes(asked) ? asked : "2024-11-05";
      return result(id, { protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "lime-slice", version: "1.8.0" } });
    }
    if (method === "ping") return result(id, {});
    if (method === "tools/list") {
      return result(id, { tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
    }
    if (method === "tools/call") {
      const name = String(params.name ?? "");
      const args = params.arguments ?? {};
      try {
        const value = await session.call(name, args);
        return result(id, { content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
      } catch (err) {
        const text = err instanceof Error ? err.message : "The tool failed.";
        return result(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    if (method === "resources/list") {
      return result(id, {
        resources: [
          "lime://session",
          "lime://machines",
          "lime://project",
          "lime://slice/latest",
          "lime://gcode/latest/summary",
          ...session.objects.map((obj) => `lime://object/${obj.id}/history`),
        ].map((uri) => ({ uri, name: uri, mimeType: "application/json" })),
      });
    }
    if (method === "resources/read") {
      const uri = String(params.uri ?? "");
      const body = session.resource(uri);
      return result(id, { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(body) }] });
    }
    if (method === "prompts/list") return result(id, { prompts: PROMPTS });
    if (method === "prompts/get") {
      const name = String(params.name ?? "");
      const prompt = PROMPTS.find((row) => row.name === name);
      if (!prompt) return error(id, -32602, "That prompt is not on this server.");
      return result(id, { description: prompt.description, messages: [{ role: "user", content: { type: "text", text: prompt.description } }] });
    }
    return error(id, -32601, "That method is not on this server.");
  } catch (err) {
    return error(id, -32603, err instanceof Error ? err.message : "The request failed.");
  }
}

function result(id: number | string | null, value: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id: number | string | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function writeMessage(message: Record<string, unknown>): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

export function serve(session: Session, input: NodeJS.ReadableStream = process.stdin): void {
  let buffer = Buffer.alloc(0);
  input.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (buffer[0] === 0x7b) {
          try {
            const message = JSON.parse(buffer.toString("utf8")) as RpcMessage;
            buffer = Buffer.alloc(0);
            void handleRpc(session, message).then((reply) => {
              if (reply) writeMessage(reply);
            });
          } catch {
            return;
          }
        }
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const body = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      void handleRpc(session, JSON.parse(body) as RpcMessage).then((reply) => {
        if (reply) writeMessage(reply);
      });
    }
  });
}
