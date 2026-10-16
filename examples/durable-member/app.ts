// A small Pi Durable program with the Collie SDK inside. It is the support desk of a made-up online shop: each
// customer's ticket is a conversation, and a Collie peer with COLLIE_MUX=durable shows each one as a pane.
//   bun app.ts
// The README lists every environment variable. The model is Pi's faux model, scripted, so no key is
// needed. REAL_MODEL=<model id> uses a real one: through OpenRouter ($OPENROUTER_API_KEY) by default, or with
// REAL_PROVIDER=openai through an OpenAI API key or a ChatGPT sign-in (see "A real model" in the README).

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
import { type Collie, openCollie, SOCKET_ENV } from "../../packages/durable-sdk/src/index.ts";
import {
  ASKING_TOOLS,
  askTools,
  conversationOfPaneId,
  firstMessageOf,
  PaneRegistry,
  piHistory,
  riskGuard,
  showConversation,
  spawnHelperTool,
  toolResult,
} from "./pi-durable/index.ts";
import { CASE_IDS, CASES, type CaseId, customerFor, INSTRUCTIONS, lookOf, noteAsk, REAL_INSTRUCTIONS, ticketText, useScriptedModel } from "./script.ts";
import { ClosedStore, CredentialFile, TitleStore } from "./state.ts";

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
  /**
   * Where the names the phone gave a workspace or a tab are kept, as JSON, so a restart keeps a rename. Default:
   * `titles.json` beside `notesFile`.
   */
  titlesFile?: string;
  /** Where the conversations the phone closed are kept, as JSON, so a restart does not show them again. Default: `closed.json` beside `notesFile`. */
  closedFile?: string;
  /** Where a ChatGPT sign-in is kept (`REAL_PROVIDER=openai`), as Pi's `auth.json`. Default: `auth.json` beside `notesFile`. */
  authFile?: string;
  /** `descendant` (default) or `off`. An in-process test is the program's own caller, so it turns the check off. */
  callerCheck?: "descendant" | "off";
  /**
   * How long the phone has to answer each question the desk asks, in milliseconds (`DM_ASK_TIMEOUT_MS`). The ask carries
   * an `expiresAt`, so the phone shows the time left, and past it the program treats the question as a deny. Default: ten minutes.
   */
  askTimeoutMs?: number;
  /** Open one sign-in ticket when the storage holds no conversation yet, so a first start has an ask to answer. Default true. */
  seed?: boolean;
}

/** The default window for every question the support desk asks: ten minutes. */
export const DEFAULT_ASK_TIMEOUT_MS = 10 * 60_000;

export interface App {
  collie: Collie;
  harness: Harness;
  close(): Promise<void>;
}

export async function startApp(o: AppOptions): Promise<App> {
  const stepMs = o.stepMs ?? 400;
  const slowMs = o.slowMs ?? 10_000;
  const timeoutMs = o.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  // A question nobody answered in time is a deny, not a crash and not a retry: the program says so in its own log and goes on.
  const onTimeout = (tool: string, title: string) => console.error(`durable-member: ${tool} denied: timed out (${title})`);

  // The model: faux by default, the scripted one in script.ts. REAL_MODEL is a model id, off by default. REAL_PROVIDER picks
  // where it comes from: "openrouter" (default, the key is $OPENROUTER_API_KEY) or "openai" (an OpenAI API key, or the
  // ChatGPT sign-in kept in auth.json). Collie holds no key. The app never reads or prints one: Pi does.
  const credentials = new CredentialFile(o.authFile ?? join(dirname(o.notesFile), "auth.json"));
  const models = createModels({ credentials });
  let model = { provider: "faux", modelId: "faux-1" };
  const real = process.env.REAL_MODEL; // e.g. google/gemini-3.1-flash-lite (OpenRouter) or a model id of Pi's OpenAI catalog.
  if (real) {
    const provider = process.env.REAL_PROVIDER || "openrouter";
    if (provider === "openai") {
      const { openaiProvider } = await import("@earendil-works/pi-ai/providers/openai");
      models.setProvider(openaiProvider());
    } else if (provider === "openrouter") {
      const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
      models.setProvider(openrouterProvider());
    } else {
      throw new Error(`REAL_PROVIDER must be "openrouter" or "openai", not ${JSON.stringify(provider)}`);
    }
    if (!models.getModel(provider, real)) throw new Error(`REAL_MODEL ${real} is not an ${provider === "openai" ? "OpenAI" : "OpenRouter"} model id Pi knows`);
    if (provider === "openai" && (await models.getAuth("openai")) === undefined) {
      throw new Error("REAL_PROVIDER=openai finds no sign-in. Set OPENAI_API_KEY, or sign in with ChatGPT first (README, A real model)");
    }
    model = { provider, modelId: real };
  } else {
    useScriptedModel(models, { stepMs, slowMs, helperMs: o.helperMs });
  }

  // Tools and layout.
  const notes = o.notesFile;
  mkdirSync(dirname(notes), { recursive: true, mode: 0o700 });
  // A name the phone gave a workspace or a tab (WIRE.md 7.8). The layout below is made again on every start, so the
  // names are kept in a file and win over the ones in this code. A key is the kind and the wire id: `tab/triage:inbox`.
  const titles = new TitleStore(o.titlesFile ?? join(dirname(notes), "titles.json"));
  // A conversation the phone closed is archived: it is ended, written down here, and not shown again after a restart.
  const closed = new ClosedStore(o.closedFile ?? join(dirname(notes), "closed.json"));
  const panes = new PaneRegistry();
  let harness!: Harness;
  const collie = await openCollie({
    socket: o.socket,
    hostName: "durable-member",
    callerCheck: o.callerCheck,
    hooks: {
      // Keep the new name, then take it. Returning false would refuse it (422).
      onRename: ({ kind, id, title }) => {
        titles.set(kind, id, title);
        return true;
      },
      // The phone closes a conversation: end its run, write it down so a restart skips it, stop showing it. The SDK
      // then takes the pane out of the layout and closes its open asks as `stopped`. The Tickets and Look-ups tabs
      // and the Support workspace are this program's own layout, in code, so it refuses to close those (422).
      onClose: async ({ kind, paneIds }) => {
        if (kind !== "pane") return false;
        for (const paneId of paneIds) {
          const id = panes.conversationOf(paneId);
          if (id === undefined) continue;
          await (await harness.conversation(id, ctx))?.abort(ctx).catch(() => {});
          closed.add(String(id));
          await panes.forget(id);
        }
      },
      // The phone reopens a closed conversation (WIRE.md 7.16): take it off the closed list and show it again, under
      // the same pane id. Pi kept every entry, so the pane carries the whole conversation.
      onReopen: async ({ id }) => {
        const conversationId = conversationOfPaneId(id);
        if (conversationId === undefined) return false;
        const record = await harness.commit((tx) => tx.conversation(conversationId), ctx);
        const conversation = await harness.conversation(conversationId, ctx);
        if (record === undefined || conversation === undefined) return false;
        closed.delete(String(conversationId));
        await show(conversation, record.owner?.conversationId);
      },
    },
  });
  // The wire ids stay as they were (`triage`, `inbox`, `helpers`), so a rename kept in titles.json still finds its tab.
  const ws = collie.workspace("triage", { title: titles.get("workspace", "triage", "Support"), cwd: "/srv/support" });
  const inbox = ws.tab("inbox", { title: titles.get("tab", "triage:inbox", "Tickets") });
  const helpers = ws.tab("helpers", { title: titles.get("tab", "triage:helpers", "Look-ups") });

  const writeNote = defineTool({
    name: "write_note",
    description: "Save a note about the ticket.",
    parameters: Type.Object({ note: Type.String() }),
    execute: async (args) => {
      appendFileSync(notes, `${new Date().toISOString()} ${args.note}\n`);
      return toolResult("note saved");
    },
  });
  const triageTools: Extension = defineExtension({
    name: "triage-tools",
    tools: [
      writeNote,
      ...askTools({ panes, timeoutMs, onTimeout }),
      spawnHelperTool({
        panes,
        harness: () => harness,
        tab: helpers,
        model,
        without: () => [triageTools],
        look: (task) => lookOf(task, true),
        // A look-up that answered leaves the list of open conversations: it is written down as closed, so a restart
        // does not show it either, and the phone reads it under Closed.
        done: async (child, pane) => {
          closed.add(String(child));
          pane.close();
          await panes.forget(child);
        },
      }),
    ],
  });
  const registry = createRegistry();
  registry.install(triageTools);
  const risky = new Set(["write_note"]);
  // The question before a note is saved shows the note, with Save and Don't save.
  registry.install(riskGuard({ panes, risky, timeoutMs, onTimeout, words: (tool, summary) => (tool === "write_note" ? noteAsk(summary) : undefined) }));

  // The history is Pi's own record (WIRE.md 7.16): every conversation, open and closed, with all its entries.
  collie.history(
    piHistory({
      harness: () => harness,
      panes,
      describe: (record, first) => {
        const owned = record.owner !== undefined;
        return { ...lookOf(first, owned), workspaceId: "triage", tabId: owned ? helpers.id : inbox.id, progress: !owned };
      },
    }),
  );

  const storage: Storage = o.storage === "memory" ? new MemoryStorage() : await openNodeJsonlStorage(o.storage, ctx);
  harness = await Harness.open(storage, { models, registry, onReport: (e) => console.error("pi-durable report:", e) }, ctx);

  // Show every conversation that exists (a restart), BEFORE resume(), so a re-run hook finds its pane.
  const all: { id: ConversationId; owner?: ConversationId }[] = [];
  let cursor: Cursor | undefined;
  do {
    const at = cursor;
    const page = await harness.commit((tx) => tx.scanConversations({}, 256, at), ctx);
    for (const c of page.items) all.push({ id: c.id, owner: c.owner?.conversationId });
    cursor = page.next;
  } while (cursor);
  for (const c of all) {
    if (closed.has(String(c.id))) continue; // the phone closed it
    const conversation = (await harness.conversation(c.id, ctx))!;
    await show(conversation, c.owner);
  }

  /**
   * Show a conversation as a pane, named from its first message: a ticket after its customer, with its topic under
   * the title; a look-up after the customer it is for. `first` is the message a new ticket is about to get.
   */
  async function show(conversation: Conversation, owner: ConversationId | undefined, first?: string) {
    const owned = owner !== undefined;
    const tab = owned ? helpers : inbox;
    const look = lookOf(first ?? (await firstMessageOf(conversation)), owned);
    return showConversation({ tab, ...look, progress: !owned, escalate: !owned }, harness, conversation, { panes });
  }

  // The tickets so far, so the next one takes the next customer, after a restart too.
  let tickets = all.filter((c) => c.owner === undefined).length;
  const instructions = real ? REAL_INSTRUCTIONS : INSTRUCTIONS;
  const startTicket = (kind: CaseId) => async () => {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, instructions } }, ctx);
    const text = ticketText(kind, customerFor(++tickets));
    const pane = await show(conversation, undefined, text);
    await conversation.submit({ type: "input", content: text }, ctx);
    return { paneId: pane.id };
  };
  // One starter per kind of ticket. With a real model they start the same tickets; the model, not the script,
  // decides what it does with them.
  collie.starters(CASE_IDS.map((kind) => ({ id: kind, label: CASES[kind].starter, run: startTicket(kind) })));

  // A first start opens one sign-in ticket, so the phone has something to show and one question to answer.
  // Later starts show what the storage holds, as a durable program should.
  if ((o.seed ?? true) && all.length === 0) await startTicket("sign-in")();

  // Continue any run the last process left unfinished, and wait for the asks it raises again: Pi re-runs a
  // waiting hook, which asks under the same id (the SDK derives it from the tool call). Only then is the layout
  // complete, so the first snapshot after a restart carries every open ask.
  const reRaised = panes.reRaised(new Set([...risky, ...ASKING_TOOLS]));
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
    titlesFile: join(data, "titles.json"),
    authFile: join(data, "auth.json"),
    stepMs: ms("DM_STEP_MS"),
    slowMs: ms("DM_SLOW_MS"),
    helperMs: ms("DM_HELPER_MS"),
    askTimeoutMs: ms("DM_ASK_TIMEOUT_MS"),
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
  if (!process.env.REAL_MODEL) console.log("Using the scripted model. Set REAL_MODEL and a key or a sign-in for a real one (README, A real model).");
  const stop = () => {
    setTimeout(() => process.exit(1), 3000).unref(); // a hung close must not hang the shell
    app.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
