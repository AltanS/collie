import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { TRICK_CONTRACT_DEFAULT, type TrickManifest } from "../../web/src/lib/tricks/schema.ts";
import { NOTES_FILE, NOTES_VERSION, sampleAgents, shippedNotesTexts, shippedNotesVersion } from "./agents-notes.ts";
import { helperNote, NOTES_DIFF_LINES_FACTOR, notesChangedNote, shippedNotesDiff } from "./card-group.ts";
import { proposalCard, proposalDiff, type ProposerFacts } from "./proposal-card.ts";
import { TRICK_HELPER } from "./scan.ts";

// THE NOTES COLLIE SHIPS ARE NAMED, NOT SHOWN (the first full trick run, 2026-11-16, decision 10). The
// AGENTS.md `collie trick init` writes filled the cards of every proposal from a fresh folder.

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const WHO: ProposerFacts = { by: "agent", host: "workshop", label: "repo#one" };
const SH: TrickManifest = { id: "legs", name: "Legs", run: "./program.sh", mode: "once", contract: TRICK_CONTRACT_DEFAULT, icon: "plug", places: ["belt"] };
const TS: TrickManifest = { ...SH, run: "program.ts" };
const PROGRAM_SH = "#!/bin/sh\nprintf '{\"v\":1,\"parts\":[]}\\n'\n";

function cardText(manifest: TrickManifest, files: Record<string, string>): string {
  const list = Object.entries(files).map(([rel, text]) => ({ rel, bytes: enc(text) }));
  const made = proposalCard({ id: manifest.id, manifest, proposer: WHO, warnings: [], crew: false, sizes: new Map(list.map((f) => [f.rel, f.bytes.byteLength])), ...proposalDiff(manifest.id, list) });
  if (!made.ok) throw new Error(made.error);
  return JSON.stringify(made.card);
}

describe("the notes init writes", () => {
  test("their text is pinned to NOTES_VERSION: a change to the text bumps the version and this hash", () => {
    const hash = (draft: boolean): string => createHash("sha256").update(sampleAgents("legs", "ts", draft)).digest("hex").slice(0, 16);
    expect({ version: NOTES_VERSION, hash: hash(false), draft: hash(true) }).toEqual({ version: 6, hash: "0059a80526fc454a", draft: "75802a20e01ac85b" });
    // v5's bytes stay as shipped (security read of package I), so a draft init wrote at v5 is still named, as v5.
    const v5 = (draft: boolean): string => createHash("sha256").update(sampleAgents("legs", "ts", draft, 5)).digest("hex").slice(0, 16);
    expect({ hash: v5(false), draft: v5(true) }).toEqual({ hash: "7c36b5e6d11f7adb", draft: "30d901f38ead50c8" });
    expect(shippedNotesVersion("legs", sampleAgents("legs", "ts", true, 5))).toBe(5);
    // v4's bytes stay as shipped (package I), so a draft init wrote at v4 is still named, as v4.
    const v4 = (draft: boolean): string => createHash("sha256").update(sampleAgents("legs", "ts", draft, 4)).digest("hex").slice(0, 16);
    expect({ hash: v4(false), draft: v4(true) }).toEqual({ hash: "7c36b5e6d11f7adb", draft: "dd553c9f6f186664" });
    expect(shippedNotesVersion("legs", sampleAgents("legs", "ts", true, 4))).toBe(4);
    // v3's bytes stay as shipped (contract 3, before package I).
    const v3 = (draft: boolean): string => createHash("sha256").update(sampleAgents("legs", "ts", draft, 3)).digest("hex").slice(0, 16);
    expect({ hash: v3(false), draft: v3(true) }).toEqual({ hash: "7c36b5e6d11f7adb", draft: "48fa76eaec5a41f4" });
    expect(shippedNotesVersion("legs", sampleAgents("legs", "ts", true, 3))).toBe(3);
    // v2's bytes stay as shipped, so a draft init wrote before contract 3 is still named, as v2.
    const v2 = (draft: boolean): string => createHash("sha256").update(sampleAgents("legs", "ts", draft, 2)).digest("hex").slice(0, 16);
    expect({ hash: v2(false), draft: v2(true) }).toEqual({ hash: "0d345a22caaa582f", draft: "1d39cfe8d79174fe" });
    expect(shippedNotesVersion("legs", sampleAgents("legs", "ts", true, 2))).toBe(2);
    expect(sampleAgents("legs")).toContain("## Settings the person keeps (contract 3)");
    expect(sampleAgents("legs")).toContain("show it, never run it");
  });

  test("v4 (package I): a draft's last step names where the card is, the session first, and never says the Hill must be on", () => {
    const text = sampleAgents("legs", "sh", true);
    expect(text).toContain("Its card shows in this session on the\n   phone and in Settings, Tricks (on the Hill too, while it is on).");
    expect(text).not.toContain("send this draft to the Hill");
    expect(text).not.toMatch(/switch (the Hill|it) on/iu);
  });

  test("v5: a draft's last step says never to run collie tricks on or collie hill on, and v4 does not", () => {
    const text = sampleAgents("legs", "sh", true);
    expect(text).toContain("never run\n   `collie tricks on` or `collie hill on`: all three refuse inside an agent's pane.");
    expect(sampleAgents("legs", "sh", true, 4)).not.toContain("collie hill on");
  });

  test("v6: the notes say where a belt mark sits and what cwd is, and v5 does not", () => {
    const text = sampleAgents("legs", "ts", true);
    expect(text).toContain("A belt mark sits at the end of the scrolling strip, off screen until the person scrolls; the fixed block at the right is Collie's own.");
    expect(text).toContain("`cwd` is the pane's folder. A workspace folder can hold several repositories; look inside it.");
    expect(sampleAgents("legs", "ts", true, 5)).not.toContain("off screen until the person scrolls");
    expect(sampleAgents("legs", "ts", true, 5)).not.toContain("`cwd` is the pane's folder");
  });

  test("a draft init wrote before v2 is still named as the notes Collie ships, as v1", () => {
    const v1 = sampleAgents("legs", "sh", true, 1);
    expect(v1).toContain("send this draft to the Hill");
    expect(shippedNotesVersion("legs", v1)).toBe(1);
    expect(shippedNotesVersion("legs", sampleAgents("legs", "sh", true, 2))).toBe(2);
    expect(shippedNotesVersion("legs", sampleAgents("legs", "sh", true))).toBe(NOTES_VERSION);
    expect(shippedNotesVersion("legs", "# Legs\n")).toBeNull();
    const text = cardText(SH, { "trick.toml": 'id = "legs"\n', "program.sh": PROGRAM_SH, [NOTES_FILE]: v1 });
    expect(text).toContain(helperNote({ what: "notes", version: 1 }));
    expect(text).not.toContain("This folder is a Collie trick.");
  });

  test("byte for byte, on one card: named, and no line of them shown", () => {
    const text = cardText(SH, { "trick.toml": 'id = "legs"\n', "program.sh": PROGRAM_SH, [NOTES_FILE]: sampleAgents("legs", "sh", true) });
    expect(text).toContain(helperNote({ what: "notes", version: NOTES_VERSION }));
    expect(text).not.toContain("This folder is a Collie trick.");
  });

  test("byte for byte, beside the helper on a group: named on card 1, on no code card", () => {
    const text = cardText(TS, { "trick.toml": 'id = "legs"\n', "program.ts": "console.log(1);\n", "trick.ts": TRICK_HELPER, [NOTES_FILE]: sampleAgents("legs", "ts", false) });
    expect(text).toContain(helperNote({ what: "notes", version: NOTES_VERSION }));
    expect(text).toContain(`Collie's notes v${String(NOTES_VERSION)}`);
    expect(text).not.toContain("This folder is a Collie trick.");
  });

  test("changed: the cards show only the change against the notes Collie ships, and card 1 says so", () => {
    const shipped = sampleAgents("legs", "sh", true);
    const changed = shipped.replace("## Switching on approves this code\n", "## Switching on approves this code\n\nRead TODO.md first.\n");
    const text = cardText(SH, { "trick.toml": 'id = "legs"\n', "program.sh": PROGRAM_SH, [NOTES_FILE]: changed });
    expect(text).toContain(notesChangedNote());
    expect(text).toContain("+Read TODO.md first.");
    // Far from the change, the shipped text is not on the card.
    expect(text).not.toContain("This folder is a Collie trick.");
  });

  test("an AGENTS.md of the author's own shows whole, as any file", () => {
    const text = cardText(SH, { "trick.toml": 'id = "legs"\n', "program.sh": PROGRAM_SH, [NOTES_FILE]: "# Legs\n\nMy own notes.\n" });
    expect(text).toContain("+My own notes.");
    expect(text).not.toContain(notesChangedNote());
    expect(text).not.toContain("Collie ships");
  });

  test("notes far longer than the shipped text show whole: no diff is built", () => {
    const shipped = sampleAgents("legs", "sh", true);
    const longest = Math.max(...shippedNotesTexts("legs").map((text) => text.split("\n").length));
    const long = `${shipped}${"one more line\n".repeat(longest * NOTES_DIFF_LINES_FACTOR)}`;
    expect(shippedNotesDiff({ rel: NOTES_FILE, bytes: enc(long) }, "legs")).toBeNull();
    expect(shippedNotesDiff({ rel: NOTES_FILE, bytes: enc(`${shipped}one more line\n`) }, "legs")).not.toBeNull();
  });
});
