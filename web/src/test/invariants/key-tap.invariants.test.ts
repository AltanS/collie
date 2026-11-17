// M102 spec 15, the guarded key tap (staging 944ea30b9, fix/sub-hold-on-member): a tap on a dialog the
// readers lifted from a REAL capture of any harness, with the screen moved between the render the
// person saw and the guard's fresh read. The adapters, the comparators and the corpus are the real
// thing; only the api layer is stubbed, so the guard's fresh read can be any screen.
//
//   I2/I4  a row OUTSIDE the dialog that ticks (a tool's timer, a spinner, a clock, ANSI noise) and a
//          moved revision never refuse the tap: the option's keys go out once.
//   I7     a successor dialog with another subject (one row of the dialog's own text changed) is
//          refused: no key goes out.
//
// The corpus is every pane fixture whose prompt-select detector lifts a dialog for its labelled
// harness. Each seed picks a sample and a ticking row; a fresh seed per run moves the sample.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
}));

import { parseAnsi } from "../../lib/ansi";
import { fetchPane, sendKeys } from "../../lib/api";
import { splitLines } from "../../lib/blocks";
import { dialogDetector } from "../../lib/dialog-guard";
import { DIALOG_CONTRACT } from "../../lib/harness/dialog-contract";
import { submitPromptOption } from "../../lib/prompt-action";
import { replayHint, rngOf, runSeeds, sample, type Rng } from "./seed";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");
const PANES = join(FIXTURES, "panes");
const PER_SEED = 24;
const DETECTED = 4100;
/** Keys whose own effect is a move the action then waits to see on the screen. */
const WALK_KEYS: ReadonlySet<string> = new Set(["Up", "Down", "Left", "Right", "Tab", "BTab"]);


interface Label {
  readonly harness: string;
}
// SAFETY: a committed file of this repo; fold.corpus.test.ts checks every row has this draw.
const LABELS = (JSON.parse(readFileSync(join(FIXTURES, "surface-labels.json"), "utf8")) as { fixtures: Record<string, Label> }).fixtures;

const lines = (text: string) => splitLines(parseAnsi(text));
// oxlint-disable-next-line no-control-regex -- a raw pane read, ANSI and all
const plain = (row: string): string => row.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "");
const rowsOf = (text: string): string[] => text.split(/\r?\n/u);

type Prompt = NonNullable<ReturnType<ReturnType<typeof dialogDetector<"prompt-select">>>>;

interface Dialog {
  readonly name: string;
  readonly harness: string;
  readonly text: string;
  readonly prompt: Prompt;
  /** Index of the screen row where the dialog's own region starts; rows above it are outside. */
  readonly top: number;
}

/** The first screen row of the region the tap binds, found by its first non-blank line. */
function regionTop(text: string, prompt: Prompt): number {
  const region = DIALOG_CONTRACT["prompt-select"].region(prompt);
  const first = region.split("\n").find((row) => row.trim() !== "");
  if (first === undefined) return -1;
  return rowsOf(text).findIndex((row) => plain(row).trimEnd() === first.trimEnd());
}

function corpus(): readonly Dialog[] {
  const out: Dialog[] = [];
  for (const name of readdirSync(PANES).toSorted()) {
    const label = LABELS[name];
    if (label === undefined || label.harness === "shell") continue;
    const text = readFileSync(join(PANES, name), "utf8");
    const prompt = dialogDetector("prompt-select", label.harness)(lines(text));
    if (prompt === null || prompt.feedback?.focused === true) continue;
    if (directOption(prompt) === undefined) continue;
    const top = regionTop(text, prompt);
    if (top <= 0) continue;
    out.push({ name, harness: label.harness, text, prompt, top });
  }
  return out;
}

const DIALOGS = corpus();
const SEEDS = runSeeds();

/** A row that ticks: the same text twice, one second or one glyph apart. */
const TICKS: readonly (readonly [string, string])[] = [
  ["  ⎿  Running… (4m 12s · timeout 10m)", "  ⎿  Running… (4m 13s · timeout 10m)"],
  ["✻ Waiting for 1 background agent to finish", "✶ Waiting for 1 background agent to finish"],
  ["✻ Churned for 4s · done 12:15 AM", "✻ Churned for 4s · done 12:16 AM"],
  ["\x1b[2m⠋ working 3s\x1b[0m", "\x1b[2m⠙ working 4s\x1b[0m"],
];

/** The screen with one row inserted at `at`. */
function insertRow(text: string, at: number, row: string): string {
  const all = rowsOf(text);
  return [...all.slice(0, at), row, ...all.slice(at)].join("\r\n");
}

/** A row of the dialog's own text that is no option row: its subject (the command, the file, the question). */
function subjectRow(dialog: Dialog): number {
  const rows = rowsOf(dialog.text);
  const labels = dialog.prompt.options.map((o) => o.label.trim());
  const region = new Set(DIALOG_CONTRACT["prompt-select"].region(dialog.prompt).split("\n").map((row) => row.trim()));
  let best = -1;
  let bestLength = 0;
  for (let i = dialog.top; i < rows.length; i++) {
    const row = plain(rows[i] ?? "").trim();
    if (!/[A-Za-z]{3}/u.test(row) || !region.has(row)) continue;
    if (labels.some((label) => label !== "" && row.includes(label))) continue;
    if (row.length > bestLength) {
      best = i;
      bestLength = row.length;
    }
  }
  return best;
}

/** The screen with the subject row's text changed: another command, another file. */
function successor(dialog: Dialog, at: number): string {
  const rows = rowsOf(dialog.text);
  return rows.map((row, i) => (i === at ? row.replace(/([A-Za-z]{3,})/u, "$1zz") : row)).join("\r\n");
}

/** The first option a tap sends without a walk (no arrow keys): one guarded write, no pointer to follow. */
function directOption(prompt: Prompt) {
  return prompt.options.find((o) => o.keys.length === 1 && !WALK_KEYS.has(o.keys[0] ?? ""));
}

async function tap(dialog: Dialog, freshText: string, revision: number, option = directOption(dialog.prompt)) {
  mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text: freshText, truncated: false, revision });
  if (option === undefined) throw new Error("no direct option");
  return submitPromptOption({ paneId: "w1:p1", requestedLines: 200, detectedRevision: DETECTED, agent: dialog.harness, prompt: dialog.prompt, option });
}

function pick(rng: Rng): readonly [string, string] {
  return rng.pick(TICKS);
}

/** A tick right above the dialog's region, a moved revision, one tap. The breaks, split by whether the dialog is framed. */
async function tickRun(seed: number): Promise<{ readonly framed: string[]; readonly unframed: string[] }> {
  const rng = rngOf(seed);
  const framed: string[] = [];
  const unframed: string[] = [];
  for (const dialog of sample(DIALOGS, PER_SEED, rng)) {
    const [seen, now] = pick(rng);
    const at = dialog.top;
    const shownText = insertRow(dialog.text, at, seen);
    const shown = dialogDetector("prompt-select", dialog.harness)(lines(shownText));
    if (shown === null || directOption(shown) === undefined) continue;
    const result = await tapFresh({ ...dialog, text: shownText, prompt: shown }, insertRow(dialog.text, at, now), DETECTED + 1 + rng.int(9));
    if (result.status === "sent" && mockSendKeys.mock.calls.length === 1) continue;
    const line = `${dialog.name} (${dialog.harness}) tick "${plain(now).trim()}": ${result.status}, ${String(mockSendKeys.mock.calls.length)} writes; ${replayHint(seed, dialog.name)}`;
    (shown.bindRegion === undefined ? unframed : framed).push(line);
  }
  return { framed, unframed };
}

/** One tap on a clean mock. */
async function tapFresh(dialog: Dialog, freshText: string, revision: number, option = directOption(dialog.prompt)) {
  vi.clearAllMocks();
  mockSendKeys.mockResolvedValue({ ok: true });
  return tap(dialog, freshText, revision, option);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSendKeys.mockResolvedValue({ ok: true });
});

describe("M102-15, the guarded key tap on real dialogs", () => {
  it("covers dialogs of more than one harness", () => {
    const harnesses = new Set(DIALOGS.map((d) => d.harness));
    console.info(`[invariants.key-tap] ${String(DIALOGS.length)} dialogs over ${String(harnesses.size)} harnesses (${[...harnesses].join(",")}); seeds ${SEEDS.join(",")}, ${String(PER_SEED)} per seed`);
    expect(DIALOGS.length).toBeGreaterThan(20);
    expect(harnesses.size).toBeGreaterThan(1);
  });

  for (const seed of SEEDS) {
    it(`I2/I4: a ticking row outside a framed dialog and a moved revision never refuse the tap (${replayHint(seed, "key tap")})`, async () => {
      const { framed } = await tickRun(seed);
      expect(framed).toEqual([]);
    });

    it(`I7: a successor dialog with another subject is refused, nothing typed (${replayHint(seed, "successor")})`, async () => {
      const rng = rngOf(seed + 1);
      const broken: string[] = [];
      let tried = 0;
      for (const dialog of sample(DIALOGS, PER_SEED, rng)) {
        const at = subjectRow(dialog);
        if (at < 0) continue;
        tried++;
        vi.clearAllMocks();
        mockSendKeys.mockResolvedValue({ ok: true });
        const result = await tap(dialog, successor(dialog, at), DETECTED);
        if (result.status === "sent" || mockSendKeys.mock.calls.length > 0) {
          broken.push(`${dialog.name} (${dialog.harness}) row "${plain(rowsOf(dialog.text)[at] ?? "").trim()}": ${result.status}, ${String(mockSendKeys.mock.calls.length)} writes; ${replayHint(seed, dialog.name)}`);
        }
      }
      expect(tried).toBeGreaterThan(0);
      expect(broken).toEqual([]);
    });
  }

  // A dialog with no frame of its own (an ask, a first-run menu, agy, muse) compares its lookback
  // signature, so a successor with another subject above the question is refused; a row up there
  // that only ticks is held still and does not refuse the tap.
  it(`I4: a ticking row above an unframed dialog does not refuse the tap`, async () => {
    const all: string[] = [];
    for (const seed of SEEDS) all.push(...(await tickRun(seed)).unframed);
    console.info(`[invariants.key-tap] unframed tick: ${String(all.length)} refused taps; first: ${all[0] ?? "-"}`);
    // The named capture: a Claude ask, whose options commit as a digit and Enter in one guarded write
    // (so it is not in DIALOGS, which keeps one-key plans only).
    const name = "claude--v2323-rc-off-ask-single--w100.txt";
    const text = readFileSync(join(PANES, name), "utf8");
    const seen = dialogDetector("prompt-select", "claude")(lines(text));
    if (seen === null) throw new Error("the named capture does not lift");
    const top = regionTop(text, seen);
    const tick = TICKS[3];
    if (tick === undefined) throw new Error("no tick");
    const shownText = insertRow(text, top, tick[0]);
    const shown = dialogDetector("prompt-select", "claude")(lines(shownText));
    if (shown === null) throw new Error("the named dialog does not lift");
    // Since staging d7af75e5c this ask binds its question's own rows (`bindRegion`), so the tick sits outside
    // the compare either way; the seeded run above still covers the dialogs that have no frame.
    const result = await tapFresh({ name, harness: "claude", text: shownText, prompt: shown, top }, insertRow(text, top, tick[1]), DETECTED + 2, shown.options[0]);
    expect({ status: result.status, writes: mockSendKeys.mock.calls.length, all }).toEqual({ status: "sent", writes: 1, all: [] });
  });
});
