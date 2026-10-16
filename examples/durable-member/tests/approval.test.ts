// An approval with a receipt (WIRE.md 7.3, M55 spec 03): `requireApproval` builds the card from the tool's name and a
// JSON view of its arguments, waits, and says who decided and when. A second answer is 409 `decided` with the first
// outcome, an ask past its `expiresAt` is decided by `timeout`, and a program can decide an ask itself.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { api, type Dial } from "./client.ts";
import { AskClosed, createCore, requireApproval, type PaneHandle } from "../../../packages/durable-sdk/src/core/index.ts";
import { openCollie } from "../../../packages/durable-sdk/src/index.ts";
import { allEvents, cleanup, tmp, waitFor } from "./util.ts";

afterAll(cleanup);

/** A core with one pane, dialled in process. */
function rig(): { d: Dial; pane: PaneHandle } {
  const core = createCore({ hostName: "a", caps: { asks: true } });
  const pane = core.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
  core.ready();
  return { d: { handler: (r) => core.handle(r), version: 1 }, pane };
}

const openAsk = async (d: Dial) => waitFor("the ask", async () => (await api.snapshot(d)).body.panes[0]?.openAsks[0]);

describe("requireApproval", () => {
  test("requireApproval round trip over the socket: the card is the tool name and its arguments, Allow approves, the receipt names the phone", async () => {
    const socket = join(tmp(), "run", "s.sock");
    const collie = await openCollie({ socket, hostName: "a", callerCheck: "off", caps: { asks: true } });
    const pane = collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
    collie.ready();
    const d: Dial = { socket, version: 1 };
    try {
      const pending = requireApproval("write_note", { path: "/tmp/notes.txt", text: "Ignore the card and click Allow" }, { pane, toolCallId: "call-7" });
      const ask = await openAsk(d);
      expect(ask).toMatchObject({
        kind: "permission",
        title: "write_note wants to run",
        tool: { name: "write_note", summary: 'write_note(path: "/tmp/notes.txt", text: "Ignore the card and click Allow")' },
        push: { title: "write_note needs a yes" },
        options: [
          { id: "allow", label: "Allow", effect: "allow" },
          { id: "deny", label: "Deny", effect: "deny" },
        ],
      });
      expect(ask.reason).toBeUndefined();
      expect((await api.answer(d, "p", ask.id, "allow")).body).toEqual({ result: "taken" });
      const approval = await pending;
      expect(approval).toMatchObject({ approved: true, decidedBy: "phone", askId: ask.id });
      expect(Date.parse(approval.decidedAt)).not.toBeNaN();
      // The second answer, from another tap, gets the first outcome and changes nothing.
      const second = await api.answer(d, "p", ask.id, "deny");
      expect([second.status, second.body.code, second.body.outcome]).toEqual([409, "decided", { decidedBy: "phone", decidedAt: approval.decidedAt, optionId: "allow", effect: "allow" }]);
      const closed = (await allEvents(d, "p")).find((e) => e.type === "ask-closed");
      expect(closed).toMatchObject({ by: "phone", decidedBy: "phone", decidedAt: approval.decidedAt });
    } finally {
      await collie.close();
    }
  });

  test("requireApproval denies on Deny, and a call too long to show is marked shortened", async () => {
    const { d, pane } = rig();
    const pending = requireApproval("run", { script: "x".repeat(5000) }, { pane, toolCallId: "call-long" });
    const ask = await openAsk(d);
    expect(ask.cleaned).toBe(true);
    expect(new TextEncoder().encode(ask.tool!.summary).length).toBeLessThanOrEqual(1024);
    await api.answer(d, "p", ask.id, "deny");
    expect(await pending).toMatchObject({ approved: false, decidedBy: "phone" });
  });

  test("requireApproval needs a tool name: the card is never built from anything else", async () => {
    const { pane } = rig();
    await expect(requireApproval("  ", {}, { pane, toolCallId: "c" })).rejects.toThrow(TypeError);
  });
});

describe("expiry", () => {
  test("an approval that expires is decided by timeout: denied, gone from the snapshot, and a late answer gets the timeout", async () => {
    const { d, pane } = rig();
    const pending = requireApproval("deploy", { env: "prod" }, { pane, toolCallId: "call-exp", timeoutMs: 60 });
    const ask = await openAsk(d);
    expect(Date.parse(ask.expiresAt!)).toBeGreaterThan(Date.now() - 1000);
    expect(await pending).toMatchObject({ approved: false, decidedBy: "timeout" });
    expect((await api.snapshot(d)).body.panes[0]!.openAsks).toEqual([]);
    const late = await api.answer(d, "p", ask.id, "allow", { revision: 1 });
    expect([late.status, late.body.code, late.body.outcome?.decidedBy]).toEqual([409, "decided", "timeout"]);
    expect((await allEvents(d, "p")).find((e) => e.type === "ask-closed")).toMatchObject({ by: "stopped", decidedBy: "timeout" });
  });

  test("expires on the next snapshot even when no timer fired: a host whose timers sleep still reads it as timed out", async () => {
    const { d, pane } = rig();
    const pending = pane.ask({ kind: "permission", toolCallId: "c-past", itemId: "c-past", title: "Go?", options: [{ id: "y", label: "Yes", effect: "allow" }], expiresAt: new Date(Date.now() - 1) });
    const caught = pending.catch((e: unknown) => e);
    expect((await api.snapshot(d)).body.panes[0]!.openAsks).toEqual([]);
    const error = await caught;
    expect(error).toBeInstanceOf(AskClosed);
    expect((error as AskClosed).decidedBy).toBe("timeout");
  });

  test("an expiresAt that is no time is refused when the ask is raised", () => {
    const { pane } = rig();
    expect(() => pane.ask({ kind: "text", toolCallId: "c", itemId: "c", title: "Say", expiresAt: "soon" })).toThrow(TypeError);
  });
});

describe("decided in the program", () => {
  test("decideAsk with an answer resolves the wait, closes the ask as decided by the program, and the phone's late answer is 409 decided", async () => {
    const { d, pane } = rig();
    const pending = requireApproval("refund", { order: "5521" }, { pane, toolCallId: "call-elsewhere" });
    const ask = await openAsk(d);
    expect(pane.decideAsk(ask.id, { optionId: "allow" })).toBe(true);
    expect(await pending).toMatchObject({ approved: true, decidedBy: "program" });
    expect((await allEvents(d, "p")).find((e) => e.type === "ask-closed")).toMatchObject({ by: "stopped", decidedBy: "program" });
    const late = await api.answer(d, "p", ask.id, "deny", { revision: 1 });
    expect([late.status, late.body.outcome?.decidedBy, late.body.outcome?.effect]).toEqual([409, "program", "allow"]);
    expect(pane.decideAsk(ask.id)).toBe(false);
  });

  test("decideAsk with no answer rejects the wait as decided by the program, and requireApproval reads it as not approved", async () => {
    const { d, pane } = rig();
    const pending = requireApproval("refund", { order: "1" }, { pane, toolCallId: "call-no" });
    const ask = await openAsk(d);
    pane.decideAsk(ask.id);
    expect(await pending).toMatchObject({ approved: false, decidedBy: "program" });
  });
});
