// A small Pi Durable program with the Collie SDK inside. It triages made-up support tickets, and a
// Collie peer with COLLIE_MUX=durable shows each conversation as a pane.
//   bun app.ts
// The README lists every environment variable. The model is Pi's faux model, scripted, so no key is
// needed. REAL_MODEL=<OpenRouter model id> uses a real one through OpenRouter ($OPENROUTER_API_KEY).

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type Conversation,
  type ConversationId,
  createRegistry,
  type Cursor,
  defineExtension,
  defineTool,
  type Extension,
  Harness,
  MemoryStorage,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { type Collie, openCollie, SOCKET_ENV } from "./sdk/index.ts";
import { PaneRegistry, riskGuard, showConversation, spawnHelperTool } from "./pi-durable/index.ts";
import { INSTRUCTIONS, REAL_INSTRUCTIONS, useScriptedModel } from "./script.ts";

export interface AppOptions {
  /** The Unix socket path. Absolute, at most 103 bytes. */
  socket: string;
  /** A directory for durable storage, or "memory". */
  storage: string;
  stepMs?: number; // pause before each scripted model answer, so states are visible
  slowMs?: number; // the slow answer to a follow-up, long enough to stop it
  helperMs?: number; // the helper's answer takes this long (default: stepMs), so a test can kill the app mid-answer
  /** Where `write_note` appends. */
  notesFile: string;
  /** `descendant` (default) or `off`. An in-process test is the program's own caller, so it turns the check off. */
  callerCheck?: "descendant" | "off";
  /** Open one ticket when the storage holds no conversation yet, so a first start has an ask to answer. Default true. */
  seed?: boolean;
}

export interface App {
  collie: Collie;
  harness: Harness;
  close(): Promise<void>;
}

export async function startApp(o: AppOptions): Promise<App> {
  const stepMs = o.stepMs ?? 400;
  const slowMs = o.slowMs ?? 10_000;

  // The model: faux by default, the scripted one in script.ts. REAL_MODEL is an OpenRouter model id, off by default.
  const models = createModels();
  let model = { provider: "faux", modelId: "faux-1" };
  const real = process.env.REAL_MODEL; // an OpenRouter model id, e.g. google/gemini-3.1-flash-lite. Off by default.
  if (real) {
    const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
    models.setProvider(openrouterProvider()); // reads OPENROUTER_API_KEY, never logged here
    if (!models.getModel("openrouter", real)) throw new Error(`REAL_MODEL ${real} is not an OpenRouter model id Pi knows`);
    model = { provider: "openrouter", modelId: real };
  } else {
    useScriptedModel(models, { stepMs, slowMs, helperMs: o.helperMs });
  }

  // Tools and layout.
  const notes = o.notesFile;
  mkdirSync(dirname(notes), { recursive: true, mode: 0o700 });
  const collie = await openCollie({ socket: o.socket, hostName: "durable-member", callerCheck: o.callerCheck });
  const ws = collie.workspace("triage", { title: "Triage", cwd: "/srv/triage" });
  const inbox = ws.tab("inbox", { title: "Inbox" });
  const helpers = ws.tab("helpers", { title: "Helpers" });

  const panes = new PaneRegistry();
  let harness!: Harness;
  const writeNote = defineTool({
    name: "write_note",
    description: "Save a note about the ticket.",
    parameters: Type.Object({ note: Type.String() }),
    execute: async (args) => {
      appendFileSync(notes, `${new Date().toISOString()} ${args.note}\n`);
      return { content: [{ type: "text", text: "note saved" }] };
    },
  });
  const triageTools: Extension = defineExtension({
    name: "triage-tools",
    tools: [writeNote, spawnHelperTool({ panes, harness: () => harness, tab: helpers, model, without: () => [triageTools] })],
  });
  const registry = createRegistry();
  registry.install(triageTools);
  const risky = new Set(["write_note"]);
  registry.install(riskGuard({ panes, risky }));

  const storage: Storage = o.storage === "memory" ? new MemoryStorage() : await openNodeJsonlStorage(o.storage, ctx);
  harness = await Harness.open(storage, { models, registry, onReport: (e) => console.error("pi-durable report:", e) }, ctx);

  // Show every conversation that exists (a restart), BEFORE resume(), so a re-run hook finds its pane.
  const all: { id: ConversationId; owned: boolean }[] = [];
  let cursor: Cursor | undefined;
  do {
    const at = cursor;
    const page = await harness.commit((tx) => tx.scanConversations({}, 256, at), ctx);
    for (const c of page.items) all.push({ id: c.id, owned: c.owner !== undefined });
    cursor = page.next;
  } while (cursor);
  for (const c of all) {
    const conversation = (await harness.conversation(c.id, ctx))!;
    await show(conversation, c.owned);
  }

  async function show(conversation: Conversation, owned: boolean) {
    const tab = owned ? helpers : inbox;
    const title = `${owned ? "Helper" : "Ticket"} #${conversation.id}`;
    return showConversation({ tab, title }, harness, conversation, { panes });
  }

  let tickets = 0;
  const instructions = real ? REAL_INSTRUCTIONS : INSTRUCTIONS;
  const startTriage = (prefix: string) => async () => {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, instructions } }, ctx);
    const pane = await show(conversation, false);
    tickets++;
    await conversation.submit({ type: "input", content: `${prefix}Triage ticket ${400 + tickets}: a customer cannot log in.` }, ctx);
    return { paneId: pane.id };
  };
  collie.starters([
    { id: "new-triage", label: "New triage", run: startTriage("") },
    { id: "two-notes", label: "Two notes at once (faux only)", run: startTriage("TWO: ") },
  ]);

  // A first start opens one ticket, so the phone has something to show and one ask to answer.
  // Later starts show what the storage holds, as a durable program should.
  if ((o.seed ?? true) && all.length === 0) await startTriage("")();

  // Continue any run the last process left unfinished, and wait for the asks it raises again: Pi re-runs a
  // waiting hook, which asks under the same id (the SDK derives it from the tool call). Only then is the layout
  // complete, so the first snapshot after a restart carries every open ask.
  const reRaised = panes.reRaised(risky);
  harness.resume();
  await reRaised;
  collie.ready(); // the layout is complete: only now may Collie see a snapshot

  return {
    collie,
    harness,
    close: async () => {
      // Stop the server first, and leave open asks open: a shutdown is not an answer. Then stop the
      // event streams and close the harness. A hook that waits for the phone does not hold the close
      // up, and no result is written for it (observed). The ask is raised again on the next start.
      await collie.close();
      await panes.close();
      await harness.close(ctx);
    },
  };
}

/** The settings of `bun app.ts`, from the environment. Every variable is optional. */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): AppOptions {
  // The socket's folder must be private to this user, so the fallback carries the uid.
  const runtime = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "durable-member") : `/tmp/durable-member-${process.getuid?.() ?? "user"}`;
  const data = env.DM_DATA || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "durable-member");
  const ms = (name: string) => {
    const v = env[name];
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a whole number of milliseconds, not ${JSON.stringify(v)}`);
    return n;
  };
  const check = env.DM_CALLER_CHECK;
  if (check !== undefined && check !== "" && check !== "off" && check !== "descendant") {
    throw new Error(`DM_CALLER_CHECK must be "off" or "descendant", not ${JSON.stringify(check)}`);
  }
  return {
    socket: env[SOCKET_ENV] || join(runtime, "app.sock"),
    storage: join(data, "store"),
    notesFile: join(data, "notes.txt"),
    stepMs: ms("DM_STEP_MS"),
    slowMs: ms("DM_SLOW_MS"),
    helperMs: ms("DM_HELPER_MS"),
    callerCheck: check === "off" ? "off" : "descendant",
  };
}

/**
 * Why this platform cannot run with these options, or undefined. The descendant defence reads the
 * caller's pid off the socket (SO_PEERCRED) and walks /proc, and only Linux has both. Elsewhere the
 * app runs only when the person turns the defence off by name.
 */
export function platformProblem(o: Pick<AppOptions, "callerCheck">, platform: string = process.platform): string | undefined {
  if (o.callerCheck === "off" || platform === "linux") return undefined;
  return `the caller check needs Linux (/proc and SO_PEERCRED), and this is ${platform}. Set DM_CALLER_CHECK=off to run without it; the README says what that gives up`;
}

if (import.meta.main) {
  let app: App;
  try {
    const o = optionsFromEnv();
    const problem = platformProblem(o);
    if (problem) throw new Error(problem);
    app = await startApp(o);
  } catch (e) {
    console.error(`durable-member: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  console.log(`listening ${app.collie.address}`);
  if (!process.env.REAL_MODEL) console.log("Using the scripted model. Set REAL_MODEL and OPENROUTER_API_KEY for a real one.");
  const stop = () => {
    setTimeout(() => process.exit(1), 3000).unref(); // a hung close must not hang the shell
    app.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
