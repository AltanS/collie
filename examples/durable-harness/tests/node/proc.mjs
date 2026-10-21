// One OS process of the real-harness tests (M66 spec 03, extended by spec 04): a Pi Durable session on
// durable-harness and world-local, Pi's faux model (no key, no network), a tool `mark` that is risky and appends a line
// to $DH_DIR/marks.txt, the guard of `withCollie`, and `collieRoute` on 127.0.0.1. Every event is one JSON line on
// stdout.
//
//   node --import ./register.mjs proc.mjs serve [prompt]   start the World (queue and recovery), serve the route on a
//                                                          free port, and start a session with `prompt` when given
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
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
    appendFileSync(join(DIR, "marks.txt"), `${ROLE} ${args.note}\n`);
    log("tool-ran", { note: args.note });
    const content = [{ type: "text", text: `marked by ${ROLE}` }];
    return { content, output: content };
  },
});
const registry = createRegistry();
registry.install(defineExtension({ name: "example-tools", tools: [mark] }));

const open = resumeWith(withCollie((storage, reg) => Harness.open(storage, { models, registry: reg }, ctx), { registry, risky: new Set(["mark"]), pollMs: { first: 50, max: 200 } }));
await getWorld(); // world-local: the queue in this process, and the recovery of sessions left unfinished
const route = collieRoute({ open, token: process.env.COLLIE_TOKEN });

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
setInterval(() => {}, 1 << 30);
