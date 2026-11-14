/**
 * Interface text an agent reads for three tasks, before discovery and now (docs/plan-mcp-discovery.md D6). Tokens are
 * UTF-8 bytes / 4, rounded up, as in schema.test.ts. "Before" lists are fixed numbers measured on bfa4c0fa (the old
 * code is not in this tree); every guide reply is measured live, since guide {kind} and {topic} did not change.
 * Run: node --experimental-strip-types mcp/bench/discovery-cost.ts
 */
import { fakeEngine } from "../engine.ts";
import { handleRpc } from "../protocol.ts";
import { Session } from "../session.ts";

const tokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 4);

// Measured on bfa4c0fa with listedTools and the initialize reply.
const BEFORE = { instructions: 378, firstList: 5_649, modelGroup: 6_998, toolsEnableReply: 154 };

const session = new Session(fakeEngine());
const init = await handleRpc(session, { id: 1, method: "initialize", params: {} }) as { result: { instructions: string } };
const list = await handleRpc(session, { id: 2, method: "tools/list" }) as { result: unknown };
const firstContact = tokens(init.result.instructions) + tokens(JSON.stringify(list.result));

async function reply(args: Record<string, unknown>): Promise<number> {
  return tokens(JSON.stringify(await session.call("guide", args)));
}

/** What wrapping one call in call {tool, args} adds to the agent's own request. */
function wrapper(tool: string): number {
  return tokens(JSON.stringify({ tool, args: {} })) - tokens("{}");
}

interface Task { name: string; before: { label: string; tokens: number }[]; now: Record<string, unknown>[]; calls: string[] }

const tasks: Task[] = [
  {
    name: "Slice an imported mesh",
    before: [{ label: "instructions + first list", tokens: BEFORE.instructions + BEFORE.firstList }],
    now: [{ topic: "slice" }],
    calls: ["mesh_import", "machine_list", "machine_select", "slice_start", "slice_wait", "gcode_summary", "gcode_export"],
  },
  {
    name: "Build and edit a small model",
    before: [
      { label: "instructions + first list", tokens: BEFORE.instructions + BEFORE.firstList },
      { label: "tools_enable model + re-read list", tokens: BEFORE.toolsEnableReply + BEFORE.modelGroup },
      { label: "guide {kind:hole}", tokens: await reply({ kind: "hole" }) },
      { label: "guide {kind:fillet}", tokens: await reply({ kind: "fillet" }) },
    ],
    now: [{ query: "build a part" }, { tool: "model_build" }, { kind: "hole" }, { kind: "fillet" }, { tool: "model_edit" }],
    calls: ["model_build", "model_edit", "model_check"],
  },
  {
    name: "Couple and turn a gear train",
    before: [
      { label: "instructions + first list", tokens: BEFORE.instructions + BEFORE.firstList },
      { label: "tools_enable model + re-read list", tokens: BEFORE.toolsEnableReply + BEFORE.modelGroup },
      { label: "guide {kind:gear}", tokens: await reply({ kind: "gear" }) },
      { label: "guide {kind:assembly}", tokens: await reply({ kind: "assembly" }) },
      { label: "guide {kind:pose}", tokens: await reply({ kind: "pose" }) },
    ],
    now: [{ query: "gear train" }, { kind: "gear" }, { kind: "assembly" }, { kind: "pose" }, { tool: "model_place" }, { tool: "pose_animate" }],
    calls: ["model_build", "model_build", "model_place", "model_place", "model_place", "model_place", "pose_animate"],
  },
];

console.log(`first contact now: ${firstContact} (before: ${BEFORE.instructions + BEFORE.firstList})`);
for (const task of tasks) {
  const before = task.before.reduce((sum, row) => sum + row.tokens, 0);
  const rows: string[] = [];
  let now = firstContact;
  for (const args of task.now) {
    const size = await reply(args);
    now += size;
    rows.push(`guide ${JSON.stringify(args)} ${size}`);
  }
  const wrap = task.calls.reduce((sum, tool) => sum + wrapper(tool), 0);
  now += wrap;
  console.log(`\n${task.name}: before ${before}, now ${now} (${Math.round((100 * now) / before)}%)`);
  console.log(`  before: ${task.before.map((row) => `${row.label} ${row.tokens}`).join("; ")}`);
  console.log(`  now: first contact ${firstContact}; ${rows.join("; ")}; ${task.calls.length} call wrappers ${wrap}`);
}
process.exit(0);
