import { afterEach, describe, expect, test } from "bun:test";

import { DurableMux, MIN_SNAPSHOT_GAP_MS } from "./adapter.ts";
import type { JsonObject } from "../../json.ts";
import { CAPS } from "./clean.ts";
import { FakeDurableClock, FakeDurableProgram, hasHostileChars, hostileText } from "./fixture.ts";
import { askForWire, parseDecided, parseEvents, parseLogRow, parseSnapshot, type DurableAsk } from "./protocol.ts";

// AN APPROVAL WITH A RECEIPT, READ BY THE ADAPTER (WIRE.md 7.3, M55 spec 03). A second answer to a decided ask is 409
// `decided` and reads as `too-late`; an ask past its `expiresAt` leaves the open asks on the next read, even on a 304;
// `ask-closed` carries who decided and when, and a decision in the program reads `program`, not `stopped`. Every label
// on a card goes through the cleaner, and a button with no words left is dropped.

const programs: FakeDurableProgram[] = [];
afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
});

async function rig() {
  const program = await FakeDurableProgram.startWire();
  programs.push(program);
  const clock = new FakeDurableClock();
  const adapter = new DurableMux(program.wire(), clock, null, () => {});
  const read = async () => {
    clock.advance(MIN_SNAPSHOT_GAP_MS);
    return adapter.poll();
  };
  return { program, clock, adapter, read };
}

const OPEN_ASK = "ask-6f1d0c2a8b3e4d57a9c01e2b3d4f5a6c";

function askOn(over: Partial<DurableAsk> = {}): DurableAsk {
  return {
    id: "ask-extra",
    kind: "permission",
    toolCallId: "call-extra",
    revision: 1,
    title: "shell wants to run",
    itemId: "item-extra",
    options: [{ id: "allow", label: "Allow", effect: "allow" }],
    ...over,
  };
}

describe("a decided approval", () => {
  test("a second answer to a decided ask is 409 decided, which the adapter reads as too-late", async () => {
    const { program, adapter, read } = await rig();
    expect((await read()).ok).toBe(true);
    const first = await adapter.answerAsk("conv-02", { requestId: "req-first", askId: OPEN_ASK, revision: 1, optionId: "allow" });
    expect(first).toEqual({ ok: true, value: { kind: "taken", replayed: false } });
    const second = await adapter.answerAsk("conv-02", { requestId: "req-second", askId: OPEN_ASK, revision: 1, optionId: "deny" });
    // The 409 body says who decided first and when, and the adapter passes both on with the too-late.
    expect(second).toEqual({ ok: true, value: { kind: "too-late", replayed: false, decided: { by: "phone", at: expect.any(String) } } });
    // The program ran the first answer only.
    expect(program.answers.map((answer) => answer.optionId)).toEqual(["allow"]);
  });

  test("the decided body carries the first outcome, and a broken one reads as none", () => {
    const body = JSON.stringify({ code: "decided", outcome: { decidedBy: "phone", decidedAt: "2026-10-13T10:00:00.000Z", optionId: "allow", effect: "allow" } });
    expect(parseDecided(body)).toEqual({ decidedBy: "phone", decidedAt: "2026-10-13T10:00:00.000Z", optionId: "allow", effect: "allow" });
    expect(parseDecided(JSON.stringify({ code: "decided", outcome: { decidedBy: "someone", decidedAt: "2026-10-13T10:00:00.000Z" } }))).toBeNull();
    expect(parseDecided(JSON.stringify({ code: "decided", outcome: { decidedBy: "timeout", decidedAt: "soon" } }))).toBeNull();
    expect(parseDecided("{}")).toBeNull();
  });

  test("ask-closed carries the decision receipt, and a decision in the program reads program, not stopped", () => {
    const at = "2026-10-13T10:00:00.000Z";
    const parsed = parseEvents(
      JSON.stringify({
        epoch: "e1",
        next: 4,
        events: [
          { type: "ask-closed", askId: "a1", by: "phone", decidedBy: "phone", decidedAt: at },
          { type: "ask-closed", askId: "a2", by: "stopped", decidedBy: "program", decidedAt: at },
          { type: "ask-closed", askId: "a3", by: "stopped", decidedBy: "timeout", decidedAt: at },
          { type: "ask-closed", askId: "a4", by: "stopped" },
          { type: "ask-closed", askId: "a5", by: "stopped", decidedBy: "someone", decidedAt: "never" },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.events).toEqual([
      { type: "ask-closed", askId: "a1", by: "phone", waitedMs: undefined, decidedBy: "phone", decidedAt: at },
      { type: "ask-closed", askId: "a2", by: "program", waitedMs: undefined, decidedBy: "program", decidedAt: at },
      { type: "ask-closed", askId: "a3", by: "timeout", waitedMs: undefined, decidedBy: "timeout", decidedAt: at },
      // An older program sends no receipt: its close stays a stop.
      { type: "ask-closed", askId: "a4", by: "stopped", waitedMs: undefined },
      { type: "ask-closed", askId: "a5", by: "stopped", waitedMs: undefined },
    ]);
    // The pane log reads the precise word back.
    expect(parseLogRow(JSON.stringify({ k: "ask-closed", at, askId: "a2", by: "program" }))).toMatchObject({ by: "program" });
    expect(parseLogRow(JSON.stringify({ k: "ask-closed", at, askId: "a3", by: "timeout" }))).toMatchObject({ by: "timeout" });
    expect(parseLogRow(JSON.stringify({ k: "ask-closed", at, askId: "a4", by: "anything" }))).toMatchObject({ by: "stopped" });
  });
});

describe("an ask that expires", () => {
  test("an ask past its expiresAt leaves the open asks on the next read, and its pane stops reading blocked for it", async () => {
    const { program, clock, adapter, read } = await rig();
    const soon = new Date(clock.now() + 1000).toISOString();
    program.raiseAsk("conv-01", askOn({ expiresAt: soon }));
    expect((await read()).ok).toBe(true);
    expect(adapter.openAsks("conv-01")?.map((ask) => ask.id)).toContain("ask-extra");
    clock.advance(1000);
    // Nothing moved in the program, so the read is a 304: the clock alone expires the ask.
    expect((await read()).ok).toBe(true);
    expect(program.requests.at(-1)?.path).toBe("/session/v1/snapshot");
    expect(adapter.openAsks("conv-01")?.map((ask) => ask.id)).not.toContain("ask-extra");
  });

  test("askForWire keeps expiresAt for the phone, and an ask without one gains no key", () => {
    const at = "2026-10-15T10:04:00.000Z";
    expect(askForWire(askOn({ expiresAt: at })).expiresAt).toBe(at);
    expect("expiresAt" in askForWire(askOn())).toBe(false);
  });

  test("an expiresAt that is no time is ignored: the ask stays open", () => {
    const snapshot = {
      rev: 1,
      epoch: "e1",
      workspaces: [{ id: "w", title: "W" }],
      tabs: [{ id: "t", workspaceId: "w", title: "T" }],
      panes: [{ id: "p", workspaceId: "w", tabId: "t", title: "P", harness: "x", state: "waiting", lastActiveAt: 0, turnId: "t1", openAsks: [{ ...askOn(), expiresAt: "soon" }] }],
    };
    const parsed = parseSnapshot(JSON.stringify(snapshot), false);
    expect(parsed.ok && parsed.value.panes[0]?.openAsks[0]?.expiresAt).toBeUndefined();
  });
});

describe("label limits on a card", () => {
  /** An ask as a program writes it: a permission with one Allow, then the fields given. */
  function wireAsk(over: JsonObject): JsonObject {
    return { id: "ask-extra", kind: "permission", toolCallId: "call-extra", revision: 1, title: "shell wants to run", itemId: "item-extra", options: [{ id: "allow", label: "Allow", effect: "allow" }], ...over };
  }
  function readAsk(over: JsonObject) {
    const ask = wireAsk(over);
    const snapshot = {
      rev: 1,
      epoch: "e1",
      workspaces: [{ id: "w", title: "W" }],
      tabs: [{ id: "t", workspaceId: "w", title: "T" }],
      panes: [
        {
          id: "p",
          workspaceId: "w",
          tabId: "t",
          title: "P",
          harness: "x",
          state: "waiting",
          lastActiveAt: 0,
          turnId: "t1",
          openAsks: [ask],
          actions: [
            { id: "a1", label: hostileText("Escalate", 300) },
            { id: "a2", label: "​‮⁦" },
          ],
        },
      ],
    };
    const parsed = parseSnapshot(JSON.stringify(snapshot), false);
    if (!parsed.ok) throw new Error(parsed.detail);
    return parsed.value.panes[0]!;
  }

  test("ask title, permission labels, choice labels, field labels and action labels are cleaned and cut", () => {
    const pane = readAsk({ title: hostileText("rm -rf"), options: [{ id: "allow", label: hostileText("Allow"), effect: "allow" }] });
    const ask = pane.openAsks[0]!;
    expect(hasHostileChars(ask.title)).toBe(false);
    expect(Buffer.byteLength(ask.title)).toBeLessThanOrEqual(CAPS.askTitle);
    expect(ask.cleaned).toBe(true);
    expect(hasHostileChars(ask.options[0]!.label)).toBe(false);
    expect(Buffer.byteLength(ask.options[0]!.label)).toBeLessThanOrEqual(CAPS.optionLabel);
    expect([...pane.actions![0]!.label].length).toBeLessThanOrEqual(16);
    expect(hasHostileChars(pane.actions![0]!.label)).toBe(false);

    const choice = readAsk({ kind: "choice", options: [{ id: "a", label: hostileText("Billing") }] }).openAsks[0]!;
    expect(hasHostileChars(choice.options[0]!.label)).toBe(false);
    expect(Buffer.byteLength(choice.options[0]!.label)).toBeLessThanOrEqual(CAPS.optionLabel);

    const form = readAsk({ kind: "form", options: [], fields: [{ id: "f", kind: "toggle", label: hostileText("Refund") }] }).openAsks[0]!;
    expect(hasHostileChars(form.fields![0]!.label)).toBe(false);
    expect(Buffer.byteLength(form.fields![0]!.label)).toBeLessThanOrEqual(CAPS.optionLabel);
  });

  test("a button with no words left after cleaning is dropped, never drawn blank; a field with none is named by its id", () => {
    const invisible = "​‮⁦\u0007";
    const pane = readAsk({
      options: [
        { id: "allow", label: invisible, effect: "allow" },
        { id: "deny", label: "Deny", effect: "deny" },
      ],
    });
    expect(pane.openAsks[0]!.options.map((option) => option.id)).toEqual(["deny"]);
    expect(pane.actions?.map((action) => action.id)).toEqual(["a1"]);
    const choice = readAsk({ kind: "choice", options: [{ id: "a", label: invisible }, { id: "b", label: "B" }] }).openAsks[0]!;
    expect(choice.options.map((option) => option.id)).toEqual(["b"]);
    const form = readAsk({ kind: "form", options: [], fields: [{ id: "agree", kind: "toggle", label: invisible }] }).openAsks[0]!;
    expect(form.fields![0]!.label).toBe("agree");
  });
});
