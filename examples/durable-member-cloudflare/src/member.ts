// The program: the same ticket triage as ../durable-member/app.ts, in one Durable Object. Pi Durable keeps the
// conversations in the object's SQLite (storage.ts), the SDK core serves Collie's wire (core.handle), and the
// request ids go to a `collie_receipts` table, so a retry after a restart still runs once. The newest 1000 per pane
// are kept (receipts.ts).
//
// The constructor runs on every start of the object: after a deploy, an eviction or a hibernation. Each start is
// a new epoch, so Collie reads every pane again (WIRE.md section 8). An ask that waited is raised again before
// the object says it is ready, under the same id, so a tap the phone sent across the wake lands.

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
import { type CollieCore, createCore } from "../../durable-member/sdk/core/index.ts";
import { PaneRegistry, riskGuard, showConversation, spawnHelperTool } from "../../durable-member/pi-durable/index.ts";
import { INSTRUCTIONS, REAL_INSTRUCTIONS, useScriptedModel } from "../../durable-member/script.ts";
import type { Env } from "./env.ts";
import { SqliteReceiptStore } from "./receipts.ts";
import { openPiStorage } from "./storage.ts";

/** The name the phone shows for this program's machine. */
export const HOST_NAME = "durable-member-cloudflare";

const ms = (v: string | undefined, fallback: number) => {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`a DM_*_MS setting must be a whole number of milliseconds, not ${JSON.stringify(v)}`);
  return n;
};

export class Member extends DurableObject<Env> {
  private core!: CollieCore;
  private readonly panes = new PaneRegistry();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // No request reaches fetch() before the layout is complete, so Collie never sees a half-empty one.
    void ctx.blockConcurrencyWhile(() => this.start());
  }

  async fetch(request: Request): Promise<Response> {
    return this.core.handle(request);
  }

  private async start() {
    const { env } = this;
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS collie_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, note TEXT NOT NULL)");
    // Over TLS the token is the only gate, so this program offers Allow and Deny only: an `allow-always` option is
    // a TypeError when an ask is raised (WIRE.md 1B, ADR 0103).
    const core = createCore({ hostName: HOST_NAME, receipts: new SqliteReceiptStore(this.ctx.storage), allowAlways: false });
    this.core = core;
    const stepMs = ms(env.DM_STEP_MS, 400);

    // The model: the scripted one, or a real one through OpenRouter. Pi reads OPENROUTER_API_KEY from
    // process.env, which nodejs_compat fills from the Worker's secrets.
    const models = createModels();
    let model = { provider: "faux", modelId: "faux-1" };
    const real = env.REAL_MODEL;
    if (real) {
      const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
      models.setProvider(openrouterProvider());
      if (!models.getModel("openrouter", real)) throw new Error(`REAL_MODEL ${real} is not an OpenRouter model id Pi knows`);
      model = { provider: "openrouter", modelId: real };
    } else {
      useScriptedModel(models, { stepMs, slowMs: ms(env.DM_SLOW_MS, 10_000), helperMs: ms(env.DM_HELPER_MS, stepMs) });
    }

    const ws = core.workspace("triage", { title: "Triage", cwd: "/srv/triage" });
    const inbox = ws.tab("inbox", { title: "Inbox" });
    const helpers = ws.tab("helpers", { title: "Helpers" });

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
    let harness!: Harness;
    const triageTools: Extension = defineExtension({
      name: "triage-tools",
      tools: [writeNote, spawnHelperTool({ panes: this.panes, harness: () => harness, tab: helpers, model, without: () => [triageTools] })],
    });
    const registry = createRegistry();
    registry.install(triageTools);
    const risky = new Set(["write_note"]);
    registry.install(riskGuard({ panes: this.panes, risky }));

    // contextRetentionMs 0: Pi keeps no idle-context timer. With nodejs_compat a Worker's timers look like Node's,
    // so Pi would keep one for 10 minutes after every run, and a pending timer keeps a Durable Object in memory,
    // billed, until it fires.
    const storage = await openPiStorage(this.ctx, env);
    harness = await Harness.open(
      storage,
      { models, registry, settings: { contextRetentionMs: 0 }, onReport: (e) => console.error("pi-durable report:", e) },
      ctx0,
    );

    // Show every conversation that exists, BEFORE resume(), so a re-run hook finds its pane.
    const all: { id: ConversationId; owned: boolean }[] = [];
    let cursor: Cursor | undefined;
    do {
      const at = cursor;
      const page = await harness.commit((tx) => tx.scanConversations({}, 256, at), ctx0);
      for (const c of page.items) all.push({ id: c.id, owned: c.owner !== undefined });
      cursor = page.next;
    } while (cursor);
    const show = (conversation: Conversation, owned: boolean) =>
      showConversation({ tab: owned ? helpers : inbox, title: `${owned ? "Helper" : "Ticket"} #${conversation.id}` }, harness, conversation, { panes: this.panes });
    for (const c of all) await show((await harness.conversation(c.id, ctx0))!, c.owned);

    const instructions = real ? REAL_INSTRUCTIONS : INSTRUCTIONS;
    const startTriage = (prefix: string) => async () => {
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, instructions } }, ctx0);
      const pane = await show(conversation, false);
      await conversation.submit({ type: "input", content: `${prefix}Triage ticket ${400 + Number(conversation.id)}: a customer cannot log in.` }, ctx0);
      return { paneId: pane.id };
    };
    core.starters([
      { id: "new-triage", label: "New triage", run: startTriage("") },
      { id: "two-notes", label: "Two notes at once (faux only)", run: startTriage("TWO: ") },
    ]);

    // The first start opens one ticket, so the phone has an ask to answer. Later starts show what storage holds.
    if (all.length === 0) await startTriage("")();

    // Continue any run the last start left unfinished, and wait for the asks it raises again (Pi re-runs a
    // waiting hook, which asks under the same id). Only then is the layout complete: the first snapshot after a
    // wake carries every open ask, by contract and not by timing.
    const reRaised = this.panes.reRaised(risky);
    harness.resume();
    await reRaised;
    core.ready(); // the layout is complete: only now may Collie see a snapshot
  }
}
