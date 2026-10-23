// One OS process of the real-harness tests (M66 spec 03, extended by spec 04): a Pi Durable session on
// durable-harness and world-local, Pi's faux model (no key, no network), a tool `mark` that is risky and appends a line
// to $DH_DIR/marks.txt, the guard of `withCollie`, and `collieRoute` on 127.0.0.1. Every event is one JSON line on
// stdout.
//
//   node --import ./register.mjs proc.mjs serve [prompt]   start the World (queue and recovery), serve the route on a
//                                                          free port, and start a session with `prompt` when given
//   node --import ./register.mjs proc.mjs take <sessionId>
//                                                          start the World and serve the route as `serve` does, then
//                                                          take the session over once (acquireHarness) and keep the
//                                                          lease open: the takeover of spike Q1. Logs {ev:"taken"}.
//
// Environment, besides DH_DIR (the data folder), DH_ROLE (a name in every line) and COLLIE_TOKEN:
//   DH_QUEUE=0       serve the route only: the World is never started, so this process runs no queue and no recovery
//   DH_TOOL_MS=n     `mark` takes n ms; DH_TOOL_ORDER=before|after (default after) writes its line before or after the wait
//   DH_FILL=n        after listening, start one session and run n chat turns in it (two entries each)
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { createWorld } from "@workflow/world-local";
import { getWorld } from "durable-harness";
import { acquireHarness, resumeWith } from "durable-harness/pi-durable";
import { collieRoute, withCollie } from "../../../../packages/durable-sdk/src/durable-harness/index.ts";

const DIR = process.env.DH_DIR;
const ROLE = process.env.DH_ROLE ?? "?";
process.env.WORKFLOW_LOCAL_DATA_DIR = join(DIR, ".workflow-data");
process.env.WORKFLOW_TARGET_WORLD = "local";
const log = (ev, fields = {}) => console.log(JSON.stringify({ ev, role: ROLE, ...fields }));
process.on("unhandledRejection", (e) => log("unhandled", { message: String(e?.message ?? e).slice(0, 300) }));

const textOf = (c) => (typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""));
function scripted(messages) {
  const last = messages.at(-1);
  if (last.role === "user" && textOf(last.content).startsWith("chat:")) return fauxAssistantMessage([fauxText(`ok ${textOf(last.content).slice(5, 30)}`)]);
  if (last.role === "user") return fauxAssistantMessage([fauxText("I will mark it."), fauxToolCall("mark", { note: textOf(last.content).slice(0, 40) })], { stopReason: "toolUse" });
  if (last.role === "toolResult") return fauxAssistantMessage([fauxText(`Done: ${textOf(last.content)}`)]);
  return fauxAssistantMessage([fauxText("ok")]);
}
const faux = fauxProvider({ tokensPerSecond: 400, tokenSize: { min: 3, max: 5 } });
const models = createModels();
models.setProvider(faux.provider);
const factory = async (context) => {
  faux.appendResponses([factory]);
  return scripted(context.messages);
};
faux.setResponses(Array.from({ length: 8 }, () => factory));
const MODEL = { provider: "faux", modelId: "faux-1" };

const mark = defineTool({
  name: "mark",
  description: "Append a line to the marks file.",
  parameters: Type.Object({ note: Type.String() }),
  execute: async (args) => {
    const write = () => appendFileSync(join(DIR, "marks.txt"), `${ROLE} ${args.note}\n`);
    const wait = Number(process.env.DH_TOOL_MS ?? 0);
    const before = process.env.DH_TOOL_ORDER === "before";
    log("tool-start", { note: args.note });
    if (before) write();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (!before) write();
    log("tool-ran", { note: args.note });
    const content = [{ type: "text", text: `marked by ${ROLE}` }];
    return { content, output: content };
  },
});
const registry = createRegistry();
registry.install(defineExtension({ name: "example-tools", tools: [mark] }));

const open = resumeWith(withCollie((storage, reg) => Harness.open(storage, { models, registry: reg }, ctx), { registry, risky: new Set(["mark"]), pollMs: { first: 50, max: 200 } }));
// DH_QUEUE=0: a process that only serves the route. It reads the log through a World that is never started, so it
// runs no queue and no recovery. A send it takes cannot be driven here.
let world;
if (process.env.DH_QUEUE === "0") world = createWorld({ dataDir: process.env.WORKFLOW_LOCAL_DATA_DIR });
else await getWorld(); // world-local: the queue in this process, and the recovery of sessions left unfinished
const route = collieRoute({ open, token: process.env.COLLIE_TOKEN, ...(world === undefined ? {} : { world }) });

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const reply = await route(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, ...(body === undefined ? {} : { body }) }));
  res.writeHead(reply.status, Object.fromEntries(reply.headers));
  res.end(Buffer.from(await reply.arrayBuffer()));
});
server.listen(0, "127.0.0.1", () => log("listening", { port: server.address().port }));

const prompt = process.argv[3];
if (process.argv[2] === "serve" && prompt !== undefined) {
  const lease = await acquireHarness(undefined, open);
  log("session", { id: lease.storage.sessionId });
  const root = await lease.harness.root(ctx, { agent: { model: MODEL, instructions: "test" } });
  await root.submit({ type: "input", content: prompt, requestId: "r1" }, ctx);
  lease.harness.waitForIdle(ctx).then(() => log("idle"), (e) => log("idle-failed", { message: String(e?.message).slice(0, 200) }));
}
if (process.argv[2] === "take") {
  const lease = await acquireHarness(process.argv[3], open); // the takeover: A's storage is fenced from here on
  log("taken", { id: lease.storage.sessionId });
}
const fill = Number(process.env.DH_FILL ?? 0);
if (fill > 0) {
  const lease = await acquireHarness(undefined, open);
  const root = await lease.harness.root(ctx, { agent: { model: MODEL, instructions: "test" } });
  for (let i = 1; i <= fill; i++) {
    await root.submit({ type: "input", content: `chat: turn ${i}`, requestId: `fill-${i}` }, ctx);
    await lease.harness.waitForIdle(ctx);
  }
  log("filled", { id: lease.storage.sessionId, turns: fill });
}
setInterval(() => {}, 1 << 30);
