// The program: the same support desk as examples/durable-member/app.ts, in one Durable Object hosted by Cloudflare's
// PiHarness (package `agents`, `agents/harness/pi`, beta). PiHarness keeps Pi Durable's conversations in the
// object's SQLite under the prefix `pi_`, opens Pi on every start, and wakes the object by alarm while a session
// has work, so a run that was evicted goes on without waiting for a read. The SDK core serves Collie's wire
// (core.handle), and the request ids go to a `collie_receipts` table, so a retry after a restart still runs once.
// The newest 1000 per pane are kept (receipts.ts).
//
// Every start of the object (a deploy, an eviction, a wake by alarm) is a new epoch, so Collie reads every pane
// again (WIRE.md section 8). The start runs in this order, inside Lifecycle's blockConcurrencyWhile, so no request
// sees a half-made layout:
//   1. `open`, the factory PiHarness calls: Harness.open with our settings, then every conversation is shown and
//      the wait for re-raised asks is armed. PiHarness calls pi.resume() right after, so a hook that runs again
//      finds its pane.
//   2. PiHarness's own onStart: it schedules a wake job for every session with work left.
//   3. `onStart` here: wait for the re-raised asks (same ids as before the wake, so a tap sent across it lands),
//      then core.ready(), last.

import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT as ctx0 } from "@earendil-works/chord/context";
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
} from "@earendil-works/pi-durable";
import { PiHarness, type PiHarnessContext } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { type CollieCore, createCore, type TabHandle } from "../../../packages/durable-sdk/src/core/index.ts";
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
  type Submit,
} from "../../../examples/durable-member/pi-durable/index.ts";
import {
  CASE_IDS,
  CASES,
  type CaseId,
  customerFor,
  INSTRUCTIONS,
  lookOf,
  noteAsk,
  REAL_INSTRUCTIONS,
  ticketText,
  useScriptedModel,
} from "../../../examples/durable-member/script.ts";
import type { Env } from "./env.ts";
import { SqliteReceiptStore } from "./receipts.ts";
import { openPiStorage } from "./storage.ts";

/** The name the phone shows for this program's machine. */
export const HOST_NAME = "durable-member-cloudflare";

/** The Workers AI model the example uses when the `AI` binding is set. Billed by Cloudflare per token. */
export const WORKERS_AI_MODEL = "@cf/zai-org/glm-4.7-flash";

const ms = (v: string | undefined, fallback: number) => {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`a DM_*_MS setting must be a whole number of milliseconds, not ${JSON.stringify(v)}`);
  return n;
};

const risky = new Set(["write_note"]);

export class Member extends DurableObject<Env> {
  /** Wire requests this instance served. A wake by alarm leaves it at 0; the tests read it. */
  reads = 0;
  private core!: CollieCore;
  private pi!: Harness;
  private inbox!: TabHandle;
  private helpers!: TabHandle;
  private model = { provider: "faux", modelId: "faux-1" };
  private real = false;
  private readonly panes = new PaneRegistry();
  private reRaised: Promise<void> = Promise.resolve();
  /** Set on the very first start: the root conversation, which gets the first ticket in onStart. */
  private firstTicket: ConversationId | undefined;
  /** The tickets so far, so the next one takes the next customer, after a wake too. */
  private tickets = 0;

  // PiHarness owns Harness.open (through `open`), storage, recovery and the wake. Lifecycle owns fetch and alarm:
  // the object answers in onRequest, never in fetch, or Lifecycle would not start it (FINDINGS.md of the spike).
  readonly harness = new PiHarness({ harness: (o) => this.open(o) });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async onRequest(request: Request): Promise<Response> {
    this.reads++;
    return this.core.handle(request);
  }

  /** A pane's send goes through PiHarness: it schedules the session's wake job, then admits the input once. */
  private readonly submit: Submit = (conversation, input) =>
    this.harness.session(String(conversation.id)).submit(input.content, {
      whenBusy: input.whenBusy,
      ...(input.requestId === undefined ? {} : { operationId: input.requestId }),
    });

  /**
   * Show a conversation as a pane, named from its first message: a ticket after its customer, with its topic under
   * the title; a look-up after the customer it is for. `first` is the message a new ticket is about to get.
   */
  private async show(conversation: Conversation, owner: ConversationId | undefined, first?: string) {
    const owned = owner !== undefined;
    const tab = owned ? this.helpers : this.inbox;
    const look = lookOf(first ?? (await firstMessageOf(conversation, ctx0)), owned);
    return showConversation(
      { tab, ...look, progress: !owned, escalate: !owned },
      this.pi,
      conversation,
      { panes: this.panes, submit: this.submit },
    );
  }

  /** Step 1 of the start: PiHarness's factory. PiHarness calls pi.root() and pi.resume() after it returns. */
  private async open({ storage, context }: PiHarnessContext): Promise<Harness> {
    const { env } = this;
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS collie_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, note TEXT NOT NULL)");
    // A name the phone gave a workspace or a tab (WIRE.md 7.8). The layout below is made again on every start, so the
    // names are kept here and win over the ones in this file. A key is the wire id: `triage`, or `triage:inbox`.
    sql.exec("CREATE TABLE IF NOT EXISTS collie_titles (kind TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, PRIMARY KEY (kind, id))");
    // A conversation the phone closed (WIRE.md 7.9): archived, so a wake does not show it again. A key is the Pi conversation id.
    sql.exec("CREATE TABLE IF NOT EXISTS collie_closed (id TEXT PRIMARY KEY)");
    const closed = new Set(sql.exec<{ id: string }>("SELECT id FROM collie_closed").toArray().map((r) => r.id));
    const renamed = new Map(sql.exec<{ kind: string; id: string; title: string }>("SELECT kind, id, title FROM collie_titles").toArray().map((r) => [`${r.kind}/${r.id}`, r.title]));
    const titled = (kind: "workspace" | "tab", id: string, fallback: string) => renamed.get(`${kind}/${id}`) ?? fallback;
    // Over TLS the token is the only gate, so this program offers Allow and Deny only: an `allow-always` option is
    // a TypeError when an ask is raised (WIRE.md 1B, ADR 0103).
    const core = createCore({
      hostName: HOST_NAME,
      receipts: new SqliteReceiptStore(this.ctx.storage),
      allowAlways: false,
      hooks: {
        // Keep the new name, so a wake of the object does not give the old one back.
        onRename: ({ kind, id, title }) => {
          sql.exec("INSERT OR REPLACE INTO collie_titles (kind, id, title) VALUES (?, ?, ?)", kind, id, title);
          return true;
        },
        // Archive a conversation the phone closes: end its run, write it down, stop showing it. The SDK then takes the
        // pane out of the layout and closes its asks as `stopped`. The tabs and the workspace are this program's own
        // layout, in code, so it refuses to close those (422).
        onClose: async ({ kind, paneIds }) => {
          if (kind !== "pane") return false;
          for (const paneId of paneIds) {
            const id = this.panes.conversationOf(paneId);
            if (id === undefined) continue;
            await (await this.pi.conversation(id, ctx0))?.abort(ctx0).catch(() => {});
            sql.exec("INSERT OR IGNORE INTO collie_closed (id) VALUES (?)", String(id));
            closed.add(String(id));
            await this.panes.forget(id);
          }
        },
        // The phone reopens a closed conversation (WIRE.md 7.16): off the archive, and shown again under the same pane
        // id. Pi kept every entry in the object's SQLite, so the pane carries the whole conversation.
        onReopen: async ({ id }) => {
          const conversationId = conversationOfPaneId(id);
          if (conversationId === undefined) return false;
          const record = await this.pi.commit((tx) => tx.conversation(conversationId), ctx0);
          const conversation = await this.pi.conversation(conversationId, ctx0);
          if (record === undefined || conversation === undefined) return false;
          sql.exec("DELETE FROM collie_closed WHERE id = ?", String(conversationId));
          closed.delete(String(conversationId));
          await this.show(conversation, record.owner?.conversationId);
        },
      },
    });
    this.core = core;
    const stepMs = ms(env.DM_STEP_MS, 400);

    // The model: the scripted one, or Workers AI through the `AI` binding (wrangler.jsonc). The binding carries no
    // key, so the Worker holds none.
    const models = createModels();
    this.real = env.AI !== undefined;
    if (env.AI !== undefined) {
      const { createAI } = await import("agents/models/pi-ai");
      const ai = createAI({ binding: env.AI });
      models.setProvider(ai.provider);
      const chosen = ai(WORKERS_AI_MODEL);
      this.model = { provider: chosen.provider, modelId: chosen.id };
    } else {
      useScriptedModel(models, { stepMs, slowMs: ms(env.DM_SLOW_MS, 10_000), helperMs: ms(env.DM_HELPER_MS, stepMs) });
    }

    // The wire ids stay as they were (`triage`, `inbox`, `helpers`), so a rename kept in collie_titles still finds its tab.
    const ws = core.workspace("triage", { title: titled("workspace", "triage", "Support"), cwd: "/srv/support" });
    this.inbox = ws.tab("inbox", { title: titled("tab", "triage:inbox", "Tickets") });
    this.helpers = ws.tab("helpers", { title: titled("tab", "triage:helpers", "Look-ups") });
    // The history is Pi's own record in the object's SQLite (WIRE.md 7.16): every conversation, open and closed.
    const inboxId = this.inbox.id;
    const helpersId = this.helpers.id;
    core.history(
      piHistory({
        harness: () => this.pi,
        panes: this.panes,
        describe: (record, first) => {
          const owned = record.owner !== undefined;
          return { ...lookOf(first, owned), workspaceId: "triage", tabId: owned ? helpersId : inboxId, progress: !owned };
        },
      }),
    );

    // write_note keeps its line in the object's own SQLite: a Worker has no file to append to.
    const writeNote = defineTool({
      name: "write_note",
      description: "Save a note about the ticket.",
      parameters: Type.Object({ note: Type.String() }),
      execute: async (args) => {
        sql.exec("INSERT INTO collie_notes (at, note) VALUES (?, ?)", new Date().toISOString(), args.note);
        return { content: [{ type: "text", text: "note saved" }] };
      },
    });
    const triageTools: Extension = defineExtension({
      name: "triage-tools",
      tools: [
        writeNote,
        ...askTools({ panes: this.panes }),
        spawnHelperTool({
          panes: this.panes,
          harness: () => this.pi,
          tab: this.helpers,
          model: this.model,
          without: () => [triageTools],
          look: (task) => lookOf(task, true),
          // A look-up that answered leaves the open conversations: archived, so a wake does not show it either, and
          // the phone reads it under Closed.
          done: async (child, pane) => {
            sql.exec("INSERT OR IGNORE INTO collie_closed (id) VALUES (?)", String(child));
            closed.add(String(child));
            pane.close();
            await this.panes.forget(child);
          },
        }),
      ],
    });
    const registry = createRegistry();
    registry.install(triageTools);
    // PiHarness has no approval step: the asks are ours, raised through the SDK core.
    registry.install(riskGuard({ panes: this.panes, risky, words: (tool, summary) => (tool === "write_note" ? noteAsk(summary) : undefined) }));

    // contextRetentionMs 0: Pi keeps no idle-context timer. With nodejs_compat a Worker's timers look like Node's,
    // so Pi would keep one for 10 minutes after every run, and under wrangler dev a pending timer keeps the object
    // in memory until it fires (measured 2026-10-13).
    // Never call this.harness.pi() in here: it waits for this factory.
    this.pi = await Harness.open(
      openPiStorage(storage, env),
      { models, registry, settings: { contextRetentionMs: 0 }, onReport: (e) => console.error("pi-durable report:", e) },
      context,
    );

    // Show every conversation that exists, BEFORE PiHarness calls resume(), so a re-run hook finds its pane.
    const all: { id: ConversationId; owner?: ConversationId }[] = [];
    let cursor: Cursor | undefined;
    do {
      const at = cursor;
      const page = await this.pi.commit((tx) => tx.scanConversations({}, 256, at), ctx0);
      for (const c of page.items) all.push({ id: c.id, owner: c.owner?.conversationId });
      cursor = page.next;
    } while (cursor);
    // The very first start: the first ticket is Pi's root conversation (id 1), made here with our model and
    // instructions. PiHarness's own pi.root() then finds it, instead of making an empty one with no pane.
    if (all.length === 0) {
      const root = await this.pi.root(ctx0, { agent: { model: this.model, instructions: this.instructions() } });
      this.firstTicket = root.id;
      all.push({ id: root.id });
    }
    this.tickets = all.filter((c) => c.owner === undefined).length;
    for (const c of all) {
      if (closed.has(String(c.id))) continue;
      // The first ticket's message is sent in onStart, after this; it is named from the message it is about to get.
      const first = c.id === this.firstTicket ? this.firstText() : undefined;
      await this.show((await this.pi.conversation(c.id, ctx0))!, c.owner, first);
    }
    // Armed before resume(): it reads which risky calls have no result yet. Each raises its ask again under the
    // same id once Pi re-runs its hook.
    this.reRaised = this.panes.reRaised(new Set([...risky, ...ASKING_TOOLS]));
    return this.pi;
  }

  private instructions() {
    return this.real ? REAL_INSTRUCTIONS : INSTRUCTIONS;
  }

  /** The very first ticket: a sign-in problem, from the first customer. */
  private firstText() {
    return ticketText("sign-in", customerFor(1));
  }

  /** Step 3 of the start. Lifecycle runs it after PiHarness's onStart, on a request and on an alarm alike. */
  async onStart() {
    // The first snapshot after a wake carries every open ask, by contract and not by timing.
    await this.reRaised;
    const startTicket = (kind: CaseId) => async () => {
      const conversation = await this.pi.createConversation({ ownership: { kind: "ownerless" }, agent: { model: this.model, instructions: this.instructions() } }, ctx0);
      const text = ticketText(kind, customerFor(++this.tickets));
      const pane = await this.show(conversation, undefined, text);
      await this.harness.session(String(conversation.id)).submit(text);
      return { paneId: pane.id };
    };
    // One starter per kind of ticket, as in the Bun example.
    this.core.starters(CASE_IDS.map((kind) => ({ id: kind, label: CASES[kind].starter, run: startTicket(kind) })));
    // The first start opens one sign-in ticket, so the phone has a question to answer. Later starts show what storage holds.
    if (this.firstTicket !== undefined) {
      await this.harness.session(String(this.firstTicket)).submit(this.firstText(), { operationId: "first-ticket" });
    }
    this.core.ready(); // the layout is complete: only now may Collie see a snapshot
  }
}
