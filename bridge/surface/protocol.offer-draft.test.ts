// The Send Protocol against the scripted fake multiplexer: an offer is a yes to one draft (ADR 0166).
// Add to it and Replace answer the `draft_present` refusal that showed the person a draft, so they act
// on that draft and on no other. The rig is `protocol.rig.ts`.

import { describe, expect, test } from "bun:test";
import { DIALOG, LIVE_ROW, OFFERED, PROBE, TallOmpPane, omp, rig, useScratchDir, words } from "./protocol.rig.ts";
import { DRAFT_TEXT_MAX } from "./protocol.ts";

useScratchDir();

describe("Add to it and Replace act on the draft the offer showed (ADR 0166)", () => {
  test("another draft in the box at the tap: nothing typed, nothing cleared, the offer made again over the new draft", async () => {
    for (const mode of ["append", "replace"] as const) {
      const { pane, send } = rig();
      pane.box = "half a thought";
      const offer = await send("hello there");
      expect(offer.receipt, mode).toMatchObject({ outcome: "refused", reason: "draft_present" });
      expect(offer.offers, mode).toEqual(["append", "replace", "cancel"]);
      expect(offer.rowsHash, mode).toBeString();
      // At the desk, the person typed another draft before the phone's tap landed.
      pane.box = "a different draft";
      const calls = pane.calls.length;
      const keys = pane.keysSeen.length;
      const answer = await send("hello there", { mode, rowsHash: offer.rowsHash });
      expect(answer.receipt, mode).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
      expect(answer.detail, mode).toBe(offer.detail!);
      expect(answer.offers, mode).toEqual(["append", "replace", "cancel"]);
      expect(answer.rowsHash, mode).toBeString();
      expect(answer.rowsHash, mode).not.toBe(offer.rowsHash);
      expect(pane.calls.length, mode).toBe(calls);
      expect(pane.keysSeen.length, mode).toBe(keys);
      expect(pane.box, mode).toBe("a different draft");
      // The tap on the offer made again acts on the draft it showed.
      const again = await send(mode === "append" ? " and more" : "hello there", { mode, rowsHash: answer.rowsHash });
      expect(again.receipt, mode).toMatchObject({ outcome: "sent" });
      expect(pane.transcript.at(-1), mode).toBe(mode === "append" ? "> a different draft and more" : "> hello there");
    }
  });

  test("the same draft still goes through, idle and in a running turn whose rows move above the box", async () => {
    const idle = rig();
    idle.pane.box = "half a thought";
    const offer = await idle.send("hello there");
    expect((await idle.send(" and the rest", { mode: "append", rowsHash: offer.rowsHash })).receipt).toMatchObject({ outcome: "sent" });
    expect(idle.pane.transcript.at(-1)).toBe("> half a thought and the rest");

    for (const mode of ["append", "replace"] as const) {
      const { pane, send } = rig();
      pane.over = [LIVE_ROW];
      pane.box = "half a thought";
      // The answer streams in above the box: every read shows one more row, so the rows hash moves.
      pane.beforeRead = (p, n) => {
        p.transcript.push(`streamed row ${String(n)}`);
      };
      const inTurn = await send("hello there");
      expect(inTurn.receipt, mode).toMatchObject({ outcome: "refused", reason: "draft_present" });
      const answer = await send(mode === "append" ? " and the rest" : "a new thought", { mode, rowsHash: inTurn.rowsHash });
      expect(answer.receipt, mode).toMatchObject({ outcome: "sent", queued: true });
    }
  });

  test("the box is empty at the tap (the draft went out or was deleted at the desk): the text alone goes out, as the first send wanted", async () => {
    for (const mode of ["append", "replace"] as const) {
      const { pane, send } = rig();
      pane.box = "half a thought";
      const offer = await send("hello there");
      pane.box = "";
      const keys = pane.keysSeen.length;
      const answer = await send("hello there", { mode, rowsHash: offer.rowsHash });
      expect(answer.receipt, mode).toMatchObject({ outcome: "sent" });
      expect(pane.transcript.at(-1), mode).toBe("> hello there");
      // Nothing to clear: the only key is the submit key.
      expect(pane.keysSeen.slice(keys), mode).toEqual(["Enter"]);
    }
  });

  test("a request with no rows hash over a draft is refused as the offer, nothing typed; on an empty box it sends", async () => {
    for (const mode of ["append", "replace"] as const) {
      const { pane, send } = rig();
      pane.box = "half a thought";
      const answer = await send("hello there", { mode });
      expect(answer.receipt, mode).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
      expect(answer.offers, mode).toEqual(["append", "replace", "cancel"]);
      expect(answer.rowsHash, mode).toBeString();
      expect(pane.calls, mode).toEqual([]);
      expect(pane.box, mode).toBe("half a thought");
      pane.box = "";
      expect((await send("hello there", { mode })).receipt, mode).toMatchObject({ outcome: "sent" });
    }
  });

  test("a Replace whose text is a command, over another draft: the offer again is Replace and Cancel only", async () => {
    const { pane, send } = rig();
    pane.box = "old draft";
    const offer = await send("/model", { mode: "command" });
    expect(offer.offers).toEqual(["replace", "cancel"]);
    pane.box = "a newer draft";
    const answer = await send("/model", { mode: "replace", rowsHash: offer.rowsHash });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
    expect(answer.offers).toEqual(["replace", "cancel"]);
    expect(pane.box).toBe("a newer draft");
  });

  test("a dialog at the box at the tap keeps its own refusal, as every other mode does", async () => {
    for (const mode of ["append", "replace"] as const) {
      const { pane, send } = rig();
      pane.box = "half a thought";
      const offer = await send("hello there");
      pane.dialog = ["  Do you want to proceed?", "  ❯ 1. Yes", "    2. No"];
      const answer = await send("hello there", { mode, rowsHash: offer.rowsHash });
      expect(answer.receipt?.outcome, mode).toBe("refused");
      expect(answer.receipt?.reason, mode).not.toBe("draft_present");
      expect(answer.receipt?.keys, mode).toEqual([]);
    }
  });

  test("after a bridge restart the exact hash alone decides: an idle box with the same draft goes through", async () => {
    const first = rig();
    first.pane.box = "half a thought";
    const offer = await first.send("hello there");
    // A new protocol over the same screen remembers no hash, and the screen is the one the offer showed.
    const second = rig();
    second.pane.box = "half a thought";
    expect((await second.send(" and more", { mode: "append", rowsHash: offer.rowsHash })).receipt).toMatchObject({ outcome: "sent" });
  });
});

describe("Replace never empties the draft before its probe passed (Brief 5, item two)", () => {
  // A running turn may open a dialog at any moment: a probe that fails there must find the draft still in the box.
  test("a dialog that opens as Replace's probe goes in, verified and provisional: probe_failed, the draft kept, nothing cleared", async () => {
    for (const version of ["2.1.200", "2.1.301"]) {
      const { pane, send } = rig({ version });
      pane.over = [LIVE_ROW];
      pane.box = "half a thought";
      pane.afterInput = (p, what) => {
        if (what === `type:${PROBE}`) p.dialog = DIALOG;
      };
      const answer = await send("a new thought", { mode: "replace", rowsHash: OFFERED });
      expect(answer.receipt, version).toMatchObject({ outcome: "refused", reason: "probe_failed" });
      expect(pane.keysSeen.filter((key) => key === "Backspace").length, version).toBeLessThanOrEqual(1);
      // The probe character may stay behind the dialog (Collie's own residue, taken out by the next send).
      expect(pane.box.replace(PROBE, ""), version).toBe("half a thought");
      expect(pane.calls.filter((call) => call.includes("a new thought")), version).toEqual([]);
    }
  });

  test("the order on a running turn: the probe goes in after the draft, then the clear, then the text", async () => {
    const { pane, send } = rig({ version: "2.1.301" });
    pane.over = [LIVE_ROW];
    pane.box = "half";
    const answer = await send("a new thought", { mode: "replace", rowsHash: OFFERED });
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
    // The probe and its Backspace first, over the draft; then the clear; then the text, written once.
    expect(answer.receipt?.keys.slice(0, 2)).toEqual(["probe", "Backspace"]);
    expect(answer.receipt?.keys.filter((key) => key === "probe")).toHaveLength(1);
    expect(pane.calls).toEqual([`type:${PROBE}`, "paste:a new thought"]);
    expect(pane.box).toBe("");
  });
});

describe("the offer carries the draft's text from the read of its rows hash (Brief 6)", () => {
  test("the first refusal and the offer made again each carry the box's text as that read showed it", async () => {
    const { pane, send } = rig();
    pane.box = "half a thought";
    const offer = await send("hello there");
    expect(offer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(offer.draftText).toBe("half a thought");
    expect(offer.draftCut).toBeUndefined();
    pane.box = "a different draft";
    const again = await send("hello there", { mode: "replace", rowsHash: offer.rowsHash });
    expect(again.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
    expect(again.draftText).toBe("a different draft");
    // The receipt the bridge keeps holds the hash and the reason, never the draft.
    expect(JSON.stringify(again.receipt)).not.toContain("a different draft");
  });

  test("a draft past the limit is cut from the end at a whole character, with the flag", async () => {
    const { pane, send } = rig();
    // A two-unit character on the boundary: the cut keeps whole code points.
    pane.box = "😀".repeat(DRAFT_TEXT_MAX + 50);
    const offer = await send("hello there");
    expect(offer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(offer.draftCut).toBe(true);
    expect([...offer.draftText!]).toHaveLength(DRAFT_TEXT_MAX);
    // Whole characters only (the box's wrapped rows join with a space, as the protocol reads the box).
    expect(offer.draftText!.replace(/[😀 ]/gu, "")).toBe("");
    expect(offer.draftText!.startsWith("😀😀")).toBe(true);
  });

  test("a box that shows only the end of its draft carries neither field", async () => {
    const pane = new TallOmpPane();
    pane.box = words(3000);
    const { send } = omp({ pane });
    const answer = await send("hello there");
    expect(answer.receipt?.reason).toBe("draft_present");
    expect(answer.draftText).toBeUndefined();
    expect(answer.draftCut).toBeUndefined();
  });

  test("Collie's own probe characters are not part of the draft it shows", async () => {
    const { pane, send } = rig();
    pane.box = `half a thought${PROBE}`;
    const offer = await send("hello there");
    expect(offer.receipt?.reason).toBe("draft_present");
    expect(offer.draftText).toBe("half a thought");
  });
});
