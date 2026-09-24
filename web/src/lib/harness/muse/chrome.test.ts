import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines } from "../../blocks";
import {
  composerPrompt,
  composerReady,
  extractInputDraft,
  extractStatusLines,
  hasComposer,
  stripChrome,
} from "./chrome";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

function lines(name: string) {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

describe("extractInputDraft — the verify half of type-then-verify", () => {
  it("reads the stranded single-line draft verbatim", () => {
    expect(extractInputDraft(lines("muse--draft-single.txt"))).toBe("hello muse draft");
  });

  it("folds a wrapped draft with the single space FOLD_SEAM expects", () => {
    expect(extractInputDraft(lines("muse--draft-wrapped.txt"))).toBe(
      "hello muse draft and this is a much longer continuation meant to force the composer to soft- " +
        "wrap onto a second visual row inside the box",
    );
  });

  it("reads the paste token as the draft (the paste grammar verifies it, not this)", () => {
    expect(extractInputDraft(lines("muse--draft-paste-token.txt"))).toBe(
      "[Pasted Content 3003 chars]",
    );
  });

  it("folds a blank paragraph break out of the draft (#274)", () => {
    expect(extractInputDraft(lines("muse--draft-blank-row.txt"))).toBe(
      "hello muse draft second paragraph",
    );
  });

  it("reads a slash command alone when the palette names that same command (#276)", () => {
    expect(extractInputDraft(lines("muse--palette-exact.txt"))).toBe("/usage");
  });

  it("keeps the legacy polluted read on partial palette input, stalling safe (#276)", () => {
    // `/us` + Enter accepts the highlighted suggestion (probed: ran `/usage`), so verifying
    // the typed text would bless a command the operator did not type. The mismatch stalls.
    expect(extractInputDraft(lines("muse--palette-partial.txt"))).toBe(
      "/us /usage  Show session usage",
    );
  });

  it("reads attach tokens verbatim (the attach grammar verifies them, not this) (#278)", () => {
    expect(extractInputDraft(lines("muse--draft-image-chip.txt"))).toBe("[Image #1]");
    expect(extractInputDraft(lines("muse--draft-quoted-path.txt"))).toBe(
      '"/tmp/repro-before.txt"',
    );
  });

  it("returns null for an empty box, the placeholder tip, and dialogs", () => {
    expect(extractInputDraft(lines("muse--fresh-idle.txt"))).toBeNull();
    expect(extractInputDraft(lines("muse--working.txt"))).toBeNull();
    // The done capture's box holds the "Start a message with !…" tip — not a draft.
    expect(extractInputDraft(lines("muse--done.txt"))).toBeNull();
    // The tip rotates: the /loop variant is a placeholder too, not a ghost draft (#274).
    expect(extractInputDraft(lines("muse--tip-loop.txt"))).toBeNull();
    // The tip rotates per context: the paste variant is a placeholder too (#278).
    expect(extractInputDraft(lines("muse--tip-paste.txt"))).toBeNull();
    expect(extractInputDraft(lines("muse--approval-ls.txt"))).toBeNull();
    expect(extractInputDraft(lines("muse--approval-network.txt"))).toBeNull();
    expect(extractInputDraft(lines("muse--ask-color.txt"))).toBeNull();
    expect(extractInputDraft(lines("muse--ask-toppings.txt"))).toBeNull();
    expect(extractInputDraft(lines("muse--ask-toppings-review.txt"))).toBeNull();
    expect(extractInputDraft(lines("muse--trust-prompt.txt"))).toBeNull();
    expect(extractInputDraft(lines("muse--ask-color-notes-typed.txt"))).toBeNull();
    expect(extractInputDraft(lines("muse--quoted-dialogs-bare.txt"))).toBeNull();
  });
});

describe("the tail walk over blank rows stays inside the box (#274)", () => {
  // The walk now steps over blank rows, so the rows that stop it carry the safety: the `›` pointer
  // and the column-0 question. An unmeasured box-less dialog with its pointer torn off is the case
  // where the walk crosses blanks furthest, and it must still find no box and draw the card.
  it("an unknown box-less dialog with no pointer still reads as no composer", () => {
    const raw = readFileSync(join(PANES_DIR, "muse--approval-ls.txt"), "utf8")
      .replace("Would you like to run the following command?", "Would you like to open this file now? ")
      .replace("›", " ");
    const torn = splitLines(parseAnsi(raw));
    expect(hasComposer(torn)).toBe(false);
    expect(composerReady(torn)).toBe(false);
    expect(extractInputDraft(torn)).toBeNull();
  });
});

describe("extractStatusLines — the resurfaced statusline", () => {
  it("returns the styled status row on chrome screens, nothing on trust", () => {
    for (const name of ["muse--fresh-idle.txt", "muse--done.txt", "muse--approval-ls.txt"]) {
      const rows = extractStatusLines(lines(name));
      expect(rows.length, name).toBe(1);
      expect(lineText(rows[0]!).trim().startsWith("muse-spark-1.3"), name).toBe(true);
    }
    expect(extractStatusLines(lines("muse--trust-prompt.txt"))).toEqual([]);
  });
});

describe("stripChrome — the composer tail off the mirror", () => {
  it("removes voice rule + prompt + bottom rule + statusline, keeps the transcript", () => {
    const before = lines("muse--draft-single.txt");
    const after = stripChrome(before);
    expect(after.length).toBeLessThan(before.length);
    const text = after.map((l) => lineText(l)).join("\n");
    expect(text).toContain("Muse Code 1.3.0");
    expect(text).not.toContain("hello muse draft");
    expect(text).not.toContain("muse-spark-1.3");
  });

  it("leaves a chromeless buffer untouched (same reference)", () => {
    const trust = lines("muse--trust-prompt.txt");
    expect(stripChrome(trust)).toBe(trust);
  });
});

describe("composerPrompt — the sweep's binding region", () => {
  it("names the ❯ row verbatim when the composer is ready", () => {
    expect(composerPrompt(lines("muse--draft-single.txt"))).toBe("❯ hello muse draft");
    expect(composerPrompt(lines("muse--fresh-idle.txt"))).toBe("❯");
  });

  it("is null exactly where composerReady is false", () => {
    for (const name of [
      "muse--approval-ls.txt",
      "muse--approval-network.txt",
      "muse--ask-color.txt",
      "muse--ask-toppings.txt",
      "muse--ask-toppings-review.txt",
      "muse--trust-prompt.txt",
      "muse--ask-color-notes-open.txt",
    ]) {
      expect(composerReady(lines(name)), name).toBe(false);
      expect(composerPrompt(lines(name)), name).toBeNull();
    }
  });
});
