// The agent of the example: a small shipping desk on Pi, durable on Vercel's durable-harness.
//
//   ship   risky: appends a line to shipped.txt. The phone must allow it, so it shows as a card.
//   stock  safe: answers at once, with no question.
//
// The model is Pi's faux provider by default, so the example needs no key. PI_MODEL=<OpenRouter model id> with
// OPENROUTER_API_KEY in the environment uses a real one. Pi reads the key, this file never does.
import { appendFileSync } from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { resumeWith } from "durable-harness/pi-durable";
import { withCollie } from "../../../packages/durable-sdk/src/durable-harness/index.ts";
import { SHIPPED_FILE } from "./env.ts";

export const INSTRUCTIONS = "You run the shipping desk of a small online shop. Use ship to send an order and stock to look up stock.";

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : (Array.isArray(content) ? content : []).filter((b) => b?.type === "text").map((b) => String(b.text)).join("");

/** The faux model's script: a message that says "ship" calls ship, one that says "stock" calls stock, any other is answered. */
function scripted(messages: readonly { role: string; content?: unknown }[]) {
  const last = messages.at(-1);
  const said = textOf(last?.content);
  if (last?.role === "user") {
    if (/ship/i.test(said)) return fauxAssistantMessage([fauxText("I will ship it."), fauxToolCall("ship", { item: said.slice(0, 60) })], { stopReason: "toolUse" });
    if (/stock/i.test(said)) return fauxAssistantMessage([fauxText("Let me look."), fauxToolCall("stock", { item: said.slice(0, 60) })], { stopReason: "toolUse" });
    return fauxAssistantMessage([fauxText(`Noted: ${said.slice(0, 80)}`)]);
  }
  if (last?.role === "toolResult") return fauxAssistantMessage([fauxText(`Done: ${said}`)]);
  return fauxAssistantMessage([fauxText("ok")]);
}

const models = createModels();
let model = { provider: "faux", modelId: "faux-1" };
const real = process.env.PI_MODEL;
if (real === undefined || real === "") {
  const faux = fauxProvider({ tokensPerSecond: 400, tokenSize: { min: 3, max: 5 } });
  models.setProvider(faux.provider);
  // A response is a function of the conversation so far, and puts itself back in the queue, so the script never runs out.
  const response: Parameters<typeof faux.setResponses>[0][number] = async (context) => {
    faux.appendResponses([response]);
    return scripted(context.messages);
  };
  faux.setResponses(Array.from({ length: 8 }, () => response));
} else {
  const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
  models.setProvider(openrouterProvider());
  if (models.getModel("openrouter", real) === undefined) throw new Error(`PI_MODEL ${real} is not an OpenRouter model id that Pi knows`);
  if ((await models.getAuth("openrouter")) === undefined) throw new Error("PI_MODEL is set, but Pi finds no OpenRouter key. Set OPENROUTER_API_KEY");
  model = { provider: "openrouter", modelId: real };
}
/** The model a new session starts with. */
export const MODEL = model;

const ship = defineTool({
  name: "ship",
  description: "Ship an order. Appends a line to shipped.txt.",
  parameters: Type.Object({ item: Type.String() }),
  execute: async (args) => {
    appendFileSync(SHIPPED_FILE, `${new Date().toISOString()} ${args.item}\n`);
    const content = [{ type: "text" as const, text: `shipped: ${args.item}` }];
    return { content, output: content };
  },
});

const stock = defineTool({
  name: "stock",
  description: "Look up the stock of an item.",
  parameters: Type.Object({ item: Type.String() }),
  execute: async (args) => {
    const content = [{ type: "text" as const, text: `12 in stock: ${args.item}` }];
    return { content, output: content };
  },
});

export const registry = createRegistry();
registry.install(defineExtension({ name: "desk-tools", tools: [ship, stock] }));

/** The name of the opener. Every route and every `acquireHarness` that opens a desk session passes it. */
export const NAME = "desk";

/**
 * The one line Collie needs: `withCollie` wraps your opener, so a risky call asks the phone first. `resumeWith` is
 * durable-harness's own: it tells the queue how to reopen a session that a crash left unfinished.
 */
export const open = resumeWith(
  withCollie((storage, reg) => Harness.open(storage, { models, registry: reg }, ctx), { registry, risky: new Set(["ship"]), timeoutMs: 10 * 60_000 }),
  { name: NAME },
);
