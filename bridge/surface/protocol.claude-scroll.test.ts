import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProfiles, profileFor, type Profile, type VersionRange } from "../../web/src/lib/surface/profile.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { muxAck, muxOk } from "../mux/types.ts";
import { ClearService } from "./clear.ts";
import { KeyGate } from "./key-gate.ts";
import { boxMatches, boxMatchesTail } from "./protocol.ts";
import { DIALOG, FakePane, rig, useScratchDir } from "./protocol.rig.ts";

const SENT =
  "This message is long enough that in a small pane it wraps past the height of the Claude Code input box. When that happens Claude Code scrolls the box and draws an up arrow with a count of hidden lines in the top border, and the prompt line with the caret scrolls out of view. Collie looks for that prompt line to find the box, so it cannot find it, and the send stops after typing without pressing Enter.";
const FIXTURE = join(import.meta.dirname, "..", "..", "web", "src", "fixtures", "panes", "claude--v2331-draft-scrolled-up--w59.txt");

describe("Claude Code 2.1.331 box scrolled to `↑ 5 more` after a 404-char send", () => {
  const rows = splitLines(parseAnsi(readFileSync(FIXTURE, "utf8")));
  const read = surfaceOfScreen({ seq: 0, source: "screen", at: 0, revision: 1, rows, ask: null }, loadProfiles().get("claude")!.idle);

  test("the screen reads as an idle box holding a draft, not unknown/no-match", () => {
    expect(read.frame?.scrolled).toBe(true);
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
  });

  test("S1 confirms the send by the tail: the box shows only the end of what was typed", () => {
    const box = read.frame!.interior.text;
    expect(boxMatches(box, "", [SENT], null)).toBe(false);
    expect(boxMatchesTail(box, "", [SENT])).toBe(true);
    expect(boxMatchesTail(box, "", [SENT.replace("without pressing", "after pressing")])).toBe(false);
  });

  test("a view with no text is the tail of nothing", () => {
    expect(boxMatchesTail("", "", [SENT])).toBe(false);
    expect(boxMatchesTail("   ", "", [SENT])).toBe(false);
  });
});

useScratchDir();

const GREY = (s: string): string => `\u001b[38;2;136;136;136m${s}\u001b[0m`;
const RULE = "─".repeat(40);
/** The draft rows the fake box shows before it scrolls. */
const CAP = 3;

/**
 * A Claude pane whose box scrolls as Claude Code 2.1.331 does: past {@link CAP} draft rows the top edge
 * reads `─── ↑ N more ───`, only the last rows stay in view, and the `❯` row leaves the view.
 */
class ScrolledClaudePane extends FakePane {
  override render(): string {
    if (this.dialog !== null || this.box === "") return super.render();
    const rows: string[] = [];
    this.box.split("\n").forEach((line, li) => {
      const chunks = line.length === 0 ? [""] : (line.match(/.{1,38}/gu) ?? [""]);
      chunks.forEach((chunk, ci) => rows.push(li === 0 && ci === 0 ? `❯ ${chunk}` : `  ${chunk}`));
    });
    const out = [...this.transcript, ""];
    if (rows.length <= CAP) out.push(GREY(RULE), ...rows, GREY(RULE));
    else {
      const label = `─── ↑ ${String(rows.length - CAP)} more `;
      const shown = rows.slice(-CAP).map((row) => (row.startsWith("❯") ? `  ${row.slice(2)}` : row));
      out.push(GREY(label + "─".repeat(40 - [...label].length)), ...shown, GREY(RULE));
    }
    out.push(...this.status);
    return out.join("\n");
  }
}

const LONG = "This message is long enough that it wraps past the height of the input box, so the box scrolls and draws an up arrow.";
const idle = loadProfiles().get("claude")!.idle;
const readOf = (text: string): ReturnType<typeof surfaceOfScreen> =>
  surfaceOfScreen({ seq: 0, source: "screen", at: 0, revision: 1, rows: splitLines(parseAnsi(text)), ask: null }, idle);

describe("a send into a Claude box that scrolls while Collie types", () => {
  test("an empty box, a long send: the box scrolls, S1 confirms by the tail, Enter goes, sent", async () => {
    const pane = new ScrolledClaudePane();
    const { send } = rig({ pane });
    const answer = await send(LONG);
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(answer.receipt?.detail).toContain("compared those with the end of the text");
    expect(pane.transcript.at(-1)).toBe(`> ${LONG}`);
    expect(pane.box).toBe("");
  });

  test("the same send with one word changed in the view: no Enter", async () => {
    const pane = new ScrolledClaudePane();
    pane.afterInput = (p) => {
      p.box = p.box.replace("up arrow", "up arrows");
    };
    const { send } = rig({ pane });
    const answer = await send(LONG);
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.transcript.some((row) => row.includes("up arrow"))).toBe(false);
  });

  test("the person's draft ending in blank rows (a scrolled box whose view is blank) is no empty box: refused, no key", async () => {
    const pane = new ScrolledClaudePane();
    const draft = "rm -rf the build folder and then push to main\nsecond line of my own words\n\n\n";
    pane.box = draft;
    const s0 = readOf(pane.render());
    expect(s0.frame?.scrolled).toBe(true);
    expect(s0.frame?.interior.text).toBe("");
    expect(s0.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    const { send } = rig({ pane });
    const answer = await send("yes please");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
    expect(pane.calls).toEqual([]);
    expect(pane.box).toBe(draft);
  });

  test("a `↑ N more` row and a rule in the transcript over a dialog make no box: the screen reads as with none", () => {
    const pane = new ScrolledClaudePane();
    pane.transcript = ["> an earlier question", "─── ↑ 5 more ───────────────────────────", "  of view. Collie looks for that prompt", "  typing without pressing Enter.", RULE];
    pane.dialog = DIALOG;
    const read = readOf(pane.render());
    expect(read.frame).toBeNull();
    expect(read.surface).toMatchObject({ turn: "unknown", modal: "unreadable", composer: "unknown" });
  });

  test("Clear on the person's scrolled draft is refused before any key: nothing deleted", async () => {
    const pane = new ScrolledClaudePane();
    const draft = "HEAD my own long draft at the desk, the first part matters and it goes on past the cap of three rows of the box, so more words here, TAIL";
    pane.box = draft;
    const written: string[] = [];
    const mux = {
      readGrid: (paneId: string) => Promise.resolve(muxOk({ paneId, text: pane.render(), truncated: false, revision: 0 })),
      typeText: (_paneId: string, text: string) => {
        written.push(text);
        return Promise.resolve(muxAck());
      },
      writeKeys: (_paneId: string, keys: readonly string[]) => {
        written.push(...keys);
        return Promise.resolve(muxAck());
      },
    };
    const versions: readonly [VersionRange] = [
      { range: "0.0.0 - *", status: "verified", low: "0.0.0", high: null, verifiedThrough: "2.1.331", verifiedOn: "2026-11-24" },
    ];
    const profiles = new Map<string, Profile>([["claude", { ...loadProfiles().get("claude")!, versions }]]);
    const service = new ClearService({
      staleFrame: () => undefined,
      mux,
      gate: new KeyGate(mux),
      profile: (harness: string) => Promise.resolve(profileFor(harness, "2.1.331", { log: () => undefined, profiles })),
      sleep: () => Promise.resolve(),
    });
    const answer = await service.handle("clr-scrolled", "%1", "claude");
    expect(answer).toMatchObject({ kind: "receipt", receipt: { outcome: "refused", reason: "unreadable" }, pressed: false });
    expect(written).toEqual([]);
    expect(pane.box).toBe(draft);
  });
});
