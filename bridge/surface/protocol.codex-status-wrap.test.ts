// The Send Protocol on a Codex pane whose status row wrapped under the box (#838). On a narrow pane Codex
// wraps the status row that is the box's bottom edge, and the row it wraps onto has the edge's shape too.
// No box was found there, so a send was refused and the phone showed the unread-dialog card. The profile now
// says its bottom edge may wrap onto one more row (`idle.frame.bottomWraps`), and the send probe reads the
// same frame module, so the fix reaches it with no code of its own.
//
// The captured-pane cases replay the constructed fixtures `codex--v0166-core-idle-status-wrap--w56.txt` and
// `codex--v0167-working-status-wrap--w39.txt` (web/src/fixtures/panes/README.md says how they were made and
// why no capture exists yet). The fake-pane cases draw the same wrap on the rig's Codex pane.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "../../web/src/lib/surface/profile.ts";
import { FakePane, rig, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

// eslint-disable-next-line no-control-regex
const plain = (row: string): string => row.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/gu, "");
const capture = (name: string): string[] => readFileSync(join(import.meta.dirname, "..", "..", "web", "src", "fixtures", "panes", name), "utf8").replace(/\n$/u, "").split("\n");

/** The Codex profile as it was before #838: every field but `bottomWraps`. */
const unwrapped = (profile: Profile): Profile => {
  const { bottomWraps: _wraps, ...frame } = profile.idle.frame;
  void _wraps;
  return { ...profile, idle: { ...profile.idle, frame } };
};

/** The rig's Codex pane with its status row wrapped onto two rows, as Codex draws it on a narrow pane. */
function wrappedPane(): FakePane {
  const pane = new FakePane("codex");
  pane.codexStatus = "  GPT-6-Luna low · /home/demo/sandbox/collie-\n  labs/project · Fix the parser";
  return pane;
}

/** Codex's approval prompt, drawn in the box's place (codex--approval-exec.txt). */
const APPROVAL = ["  Would you like to run the following command?", "", "  $ touch notes.txt", "", "› 1. Yes, proceed (y)", "  2. No, and tell Codex what to do differently (esc)", "", "  Press enter to confirm or esc to cancel"];

const submitKeys = (pane: FakePane): string[] => pane.keysSeen.filter((key) => key === "Tab" || key === "Enter");

describe("a send to a Codex pane whose status row wrapped (#838), on the rig's pane", () => {
  test("the profile sets the wrap", async () => {
    const { loadProfiles } = await import("../../web/src/lib/surface/profile.ts");
    expect(loadProfiles().get("codex")?.idle.frame.bottomWraps).toBe(1);
  });

  test("a message is sent: the probe reads the box, the wrapped row stays the same row, and Tab submits", async () => {
    const pane = wrappedPane();
    const answer = await rig({ pane, harness: "codex", version: "0.166.0" }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Tab"] });
    expect(pane.transcript.at(-1)).toBe("› reply with one word: ready");
  });

  test("a command is sent", async () => {
    const pane = wrappedPane();
    const answer = await rig({ pane, harness: "codex", version: "0.166.0" }).send("/status", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
  });

  test("without the field the same pane is refused with no key, the screen read as no box, as the report saw it", async () => {
    const pane = wrappedPane();
    const answer = await rig({ pane, harness: "codex", version: "0.166.0", edit: unwrapped }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [], saw: { modal: "unknown", composer: "unknown", reason: "no-match" } });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a draft in the box is still read as a draft: refused draft_present, the draft kept", async () => {
    const pane = wrappedPane();
    pane.box = "x";
    const answer = await rig({ pane, harness: "codex", version: "0.166.0" }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(pane.box).toBe("x");
    expect(submitKeys(pane)).toEqual([]);
  });

  test("a dialog drawn in the box's place before the send blocks it", async () => {
    const pane = wrappedPane();
    pane.dialog = APPROVAL;
    const answer = await rig({ pane, harness: "codex", version: "0.166.0" }).send("reply with one word: ready");
    expect(answer.receipt?.outcome).toBe("refused");
    expect(pane.keysSeen).toEqual([]);
  });

  test("a dialog that opens after the probe blocks: no submit key", async () => {
    const pane = wrappedPane();
    pane.afterInput = (self, what) => {
      if (what.startsWith("type:")) self.dialog = APPROVAL;
    };
    const answer = await rig({ pane, harness: "codex", version: "0.166.0" }).send("reply with one word: ready");
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(submitKeys(pane)).toEqual([]);
  });

  test("a dialog's key row of the edge's shape under a wrapped status row is past the bound: no box, no key", async () => {
    const pane = wrappedPane();
    pane.codexHint = "  enter confirm · esc skip";
    const answer = await rig({ pane, harness: "codex", version: "0.166.0" }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "refused", keys: [], saw: { modal: "unreadable" } });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a dialog's key row of the edge's shape under a one-row status that fills the read blocks: the cues read the row the edge wrapped onto", async () => {
    const pane = new FakePane("codex");
    pane.codexStatus = "  GPT-6-Luna low · /home/demo/sandbox/collie-labs/project";
    pane.codexHint = "  enter confirm · esc skip";
    const answer = await rig({ pane, harness: "codex", version: "0.166.0" }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "refused", keys: [], saw: { turn: "idle", modal: "unreadable", composer: "empty" } });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a dialog above the box blocks as it does over a one-row status", async () => {
    for (const status of ["  GPT-6-Luna low · ~/project", wrappedPane().codexStatus]) {
      const pane = new FakePane("codex");
      pane.codexStatus = status;
      pane.over = APPROVAL;
      const answer = await rig({ pane, harness: "codex", version: "0.166.0" }).send("reply with one word: ready");
      expect(answer.receipt, status).toMatchObject({ outcome: "refused", keys: [], saw: { modal: "unreadable" } });
      expect(pane.keysSeen, status).toEqual([]);
    }
  });
});

describe("a send on the constructed wrapped-status screens (#838)", () => {
  /** A pane drawn from a capture: the hint row goes and the box row shows the box once it holds text, as Codex draws it. */
  function capturedPane(rows: readonly string[], typedHint: string | null = null): FakePane {
    const at = rows.findLastIndex((row) => plain(row).startsWith("› "));
    const hint = rows.findLastIndex((row) => plain(row).includes("for agents"));
    const pane = new FakePane("codex");
    pane.render = () =>
      (pane.box === "" ? rows : rows.flatMap((row, i) => (i === at ? [`\u001b[1m›\u001b[0m ${pane.box}`] : i === hint ? (typedHint === null ? [] : [typedHint]) : [row]))).join("\n");
    return pane;
  }

  test("the styled working screen at 39 columns takes a message as the same screen at 120 columns does", async () => {
    // In a turn Codex swaps the hint row for its queue hint once the box holds text.
    for (const name of ["codex--v0167-working-status-wrap--w39.txt", "codex--v0167-working--w120.txt"]) {
      const pane = capturedPane(capture(name), "  tab to queue message");
      const answer = await rig({ pane, harness: "codex", version: "0.167.0" }).send("reply with one word: ready");
      expect(answer.receipt, name).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Tab"] });
    }
  });

  test("the idle screen at 56 columns takes a message", async () => {
    const pane = capturedPane(capture("codex--v0166-core-idle-status-wrap--w56.txt"));
    const answer = await rig({ pane, harness: "codex", version: "0.166.0" }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Tab"] });
  });

  test("the idle screen at 56 columns is not sent to without the field", async () => {
    const pane = capturedPane(capture("codex--v0166-core-idle-status-wrap--w56.txt"));
    const answer = await rig({ pane, harness: "codex", version: "0.166.0", edit: unwrapped }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "unconfirmed", keys: [] });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a draft on that screen is refused draft_present", async () => {
    const pane = capturedPane(capture("codex--v0166-core-idle-status-wrap--w56.txt"));
    pane.box = "x";
    const answer = await rig({ pane, harness: "codex", version: "0.166.0" }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(pane.box).toBe("x");
  });
});
