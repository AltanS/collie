// One support ticket from start to end, in-process, with memory storage, the Pi Durable glue and the SDK.
// The app opens no ticket of its own here (`seed: false`), so every pane comes from a starter.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, type App } from "../app.ts";
import { api, type Dial, oldestAsk } from "./client.ts";
import { allEvents, cleanup, firstAsk, latestItems, openAsks, pane, tmp, waitFor } from "./util.ts";

let app: App;
let d: Dial;
let dir: string;

beforeAll(async () => {
  dir = tmp();
  app = await startApp({ socket: join(dir, "s.sock"), storage: "memory", stepMs: 0, slowMs: 20_000, notesFile: join(dir, "notes.txt"), callerCheck: "off", seed: false });
  d = { socket: app.collie.address, version: 1 };
});
afterAll(async () => {
  await app.close();
  cleanup();
});

const asks = async (id: string) => (await allEvents(d, id)).filter((e) => e.type === "ask");

describe("one ticket", () => {
  let main = "";
  let askId = "";
  let helper = "";

  test("hello matches the range; another range is incompatible", async () => {
    expect((await api.hello(d)).body.protocol).toEqual({ min: 1, max: 1 });
    expect((await api.hello({ ...d, version: 2 })).body.code).toBe("incompatible");
  });

  test("start sign-in: a pane in triage:inbox named after its customer, working", async () => {
    main = (await api.start(d, "sign-in")).body.paneId;
    const p = (await api.snapshot(d)).body.panes.find((x) => x.id === main)!;
    expect(p.tabId).toBe("triage:inbox");
    expect(p.cwd).toBeUndefined();
    expect(p.workspaceId).toBe("triage");
    expect(p.title).toBe("Maria Lopez"); // the first ticket takes the first customer
    expect(["working", "waiting"]).toContain(p.state);
  });

  test("write_note is risky: an ask, state waiting, options shown", async () => {
    const p = await waitFor("waiting pane", async () => {
      const x = await pane(d, main);
      return x?.state === "waiting" ? x : undefined;
    });
    // The ticket's line under the title, and a badge that counts the asks waiting for the phone.
    expect(p.subtitle).toBe("Can't sign in after a password reset");
    expect(p.badge).toEqual({ count: 1 });
    // The ticket's progress: it read the ticket, and the note waits for the phone's yes.
    expect(p.progress).toEqual({
      kind: "steps",
      steps: [{ label: "Read the ticket", state: "done" }, { label: "Save a note", state: "running" }, { label: "Reply", state: "todo" }],
    });
    // The question shows the note in words, with Save and Don't save.
    expect(p.openAsks[0]).toMatchObject({
      kind: "permission",
      revision: 1,
      title: "Save this note to the ticket?",
      tool: { name: "write_note", summary: "Sign-in fails after a password reset. The old session may still be active." },
    });
    expect(p.openAsks[0]!.options.map((o) => o.label)).toEqual(["Save", "Don't save"]);
    expect(p.openAsks[0]!.toolCallId).toBe(p.openAsks[0]!.itemId); // the tool item the card sits under
    expect(p.openAsks[0]!.options.map((o) => o.id)).toEqual(["allow", "deny"]);
    // The guard chooses the words of the push for this ask (WIRE.md section 6).
    expect(p.openAsks[0]!.push).toEqual({ title: "A note needs your OK", line: "Sign-in fails after a password reset. The old session may still be active." });
    askId = p.openAsks[0]!.id;
    expect(readFileSync(join(dir, "notes.txt"), { flag: "a+" }).toString()).toBe(""); // not run yet
  });

  test("answer allow: the tool runs and its result is an event", async () => {
    expect((await api.answer(d, main, askId, "allow")).body).toEqual({ result: "taken" });
    await waitFor("tool done", async () =>
      (await allEvents(d, main)).some((e) => e.type === "item" && e.item.kind === "tool" && e.item.tool.name === "write_note" && e.item.status === "done"),
    );
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toContain("Sign-in fails after a password reset.");
    const events = await allEvents(d, main);
    expect(events.find((e) => e.type === "ask-closed")).toMatchObject({ askId, by: "phone" });
    await waitFor("badge cleared", async () => (await pane(d, main))?.badge === undefined);
    expect((await api.answer(d, main, askId, "allow")).body).toMatchObject({ code: "decided", outcome: { decidedBy: "phone", optionId: "allow" } });
  });

  test("spawn_helper: a look-up pane in tab helpers; once it answered, it is closed and the history keeps it", async () => {
    const shown = await waitFor("helper pane", async () => (await api.snapshot(d)).body.panes.find((x) => x.tabId === "triage:helpers"));
    helper = shown.id;
    expect(shown.title).toBe("Look-up for Maria Lopez");
    expect(shown.subtitle).toBe("Why does sign-in fail right after a password reset?");
    // The look-up answered: the program takes its pane out, so the open conversations are the tickets.
    await waitFor("helper closed", async () => (await pane(d, helper)) === undefined);
    const row = (await api.conversations(d)).body.items.find((r) => r.id === helper);
    expect(row).toMatchObject({ title: "Look-up for Maria Lopez", state: "closed" });
    const items = (await api.items(d, helper)).body.items;
    expect(items.some((item) => item.kind === "reply" && item.text.includes("session cookie"))).toBe(true);
  });

  test("the first pane's turn ends: idle, with the helper's words in the answer", async () => {
    await waitFor("main idle", async () => (await pane(d, main))?.state === "idle");
    expect(await pane(d, main)).not.toHaveProperty("progress"); // the program clears it when the run ends
    const events = await allEvents(d, main);
    const items = latestItems(events);
    const at = items.findIndex((item) => item.kind === "reply" && item.text.startsWith("Found it."));
    const reply = items[at];
    expect(reply?.kind === "reply" && reply.text).toContain("session cookie");
    // The ticket then adds next steps as markdown with a list, a code block and a link to a runbook (WIRE.md 7.13).
    expect(items.slice(at + 1).map((item) => item.kind)).toEqual(["markdown", "code", "link"]);
  });

  test("send starts a new turn; a repeat runs nothing; stop aborts it; idle, and the stop is a settled event, not an item", async () => {
    const before = (await api.events(d, main, 0)).body.next;
    const oldTurn = (await pane(d, main))!.turnId;
    const sent = await api.send(d, main, "one more thing", { turnId: oldTurn, requestId: "e2e-send-1" });
    expect(sent.body).toEqual({ ok: true });
    await waitFor("working again", async () => (await pane(d, main))?.state === "working");
    const turn = (await pane(d, main))!.turnId;
    expect(turn).not.toBe(oldTurn); // the send started a new turn
    expect((await api.send(d, main, "one more thing", { turnId: oldTurn, requestId: "e2e-send-1" })).body).toEqual({ ok: true, replayed: true });
    const stale = await api.send(d, main, "again", { turnId: oldTurn });
    expect([stale.status, stale.body.code, stale.body.turnId]).toEqual([409, "stale", turn]);
    const t0 = Date.now();
    expect((await api.abort(d, main, { turnId: turn })).status).toBe(200);
    await waitFor("idle after stop", async () => (await pane(d, main))?.state === "idle");
    expect(Date.now() - t0).toBeLessThan(5000); // the slow answer takes 20 s: it was cut short
    const fresh = (await api.events(d, main, before)).body.events;
    expect(fresh.filter((e) => e.type === "item" && e.item.kind === "user" && e.item.text === "one more thing")).toHaveLength(1);
    // The stop writes no item (no "stopped" line, no notice). The input settles as unanswered, and says which request it came with.
    expect(fresh.some((e) => e.type === "item" && e.item.kind === "notice")).toBe(false);
    expect(fresh.find((e) => e.type === "settled" && e.status === "unanswered")).toMatchObject({
      type: "settled",
      requestId: "e2e-send-1",
      status: "unanswered",
      reason: "aborted",
    });
    expect(fresh.some((e) => e.type === "item" && e.item.kind === "reply")).toBe(false);
    expect((await pane(d, main))!.turnId).toBe(turn); // idle again: the last turn that ran
  });

  test("a finished input settles as answered", async () => {
    const events = await allEvents(d, main);
    const answered = events.filter((e) => e.type === "settled" && e.status === "answered");
    expect(answered.length).toBeGreaterThan(0);
    for (const e of events) if (e.type === "settled") expect(e.inputId.length).toBeGreaterThan(0);
  });
});

describe("the Escalate action", () => {
  test("a ticket lists Escalate with the flag icon, a helper lists nothing, and a tap writes one notice, dims the button and says so under the title", async () => {
    const id = (await api.start(d, "sign-in")).body.paneId;
    await waitFor("ask", () => firstAsk(d, id));
    expect((await pane(d, id))!.actions).toEqual([{ id: "escalate", label: "Escalate", icon: "flag" }]);
    const helperPanes = (await api.snapshot(d)).body.panes.filter((x) => x.tabId === "triage:helpers");
    for (const h of helperPanes) expect("actions" in h).toBe(false);

    const turnId = (await pane(d, id))!.turnId;
    expect((await api.action(d, id, "escalate", { turnId, requestId: "e2e-action-1" })).body).toEqual({ ok: true });
    expect((await api.action(d, id, "escalate", { turnId, requestId: "e2e-action-1" })).body).toEqual({ ok: true, replayed: true });
    const notices = (await allEvents(d, id)).filter((e) => e.type === "item" && e.item.kind === "notice" && e.item.text.startsWith("Escalated"));
    expect(notices.length).toBe(1);
    expect((await pane(d, id))!.actions).toEqual([{ id: "escalate", label: "Escalate", icon: "flag", disabled: true }]);
    // Dimmed means no second tap: the program refuses it.
    const second = await api.action(d, id, "escalate", { requestId: "e2e-action-2" });
    expect([second.status, second.body.code]).toEqual([422, "action-refused"]);
    expect((await api.abort(d, id)).status).toBe(200);
    await waitFor("idle", async () => (await pane(d, id))?.state === "idle");
    // The line under the title says the ticket was escalated, and no question waits, so no badge.
    expect((await pane(d, id))!.subtitle).toBe("Escalated to the on-call lead.");
    await waitFor("no badge", async () => (await pane(d, id))?.badge === undefined);
  });
});

describe("beyond the script", () => {
  test("deny: the tool is blocked, the item reads denied, the file is untouched", async () => {
    const before = readFileSync(join(dir, "notes.txt"), "utf8");
    const id = (await api.start(d, "sign-in")).body.paneId;
    const p = await waitFor("ask", () => firstAsk(d, id));
    expect((await api.answer(d, id, p.id, "deny")).body).toEqual({ result: "taken" });
    await waitFor("idle", async () => (await pane(d, id))?.state === "idle");
    const events = await allEvents(d, id);
    expect(events.some((e) => e.type === "item" && e.item.kind === "tool" && e.item.status === "denied")).toBe(true);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe(before);
    expect(events.filter((e) => e.type === "item" && e.item.kind === "reply").length).toBe(1); // "not saved", no helper
  });

  test("stop while an ask is open closes the ask as stopped and ends the turn", async () => {
    const id = (await api.start(d, "sign-in")).body.paneId;
    await waitFor("ask", () => firstAsk(d, id));
    const t0 = Date.now();
    expect((await api.abort(d, id)).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(3000); // abort did not hang on the open ask
    await waitFor("idle", async () => (await pane(d, id))?.state === "idle");
    const closed = (await allEvents(d, id)).find((e) => e.type === "ask-closed");
    expect(closed).toMatchObject({ by: "stopped" });
    expect(await asks(id)).toHaveLength(1);
  });

  test("an answer arriving after the stop is 409 decided by the program", async () => {
    const id = (await api.start(d, "sign-in")).body.paneId;
    const open = await waitFor("ask", () => firstAsk(d, id));
    await api.abort(d, id);
    await waitFor("idle", async () => (await pane(d, id))?.state === "idle");
    expect((await api.answer(d, id, open.id, "allow")).body).toMatchObject({ code: "decided", outcome: { decidedBy: "program" } });
  });
});

// Pi Durable runs the calls of one assistant message in parallel by default (settings.toolExecution =
// "parallel"), so both `beforeTool` hooks wait at once and the wire shows both asks.
describe("two risky calls in one message", () => {
  const notes = () => readFileSync(join(dir, "notes.txt"), "utf8").split("\n").filter((l) => l.includes("ships to the new address"));
  const toolItems = async (id: string) =>
    (await allEvents(d, id)).flatMap((e) => (e.type === "item" && e.item.kind === "tool" ? [e.item] : []));
  const start = async () => {
    const id = (await api.start(d, "new-address")).body.paneId;
    const both = await waitFor("two open asks", async () => {
      const a = await openAsks(d, id);
      return a.length === 2 && a;
    });
    return { id, both };
  };

  test("both asks are open at once, oldest first, with their own ids and tool items; the pane is waiting", async () => {
    const before = notes().length;
    const { id, both } = await start();
    expect(both[0]!.id).not.toBe(both[1]!.id);
    expect(both[0]!.toolCallId).not.toBe(both[1]!.toolCallId);
    expect(both.map((a) => a.tool!.summary)).toEqual(["Order 5530 ships to the new address.", "Order 5531 ships to the new address."]);
    expect((await pane(d, id))!.state).toBe("waiting");
    expect(notes().length).toBe(before); // neither ran
    expect((await oldestAsk(d, id))!.id).toBe(both[0]!.id);
    // the two ask events are on the stream too, and the pane went waiting once, not twice
    const events = await allEvents(d, id);
    expect(events.filter((e) => e.type === "ask")).toHaveLength(2);
    expect(events.filter((e) => e.type === "state" && e.state === "waiting")).toHaveLength(1);
    // clean up: answer both
    for (const a of both) await api.answer(d, id, a.id, "deny");
    await waitFor("idle", async () => (await pane(d, id))?.state === "idle");
  });

  test("answering in reverse order works: the pane stays waiting until the last one; both notes are saved", async () => {
    const before = notes().length;
    const { id, both } = await start();
    expect((await api.answer(d, id, both[1]!.id, "allow")).body).toEqual({ result: "taken" });
    const left = await openAsks(d, id);
    expect(left.map((a) => a.id)).toEqual([both[0]!.id]);
    expect((await pane(d, id))!.state).toBe("waiting");
    expect((await oldestAsk(d, id))!.id).toBe(both[0]!.id);
    expect((await api.answer(d, id, both[1]!.id, "allow")).body).toMatchObject({ code: "decided", outcome: { decidedBy: "phone" } });
    expect((await api.answer(d, id, both[0]!.id, "allow")).body).toEqual({ result: "taken" });
    await waitFor("idle", async () => (await pane(d, id))?.state === "idle");
    expect(notes().length - before).toBe(2);
    const last = (await allEvents(d, id)).filter((e) => e.type === "item" && e.item.kind === "reply").at(-1) as any;
    expect(last.item.text).toBe("Both orders now ship to the new address.");
    const closed = (await allEvents(d, id)).filter((e) => e.type === "ask-closed").map((e: any) => e.askId);
    expect(closed).toEqual([both[1]!.id, both[0]!.id]); // closed in the order they were answered
  });

  test("deny one, allow the other: one note line, one denied tool item, one done", async () => {
    const before = notes().length;
    const { id, both } = await start();
    await api.answer(d, id, both[0]!.id, "deny");
    await api.answer(d, id, both[1]!.id, "allow");
    await waitFor("idle", async () => (await pane(d, id))?.state === "idle");
    const lines = notes().slice(before);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Order 5531");
    const final = new Map((await toolItems(id)).map((t) => [t.id, t.status]));
    expect(final.get(both[0]!.itemId)).toBe("denied");
    expect(final.get(both[1]!.itemId)).toBe("done");
    expect(final.size).toBe(2);
    const last = (await allEvents(d, id)).filter((e) => e.type === "item" && e.item.kind === "reply").at(-1) as any;
    expect(last.item.text).toBe("1 of the 2 orders ship to the new address.");
  });

  test("stop with two asks open closes both as stopped", async () => {
    const { id } = await start();
    await api.abort(d, id);
    await waitFor("idle", async () => (await pane(d, id))?.state === "idle");
    const closed = (await allEvents(d, id)).filter((e) => e.type === "ask-closed");
    expect(closed).toHaveLength(2);
    expect(closed.every((e: any) => e.by === "stopped")).toBe(true);
    expect(await openAsks(d, id)).toEqual([]);
  });
});

// A ticket that asks questions: the note (a permission), then which team (a choice), then the customer's line (a text ask).
describe("a ticket with questions", () => {
  test("the choice and the text ask are answered by their own shapes, one after the other, and the reply uses both", async () => {
    const id = (await api.start(d, "double-charge")).body.paneId;
    const permission = await waitFor("the note's ask", async () => (await openAsks(d, id)).find((a) => a.kind === "permission"));
    expect((await api.answer(d, id, permission.id, "allow")).body).toEqual({ result: "taken" });

    const choice = await waitFor("the choice", async () => (await openAsks(d, id)).find((a) => a.kind === "choice"));
    expect(choice).toMatchObject({ title: "Which team should take this?", options: [{ id: "billing" }, { id: "accounts" }, { id: "other" }] });
    expect(choice.options.every((o) => !("effect" in o))).toBe(true);
    expect(choice.toolCallId).toBe(choice.itemId);
    expect((await pane(d, id))!.state).toBe("waiting");
    expect((await pane(d, id))!.badge).toEqual({ count: 1 });
    // The wrong shape for a choice is refused and the ask stays open.
    expect((await api.answerWith(d, id, choice.id, { text: "billing" })).status).toBe(400);
    expect((await api.answerWith(d, id, choice.id, { optionIds: ["accounts"] })).body).toEqual({ result: "taken" });
    expect((await api.answerWith(d, id, choice.id, { optionIds: ["billing"] })).body).toMatchObject({ code: "decided", outcome: { decidedBy: "phone" } });

    const text = await waitFor("the text ask", async () => (await openAsks(d, id)).find((a) => a.kind === "text"));
    expect(text).toMatchObject({ title: "What should we tell the customer?", placeholder: "We are looking into it.", maxLength: 280 });
    expect((await api.answerWith(d, id, text.id, { text: "x".repeat(281) })).body.code).toBe("bad-body");
    expect((await api.answerWith(d, id, text.id, { text: "We are on it." })).body).toEqual({ result: "taken" });

    const reply = await waitFor("the reply", async () =>
      (await allEvents(d, id)).find((e) => e.type === "item" && e.item.kind === "reply" && e.item.partial !== true && e.item.text.startsWith("Handed to")),
    );
    expect((reply as { item: { text: string } }).item.text).toMatch(/^Handed to Accounts\. .+ gets your line: "We are on it\."$/);
    expect((await pane(d, id))!.badge).toBeUndefined();
    const tools = (await allEvents(d, id)).flatMap((e) => (e.type === "item" && e.item.kind === "tool" ? [`${e.item.tool.name}:${e.item.status}`] : []));
    expect(tools).toContain("ask_queue:done");
    expect(tools).toContain("ask_customer:done");
  });
});
