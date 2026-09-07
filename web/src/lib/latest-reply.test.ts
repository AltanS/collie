import { fold, locateReply, newestReply, PROBE_CHARS, replyProse } from "./latest-reply";
import type { TranscriptEntry, TranscriptPart } from "./types";

// The predicates behind "the mirror is only showing the end of this reply". The cases that matter are
// the ones where the two sides of the comparison are written differently — Markdown source against a
// rendered, hard-wrapped, SGR-coloured screen — and the one where they are different MESSAGES.

function turn(
  role: TranscriptEntry["role"],
  text: string,
  extra: { uuid?: string; truncated?: boolean } = {},
): TranscriptEntry {
  const parts: TranscriptPart[] = [
    extra.truncated ? { kind: "text", text, truncated: true } : { kind: "text", text },
  ];
  return {
    uuid: extra.uuid ?? `${role}-${text.slice(0, 8)}`,
    ts: "2026-08-28T10:00:00.000Z",
    role,
    parts,
  };
}

// A reply comfortably longer than two probes, with Markdown in it.
const REPLY = [
  "Short answer: **approve-only**. The author knows when they want it to land; your job was the",
  "approval. Enabling auto-merge makes you the actor for the merge itself, which is a materially",
  "bigger claim than \"this looks fine to me\".",
  "",
  "- `deployment_tools` gates production, so an automated approval there is a different risk class.",
  "- A fast manual approval keeps your name on something you actually saw.",
].join("\n");

/** Wrap text the way a terminal does — at word boundaries, with continuation rows indented. */
function hardWrap(text: string, cols: number): string {
  return text
    .split("\n")
    .flatMap((line) => {
      const rows: string[] = [];
      let row = "";
      for (const word of line.split(" ")) {
        const candidate = row === "" ? word : `${row} ${word}`;
        if (candidate.length > cols && row !== "") {
          rows.push(row);
          row = word;
        } else {
          row = candidate;
        }
      }
      rows.push(row);
      return rows.map((r, i) => (i === 0 ? r : `  ${r}`));
    })
    .join("\n");
}

/** What Claude paints: no Markdown markers, emphasis as SGR, an ⏺ lead, hard-wrapped. */
function rendered(text: string, cols = 40): string {
  const painted = text.replace(/\*\*(.+?)\*\*/g, "\x1b[1m$1\x1b[0m").replace(/`/g, "");
  return `⏺ ${hardWrap(painted, cols)}`;
}

describe("fold", () => {
  it("erases every difference between Markdown source and a wrapped, coloured render", () => {
    // The SGR-painted form "\x1b[1mbold\x1b[0m text" reaches fold with its escapes already stripped.
    expect(fold("**bold** text")).toBe(fold("bold text"));
    expect(fold("hello world")).toBe(fold("hello\n  world"));
    expect(fold("- a bullet")).toBe(fold("  • a bullet"));
  });

  it("keeps non-Latin content rather than folding it away", () => {
    expect(fold("こんにちは、世界")).toBe("こんにちは世界");
  });
});

describe("newestReply", () => {
  const entries: TranscriptEntry[] = [
    turn("user", "what should I do?"),
    turn("assistant", "first thought"),
    turn("assistant", "second thought"),
  ];

  it("picks the last assistant turn carrying prose", () => {
    expect(replyProse(newestReply(entries)!)).toBe("second thought");
  });

  it("skips a trailing turn that is only a tool call", () => {
    const toolOnly: TranscriptEntry = {
      uuid: "tool",
      ts: "",
      role: "assistant",
      parts: [{ kind: "tool", name: "Bash", summary: "ls" }],
    };
    expect(replyProse(newestReply([...entries, toolOnly])!)).toBe("second thought");
  });

  it("returns null when the agent has not spoken", () => {
    expect(newestReply([turn("user", "hello")])).toBeNull();
  });
});

describe("locateReply", () => {
  const fitOf = (mirror: string, entry: TranscriptEntry) => locateReply(mirror, entry).fit;
  const reply = turn("assistant", REPLY);

  it("calls it clipped when the tail is painted but the opening has scrolled off", () => {
    const screen = rendered(REPLY).split("\n").slice(4).join("\n");
    expect(fitOf(screen, reply)).toBe("clipped");
  });

  it("calls it whole when the whole message is on screen, markers and colour notwithstanding", () => {
    expect(fitOf(rendered(REPLY), reply)).toBe("whole");
  });

  it("survives a pane narrow enough to wrap every line several times", () => {
    const screen = rendered(REPLY, 18).split("\n").slice(6).join("\n");
    expect(fitOf(screen, reply)).toBe("clipped");
  });

  // The identity check: the journal's newest reply is not automatically the one being displayed.
  it("calls it off-screen when the mirror is showing some other message", () => {
    expect(fitOf(rendered("a completely different answer about something else"), reply)).toBe(
      "off-screen",
    );
  });

  it("calls it off-screen when the mirror has moved on past this reply entirely", () => {
    const screen = `${rendered(REPLY).split("\n").slice(0, 3).join("\n")}\n⏺ and then a new message`;
    expect(fitOf(screen, reply)).toBe("off-screen");
  });

  // A clamped part's real ending never reaches us, so the tail probe could never match — say so
  // explicitly rather than leaving it to fall out of the probe.
  it("calls it off-screen when the bridge clamped the part", () => {
    expect(fitOf(rendered(REPLY), turn("assistant", REPLY, { truncated: true }))).toBe(
      "off-screen",
    );
  });

  it("calls a reply shorter than two probes whole without probing at all", () => {
    const short = turn("assistant", "a".repeat(PROBE_CHARS * 2 - 10));
    expect(fitOf("nothing of the sort is on this screen", short)).toBe("whole");
  });

  // SGR parameters are digits, and digits survive the fold — an unstripped escape would corrupt the
  // probe it landed in. parseAnsi runs first precisely so it cannot.
  it("does not let SGR parameters leak into the comparison", () => {
    const coloured = `\x1b[38;5;213m${REPLY}\x1b[0m`;
    expect(fitOf(coloured, reply)).toBe("whole");
  });
});

// endLine is what lets the caller REPLACE the clipped rows instead of printing the message twice, so
// it has to name the row the reply actually finishes on — not the screen's last row.
describe("locateReply — where the reply ends", () => {
  const reply = turn("assistant", REPLY);

  it("names the last row of the reply, with the terminal's own tail below it", () => {
    const painted = rendered(REPLY).split("\n").slice(4); // clipped: the opening is gone
    const after = ["", "⏺ Bash(git log --oneline)", "  ⎿ abc1234 fix"];
    const { fit, endLine } = locateReply([...painted, ...after].join("\n"), reply);

    expect(fit).toBe("clipped");
    // The reply's own rows are 0..endLine, and everything the agent did afterwards survives.
    expect(endLine).toBe(painted.length - 1);
    expect([...painted, ...after].slice(endLine + 1)).toEqual(after);
  });

  it("names the final row when the reply is the last thing painted", () => {
    const painted = rendered(REPLY).split("\n").slice(4);
    const { endLine } = locateReply(painted.join("\n"), reply);
    expect(endLine).toBe(painted.length - 1);
  });

  // Nothing may be hidden on a verdict that isn't `clipped` — -1 makes a caller that forgets to check
  // hide nothing rather than hide a row.
  it("reports no row at all when the reply is not the clipped message on screen", () => {
    expect(locateReply("some other screen entirely", reply).endLine).toBe(-1);
    expect(locateReply(rendered(REPLY), reply).endLine).toBe(-1);
  });
});
