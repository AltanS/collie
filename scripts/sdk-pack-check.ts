// The round trip of the pack check (scripts/sdk-pack-check.sh, M55 spec 10). It runs a small program that imports the
// INSTALLED package, `@colliepwa/durable-sdk` from a fresh project's node_modules, on Node or on Bun, and dials it with
// Collie's own adapter (`DurableMux`): hello, the snapshot, one `requireApproval` card, Allow, and the receipt the
// program prints, which must say `decidedBy: "phone"`. The shape is examples/durable-member/tests/node-child.ts.
//
//   bun scripts/sdk-pack-check.ts <project-dir> node|bun
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DurableMux, SYSTEM_CLOCK } from "../bridge/mux/durable/adapter.ts";
import { DurableSocketClient } from "../bridge/mux/durable/client.ts";
import type { DurableEventSink } from "../bridge/mux/durable/events.ts";
import type { DurableEvent } from "../bridge/mux/durable/protocol.ts";

/** The program, written into the project so it resolves the package from there, as a user's program would. */
export const PROGRAM = `import { openCollie, requireApproval, SDK_VERSION, WIRE_VERSION } from "@colliepwa/durable-sdk";
import { createCore } from "@colliepwa/durable-sdk/core";
import { NO_DESCENDANT_CHECK } from "@colliepwa/durable-sdk/node";

const warned = [];
// The socket comes from COLLIE_DURABLE_SOCKET, as for any program.
const collie = await openCollie({ hostName: "pack-check", caps: { asks: true }, warn: (line) => warned.push(line) });
const pane = collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "pack-check" });
collie.ready();
const entries = typeof createCore === "function" && NO_DESCENDANT_CHECK.length > 0;
console.log(JSON.stringify({ step: "listening", sdk: SDK_VERSION, wire: WIRE_VERSION, entries, warned }));
const approval = await requireApproval("refund", { order: "5521", amount: 40 }, { pane, toolCallId: "call-1" });
console.log(JSON.stringify({ step: "approval", approved: approval.approved, decidedBy: approval.decidedBy }));
await collie.close();
console.log(JSON.stringify({ step: "closed" }));
`;

interface Listening {
  step: "listening";
  sdk: string;
  wire: number;
  entries: boolean;
  warned: string[];
}
interface Decided {
  step: "approval";
  approved: boolean;
  decidedBy: string;
}

const noEvents: DurableEventSink = {
  apply: (_paneId: string, events: readonly DurableEvent[]) => Promise.resolve(events.length),
};

async function until<T>(what: string, read: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`pack check: timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** One round trip on one runtime. Throws with what went wrong; returns the line to print. */
export async function roundTrip(project: string, runtime: "node" | "bun", version: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "collie-sdk-pack-"));
  const socket = join(dir, "run", "app.sock");
  writeFileSync(join(project, "program.mjs"), PROGRAM);
  const child = Bun.spawn([runtime, "program.mjs"], { cwd: project, env: { ...process.env, COLLIE_DURABLE_SOCKET: socket }, stdout: "pipe", stderr: "pipe" });
  const adapter = new DurableMux(new DurableSocketClient(socket), SYSTEM_CLOCK, noEvents);
  try {
    await until("the program's hello", async () => ((await adapter.poll()).ok ? true : undefined));
    const paneId = await until("the approval card", async () => {
      const pane = (await adapter.snapshot()).panes[0];
      return pane !== undefined && (adapter.openAsks(pane.paneId)?.length ?? 0) > 0 ? pane.paneId : undefined;
    });
    const ask = adapter.openAsks(paneId)?.[0];
    if (ask === undefined) throw new Error("pack check: the approval card went away");
    const taken = await adapter.answerAsk(paneId, { requestId: crypto.randomUUID(), askId: ask.id, revision: ask.revision, optionId: "allow" });
    if (!taken.ok) throw new Error(`pack check: the answer was refused: ${JSON.stringify(taken)}`);
    const code = await child.exited;
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    if (code !== 0) throw new Error(`pack check: the program on ${runtime} exited ${code}: ${err}`);
    const lines = out.trim().split("\n");
    const listening: Listening = JSON.parse(lines[0] ?? "{}");
    const decided: Decided = JSON.parse(lines[1] ?? "{}");
    if (listening.sdk !== version || listening.wire !== 1 || !listening.entries) throw new Error(`pack check: the installed package reads wrong: ${lines[0] ?? ""}`);
    // Node has no descendant check and says so once; Bun runs the check and says nothing.
    const expectWarned = runtime === "node" ? 1 : 0;
    if (listening.warned.length !== expectWarned) throw new Error(`pack check: ${runtime} warned ${listening.warned.length} line(s), expected ${expectWarned}`);
    if (!decided.approved || decided.decidedBy !== "phone") throw new Error(`pack check: the receipt is not an Allow from the phone: ${lines[1] ?? ""}`);
    return `pack check: ${runtime} ${Bun.spawnSync([runtime, "--version"]).stdout.toString().trim()}: requireApproval allowed, decidedBy phone`;
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [project, runtime, version] = process.argv.slice(2);
  if (project === undefined || (runtime !== "node" && runtime !== "bun") || version === undefined) {
    console.error("usage: bun scripts/sdk-pack-check.ts <project-dir> node|bun <version>");
    process.exit(2);
  }
  console.log(await roundTrip(project, runtime, version));
}
