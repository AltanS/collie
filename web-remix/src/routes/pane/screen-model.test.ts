/// <reference types="bun" />
// The screen model against the text it stands in for. A poll answer leaves the pane's text out and
// carries `screen` (lib/pane-read.ts); the browser derives the card, the keyboard flag, the draft and
// the footer from it with the same functions it runs over a parse of the text. Here every real capture
// in web/src/fixtures/panes goes text -> model -> JSON (the wire) -> parseRead, and what the browser
// would read from the model must equal what it reads from the text.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { fold, locateReply, PROBE_CHARS } from "@web/lib/latest-reply";
import type { TranscriptEntry, TranscriptPart } from "@web/lib/types";

import type { PaneRead, PaneScreen } from "../../lib/pane-read";
import { dialogOwnsKeyboard } from "./cards";
import { decodeProbe, encodeProbe } from "./frames";
import { parseRead, parseScreen, screenToken } from "./parse";
import { askForReply, placementOf, screenOfText, screenStamp } from "./screen-model";

const FIXTURES = new URL("../../../../web/src/fixtures/panes/", import.meta.url);
/** The agent string a capture was taken from, by its file prefix (the pane snapshot's `agent`). */
const AGENTS = new Map([
  ["agy", "agy"],
  ["claude", "claude"],
  ["claude-lab", "claude"],
  ["codex", "codex"],
  ["grok", "grok"],
  ["muse", "muse"],
  ["oc", "opencode"],
  ["omp", "omp"],
  ["pi", "pi"],
]);

function captures(): { file: string; agent: string; text: string }[] {
  const out: { file: string; agent: string; text: string }[] = [];
  for (const file of readdirSync(FIXTURES).toSorted()) {
    if (!file.endsWith(".txt")) continue;
    const prefix = file.split("--")[0] ?? "";
    const agent = AGENTS.get(prefix);
    if (agent === undefined) continue;
    out.push({ file, agent, text: readFileSync(new URL(file, FIXTURES), "utf8") });
  }
  return out;
}

/** The model as the browser gets it: through JSON, with the text left out. */
function wire(text: string, agent: string | undefined): PaneRead {
  const screen: PaneScreen = JSON.parse(JSON.stringify(screenOfText(text, agent)));
  return { paneId: "w1:p1", text: "", truncated: false, revision: 1, screen };
}

describe("the model reads back as the text reads", () => {
  const all = captures();

  test("the corpus is there, and has dialogs in it", () => {
    expect(all.length).toBeGreaterThan(300);
    expect(all.filter((c) => parseScreen(c.text, c.agent).card !== null).length).toBeGreaterThan(20);
  });

  test("every capture: card, keyboard flag, draft, footer and counts", () => {
    for (const { file, agent, text } of all) {
      const truth = parseScreen(text, agent);
      const model = parseRead(wire(text, agent), agent);
      const at = `${file} (${agent})`;
      expect({ at, card: model.card }).toEqual({ at, card: truth.card });
      expect({ at, owns: dialogOwnsKeyboard(model.blocks) }).toEqual({ at, owns: dialogOwnsKeyboard(truth.blocks) });
      expect({ at, draft: model.rawDraft }).toEqual({ at, draft: truth.rawDraft });
      expect({ at, footer: model.agentsFooter }).toEqual({ at, footer: truth.agentsFooter });
      expect({ at, rows: model.mirrorRows, status: model.statusRows }).toEqual({ at, rows: truth.mirror.length, status: truth.statusLines.length });
      // Only the blocks something reads: no raw output, no completion popup.
      expect({ at, kinds: model.blocks.map((b) => b.kind) }).toEqual({ at, kinds: truth.blocks.map((b) => b.kind).filter((k) => k !== "raw" && k !== "autocomplete") });
    }
  });

  test("a model carries no mirror lines and no statusline rows: the frames hold them", () => {
    const model = parseRead(wire(all[0]!.text, all[0]!.agent), all[0]!.agent);
    expect(model.mirror).toEqual([]);
    expect(model.statusLines).toEqual([]);
  });

  test("one parse per model object", () => {
    const read = wire(all[0]!.text, all[0]!.agent);
    expect(parseRead(read, "claude")).toBe(parseRead(read, "claude"));
  });

  test("a blank screen", () => {
    const read = wire("", "claude");
    expect(read.screen?.blank).toBe(true);
    expect(screenToken(read)).toBe("");
    const model = parseRead(read, "claude");
    expect(model.card).toBeNull();
    expect(model.mirrorRows).toBe(0);
  });
});

describe("the stamp and the token", () => {
  test("equal screens stamp equal; text and agent both count", () => {
    expect(screenStamp("a\nb", "claude")).toBe(screenStamp("a\nb", "claude"));
    expect(screenStamp("a\nb", "claude")).not.toBe(screenStamp("a\nc", "claude"));
    expect(screenStamp("a\nb", "claude")).not.toBe(screenStamp("a\nb", "codex"));
    expect(screenStamp("a\nb", "claude")).not.toBe(screenStamp("a\nb", undefined));
  });

  test("the token is the text for a read that has it, the stamp for one that does not, empty for blank", () => {
    expect(screenToken(undefined)).toBe("");
    expect(screenToken({ paneId: "p", text: "hello", truncated: false, revision: 1 })).toBe("hello");
    expect(screenToken({ paneId: "p", text: "", truncated: false, revision: 1 })).toBe("");
    const read = wire("hello", undefined);
    expect(screenToken(read)).toBe(read.screen?.stamp ?? "?");
    expect(screenToken(read)).not.toBe("");
  });
});

// ── The reply probe ─────────────────────────────────────────────────────────────────────────────────

function reply(prose: string, truncated = false): TranscriptEntry {
  const part: TranscriptPart = { kind: "text", text: prose };
  if (truncated) part.truncated = true;
  return { uuid: "u1", ts: "", role: "assistant", parts: [part] };
}

/** A screen of numbered prose lines and a reply whose lines are `from` to `to` of it, with an unseen opening of `unseen` lines. */
function scene(from: number, to: number, unseen: number) {
  const line = (n: number): string => `Line number ${String(n)} says something about topic ${String(n * 7)} in some detail.`;
  const screen = Array.from({ length: 20 }, (_, i) => line(i)).join("\n");
  const opening = Array.from({ length: unseen }, (_, i) => `Opening paragraph ${String(i)} that scrolled off long ago and is not here.`);
  const body = Array.from({ length: to - from + 1 }, (_, i) => line(from + i));
  return { text: screen, entry: reply([...opening, ...body].join("\n\n")) };
}

describe("the reply probe", () => {
  test("a probe round-trips through its header, and a malformed one is nothing", () => {
    const probe = { head: "a".repeat(PROBE_CHARS), tail: "ünï".repeat(16).slice(0, PROBE_CHARS) };
    expect(decodeProbe(encodeProbe(probe))).toEqual(probe);
    expect(decodeProbe(null)).toBeUndefined();
    expect(decodeProbe("abc.def")).toBeUndefined();
    expect(decodeProbe("a.b.c")).toBeUndefined();
    expect(decodeProbe("%E0%A4%A.x")).toBeUndefined();
  });

  test("a short reply and a capped one are settled without asking", () => {
    expect(askForReply(reply("Done."))).toEqual({ kind: "settled", placement: { fit: "whole", endLine: -1 } });
    const capped = askForReply(reply("x".repeat(400), true));
    expect(capped).toEqual({ kind: "settled", placement: { fit: "off-screen", endLine: -1 } });
  });

  test("the bridge's placement for the probe is web's locateReply for the reply: clipped, whole, off screen", () => {
    const cases = [
      { name: "clipped", ...scene(8, 15, 3) },
      { name: "whole", ...scene(8, 15, 0) },
      { name: "off screen", text: scene(8, 15, 0).text, entry: reply("Nothing like this was ever printed on the screen. ".repeat(6)) },
    ];
    for (const c of cases) {
      const ask = askForReply(c.entry);
      expect(ask.kind).toBe("probe");
      if (ask.kind !== "probe") continue;
      const screen = screenOfText(c.text, undefined, ask.probe);
      expect({ name: c.name, placement: placementOf(screen, ask) }).toEqual({ name: c.name, placement: locateReply(c.text, c.entry) });
    }
    expect(locateReply(cases[0]!.text, cases[0]!.entry).fit).toBe("clipped");
    expect(locateReply(cases[1]!.text, cases[1]!.entry).fit).toBe("whole");
    expect(locateReply(cases[2]!.text, cases[2]!.entry).fit).toBe("off-screen");
  });

  test("an answer for another probe places nothing", () => {
    const a = scene(8, 15, 3);
    const b = scene(2, 9, 3);
    const askA = askForReply(a.entry);
    const askB = askForReply(b.entry);
    if (askA.kind !== "probe" || askB.kind !== "probe") throw new Error("expected probes");
    const screen = screenOfText(a.text, undefined, askA.probe);
    expect(placementOf(screen, askA)).not.toBeNull();
    expect(placementOf(screen, askB)).toBeNull();
    expect(placementOf(screenOfText(a.text, undefined), askA)).toBeNull();
  });

  test("the probes are folded prose: letters and digits only", () => {
    const ask = askForReply(scene(8, 15, 3).entry);
    if (ask.kind !== "probe") throw new Error("expected a probe");
    expect(ask.probe.head).toBe(fold(ask.probe.head));
    expect(ask.probe.head.length).toBe(PROBE_CHARS);
    expect(ask.probe.tail.length).toBe(PROBE_CHARS);
  });
});
