// The slow cases of invariants.mutation.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { askOf } from "../../web/src/lib/surface/surface.ts";
import { replayHint, rngOf, runSeeds, sample, type Rng } from "../../web/src/test/invariants/seed.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { collieOwn, invariantRig, menuBytes, personOverride, personTap, type Write , type RigOptions } from "./invariants-rig.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures");

const PANES = join(FIXTURES, "panes");

const SAMPLE = 40;

const TEXT = "please carry on with the parser fix";

interface Label {
  readonly harness: string;
  readonly version: string;
  readonly state: string;
}

// SAFETY: a committed file of this repo; fold.corpus.test.ts checks every row has this draw.
const LABELS = (JSON.parse(readFileSync(join(FIXTURES, "surface-labels.json"), "utf8")) as { fixtures: Record<string, Label> }).fixtures;

const NAMES = Object.keys(LABELS).toSorted();

// ── the menu sign, the test's own oracle (no profile) ──

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/gu;

const plain = (row: string): string => row.replace(ANSI, "");

const NUMBERED = /^\s*(?:[❯>›▸→●○◯◉]\s*)?\d{1,2}[.)]\s+\S/u;

const YES_NO = /^\s*(?:[❯>›▸→●○◯◉]\s*)?(?:\d{1,2}[.)]\s*)?(?:yes|no|allow|deny|cancel|reject|approve)\b/iu;

const YN_FORM = /\((?:y\/n)\)|\[(?:y\/n)\]/iu;

const HINT = /(?:enter to (?:confirm|select|submit)|esc to (?:cancel|close|go back)|↑\/↓|↑↓ to (?:navigate|select|move))/iu;

/** A menu or a yes/no prompt in the bottom 16 non-blank rows: two numbered options, two yes/no rows, a (y/n) form, or a hint row. */
export function menuSign(screen: string): boolean {
  const rows = screen.split("\n").map(plain).filter((row) => row.trim() !== "").slice(-16);
  if (rows.filter((row) => NUMBERED.test(row)).length >= 2) return true;
  if (rows.filter((row) => YES_NO.test(row)).length >= 2) return true;
  return rows.some((row) => YN_FORM.test(row) || HINT.test(row));
}

/**
 * The one case the oracle reads too wide (M102 spec 12, the lead's call of 2026-11-17): text written with
 * no key at all into the input box the reader FOUND (modal none, composer empty or draft). The sign the
 * oracle saw is then the agent's own answer above its box (a numbered list, a quoted dialog), and the text
 * sits in the box and picks nothing. For the person's override that is the whole rule; for Collie's own
 * send and the first tap the capture's label must say no dialog is open (idle, draft, running) too. Any
 * key, or a box not found, stays I7.
 */
function textIntoFoundBox(label: Label | null, answer: SendAnswer, before: SendAnswer | undefined, writes: readonly Write[]): boolean {
  if (label !== null && label.state !== "idle" && label.state !== "draft" && label.state !== "running") return false;
  if (writes.some((w) => w.kind === "keys")) return false;
  const seen = answer.surface ?? before?.surface;
  return seen !== undefined && seen.modal === "none" && (seen.composer === "empty" || seen.composer === "draft");
}

/**
 * The blind road's side of the same call (M102 spec 12, decision 3): no dialog is open where the label
 * says idle, draft or running, and a shell waits at its prompt where the bottom row is a bare `$`, `#` or
 * `%` prompt (old output above it is no menu), and a capture named `quoted` shows a dialog quoted in the
 * agent's prose, not an open one. Every other capture stays I7 for the blind road.
 */
function noMenuForBlind(name: string, label: Label, screen: string): boolean {
  if (label.state === "idle" || label.state === "draft" || label.state === "running") return true;
  if (label.state === "other" && name.includes("quoted")) return true;
  const bottom = screen.split("\n").map(plain).findLast((row) => row.trim() !== "") ?? "";
  return /^\s*\S*[$#%]\s*$/u.test(bottom.replace(/\r/gu, ""));
}

// ── the mutations ──

type Mutation = "insert-row" | "warning-under-command" | "right-clock" | "ansi-noise" | "rewrap" | "cut-top";

const MUTATIONS: readonly Mutation[] = ["insert-row", "warning-under-command", "right-clock", "ansi-noise", "rewrap", "cut-top"];

const NOISE = ["\u001b[1m", "\u001b[0m", "\u001b[2m", "\u001b[38;5;141m", "\u001b[48;2;30;30;30m", "\u001b[22m"];

function bottomIndex(rows: readonly string[], rng: Rng, span: number): number {
  const lastFilled = rows.reduce((last, row, i) => (plain(row).trim() === "" ? last : i), 0);
  return Math.max(0, lastFilled - rng.int(Math.min(span, lastFilled + 1)));
}

export function mutate(raw: string, mutation: Mutation, rng: Rng): string {
  const rows = raw.replace(/\n+$/u, "").split("\n");
  switch (mutation) {
    case "insert-row": {
      const at = bottomIndex(rows, rng, 14);
      rows.splice(at, 0, rng.pick(["  Running 3 background tasks", "  ✻ Tip: you can queue a message", "", "  ⎿  Read 42 lines"]));
      return rows.join("\n");
    }
    case "warning-under-command": {
      const commands = rows.map((row, i) => ({ row: plain(row), i })).filter((x) => /^\s*(?:\$|>|❯|⏺|●|Bash\(|Run|›)/u.test(x.row));
      const at = commands.length > 0 ? (rng.pick(commands).i + 1) : bottomIndex(rows, rng, 14);
      rows.splice(at, 0, rng.pick(["  ⚠ Warning: the command printed to stderr", "  ! warning: deprecated flag --legacy", "    Large output truncated (3 MB)"]));
      return rows.join("\n");
    }
    case "right-clock": {
      const at = bottomIndex(rows, rng, 10);
      const row = rows[at] ?? "";
      // Before a row's trailing CR, as ansi-noise does: a clock after a bare CR is a byte order no grid read carries.
      const cr = row.endsWith("\r") ? "\r" : "";
      const body = row.slice(0, row.length - cr.length);
      const width = Math.max(80, plain(body).length + 4);
      rows[at] = `${body}${" ".repeat(Math.max(1, width - plain(body).length - 8))}12:34:56${cr}`;
      return rows.join("\n");
    }
    case "ansi-noise":
      // A capture's row may end in CR (a CRLF file): the reset goes before it, for a reset after a bare CR
      // is a byte order no multiplexer's grid read carries, and the screen reader starts the row over there.
      return rows
        .map((row) => {
          if (!rng.chance(0.4)) return row;
          const cr = row.endsWith("\r") ? "\r" : "";
          return `${rng.pick(NOISE)}${row.slice(0, row.length - cr.length)}${rng.chance(0.5) ? "\u001b[0m" : ""}${cr}`;
        })
        .join("\n");
    case "rewrap": {
      const width = rng.pick([40, 60, 100]);
      return rows
        .map(plain)
        .flatMap((row) => {
          const chars = [...row];
          if (chars.length <= width) return [row];
          const out: string[] = [];
          for (let i = 0; i < chars.length; i += width) out.push(chars.slice(i, i + width).join(""));
          return out;
        })
        .join("\n");
    }
    case "cut-top": {
      const cut = 1 + rng.int(Math.max(1, Math.min(20, Math.floor(rows.length / 2))));
      return rows.slice(cut).join("\n");
    }
  }
}

// ── the cases ──

interface Case {
  readonly seed: number;
  readonly name: string;
  readonly label: Label;
  readonly mutation: Mutation;
  readonly screen: string;
  readonly menu: boolean;
}

function casesOf(seed: number): readonly Case[] {
  const rng = rngOf(seed);
  const dialogs = NAMES.filter((n) => LABELS[n]?.state === "dialog");
  const others = NAMES.filter((n) => LABELS[n]?.state !== "dialog");
  const picked = [...sample(dialogs, SAMPLE / 2, rng), ...sample(others, SAMPLE / 2, rng)];
  return picked.map((name) => {
    // SAFETY: the name comes from the labels' own keys.
    const label = LABELS[name] as Label;
    const mutation = rng.pick(MUTATIONS);
    const screen = mutate(readFileSync(join(PANES, name), "utf8"), mutation, rng);
    return { seed, name, label, mutation, screen, menu: menuSign(screen) };
  });
}

const SEEDS = runSeeds();

const CASES = SEEDS.flatMap(casesOf);

interface Found {
  readonly i7: string[];
  readonly i7Blind: string[];
  readonly i4: Map<I4Bucket, string[]>;
}

function describeWrites(writes: readonly Write[]): string {
  return writes.map((w) => `${w.kind}:${w.value.slice(0, 20)}`).join(" ");
}

const OVERRIDE_REFUSALS: ReadonlySet<string> = new Set(["stale_surface", "menu_open", "pane_gone", "probe_failed"]);

/** Which red entry an override refusal belongs to; `other` is one no entry names, and the green test fails on it. */
type I4Bucket = "not-free" | "turn" | "draft-no-box" | "other";

function bucketOf(reason: string | undefined): I4Bucket {
  if (reason === "not_free" || reason === "unconfirmed") return "not-free";
  if (reason === "turn_running") return "turn";
  if (reason === "draft_present") return "draft-no-box";
  return "other";
}

const CLAUDE_PIN: RigOptions["pinVersions"] = [{ range: "2.1.0 - 2.1.296", low: "2.1.0", high: "2.1.296", status: "verified", verifiedThrough: "2.1.296", verifiedOn: "2026-10-12" }];

async function run(): Promise<Found> {
  const found: Found = { i7: [], i7Blind: [], i4: new Map() };
  for (const c of CASES) {
    const hint = replayHint(c.seed, `${c.name} ${c.mutation}`);
    const harness = c.label.harness === "shell" ? "" : c.label.harness;
    const draw = { kind: "fixed", text: c.screen, echoes: false } as const;
    // The Claude captures span versions past the shipped range; the same pin as the protocol tests keeps them profiled.
    const agent = harness === "claude" ? { harness, version: c.label.version, pinVersions: CLAUDE_PIN } : { harness, version: c.label.version };
    const rigs = [invariantRig({ ...agent, draw }), invariantRig({ ...agent, draw }), invariantRig({ ...agent, draw }), invariantRig({ draw, harness: "an-agent-collie-has-no-profile-for", version: null })];
    const [ownRig, tapRig, overRig, blindRig] = rigs;
    if (ownRig === undefined || tapRig === undefined || overRig === undefined || blindRig === undefined) throw new Error("rig");
    try {
      const own = await collieOwn(ownRig, TEXT);
      const tap = await personTap(tapRig, TEXT);
      const over = await personOverride(overRig, TEXT);
      const blind = await personTap(blindRig, TEXT);
      if (c.menu) {
        const roads = [
          ["Collie's own send", textIntoFoundBox(c.label, own.answer, undefined, own.writes) ? [] : own.writes],
          ["the person's first tap", textIntoFoundBox(c.label, tap.answer, undefined, tap.writes) ? [] : tap.writes],
          ["the person's override", textIntoFoundBox(null, over.commit, over.prepare, over.writes) ? [] : over.writes],
        ] as const;
        for (const [road, writes] of roads) {
          const bad = menuBytes(writes);
          if (bad.length > 0) found.i7.push(`${road} wrote ${describeWrites(bad)} onto a menu: ${hint}`);
        }
        const badBlind = noMenuForBlind(c.name, c.label, c.screen) ? [] : menuBytes(blind.writes);
        if (badBlind.length > 0) found.i7Blind.push(`the blind road wrote ${describeWrites(badBlind)} onto a menu: ${hint}`);
      } else {
        const r = over.commit.receipt;
        const seen = over.commit.surface ?? over.prepare.surface;
        const exempt = seen !== undefined && (askOf(seen.modal) !== null || seen.field === "secret");
        const draftRoad = r?.reason === "draft_present" && (over.commit.offers.includes("append") || over.commit.offers.includes("replace"));
        if (!exempt && !draftRoad && r?.outcome === "refused" && !OVERRIDE_REFUSALS.has(r.reason ?? "")) {
          const bucket = bucketOf(r.reason);
          const list = found.i4.get(bucket) ?? [];
          list.push(`override refused(${r.reason ?? "-"}) on a screen with no menu sign: ${hint}`);
          found.i4.set(bucket, list);
        }
      }
    } finally {
      for (const rig of rigs) rig.dispose();
    }
  }
  return found;
}

let cached: Found | null = null;

async function results(): Promise<Found> {
  if (cached === null) {
    cached = await run();
    const menus = CASES.filter((c) => c.menu).length;
    console.info(`[invariants.mutation] seeds ${SEEDS.join(",")}: ${String(CASES.length)} mutated captures (${String(menus)} with a menu sign) of ${String(NAMES.length * MUTATIONS.length)} capture x mutation pairs`);
  }
  return cached;
}

describe("M102-15 part 1c, mutated captures of the corpus", () => {
  test("I7: on a screen with a menu sign, no road of Collie's own, the person's first tap or the override writes Enter, a digit or a letter", async () => {
    expect((await results()).i7).toEqual([]);
  }, 120_000);
});
