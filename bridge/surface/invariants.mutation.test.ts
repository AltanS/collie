// M102 spec 15, part 1c: the REAL captures of the corpus (web/src/fixtures/panes, 1394 screens),
// mutated the way new agent versions move a screen: a row inserted, a warning line under a command, a
// right-aligned clock, ANSI noise, a re-wrap to another width, the top cut off. Each mutated screen goes
// to the Send Protocol as a fixed pane that takes no keys (nothing a write does shows on it), on four
// roads: Collie's own send (no person), the person's first tap, the person's two taps with the override,
// and the person's first tap on the same screen under an agent Collie has no profile for (the blind road).
//
// The assertions never say "the reader read it right". They say:
//   I7  on a screen that shows a menu sign (the test's own profile-free oracle below), no road of
//       Collie's writes Enter, a digit or a letter. Only the person's key from the pad may.
//   I4  on a screen with no menu sign, the person's override is not refused before a write, except for
//       a read question or permission, a known secret, stale_surface, menu_open or pane_gone.
//       (probe_failed is left to the gates suite: this pane takes no keys, so a probe never shows here.)
//
// The sample: SAMPLE cases per seed, half of them from dialog captures, over 6 mutations.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { askOf } from "../../web/src/lib/surface/surface.ts";
import { knownRed, redTitle, type KnownRedId } from "../../web/src/test/invariants/known-red.ts";
import { replayHint, rngOf, runSeeds, sample, type Rng } from "../../web/src/test/invariants/seed.ts";
import { collieOwn, invariantRig, menuBytes, personOverride, personTap, type Write } from "./invariants-rig.ts";

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
      const width = Math.max(80, plain(row).length + 4);
      rows[at] = `${row}${" ".repeat(Math.max(1, width - plain(row).length - 8))}12:34:56`;
      return rows.join("\n");
    }
    case "ansi-noise":
      return rows.map((row) => (rng.chance(0.4) ? `${rng.pick(NOISE)}${row}${rng.chance(0.5) ? "\u001b[0m" : ""}` : row)).join("\n");
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
  readonly i4: Map<KnownRedId | "other", string[]>;
}

function describeWrites(writes: readonly Write[]): string {
  return writes.map((w) => `${w.kind}:${w.value.slice(0, 20)}`).join(" ");
}

const OVERRIDE_REFUSALS: ReadonlySet<string> = new Set(["stale_surface", "menu_open", "pane_gone", "probe_failed"]);

/** Which red entry an override refusal belongs to; `other` is one no entry names, and the green test fails on it. */
function bucketOf(reason: string | undefined): KnownRedId | "other" {
  if (reason === "not_free" || reason === "unconfirmed") return "i4-bridge-not-free";
  if (reason === "turn_running") return "i4-bridge-turn";
  if (reason === "draft_present") return "i4-bridge-draft-no-box";
  return "other";
}

async function run(): Promise<Found> {
  const found: Found = { i7: [], i7Blind: [], i4: new Map() };
  for (const c of CASES) {
    const hint = replayHint(c.seed, `${c.name} ${c.mutation}`);
    const harness = c.label.harness === "shell" ? "" : c.label.harness;
    const draw = { kind: "fixed", text: c.screen, echoes: false } as const;
    const rigs = [invariantRig({ draw, harness, version: c.label.version }), invariantRig({ draw, harness, version: c.label.version }), invariantRig({ draw, harness, version: c.label.version }), invariantRig({ draw, harness: "an-agent-collie-has-no-profile-for", version: null })];
    const [ownRig, tapRig, overRig, blindRig] = rigs;
    if (ownRig === undefined || tapRig === undefined || overRig === undefined || blindRig === undefined) throw new Error("rig");
    try {
      const own = await collieOwn(ownRig, TEXT);
      const tap = await personTap(tapRig, TEXT);
      const over = await personOverride(overRig, TEXT);
      const blind = await personTap(blindRig, TEXT);
      if (c.menu) {
        for (const [road, writes] of [["Collie's own send", own.writes], ["the person's first tap", tap.writes], ["the person's override", over.writes]] as const) {
          const bad = menuBytes(writes);
          if (bad.length > 0) found.i7.push(`${road} wrote ${describeWrites(bad)} onto a menu: ${hint}`);
        }
        const badBlind = menuBytes(blind.writes);
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
  test("the oracle: most dialog captures show a menu sign, most idle captures do not", () => {
    const dialogs = NAMES.filter((n) => LABELS[n]?.state === "dialog");
    const idle = NAMES.filter((n) => LABELS[n]?.state === "idle");
    const hit = dialogs.filter((n) => menuSign(readFileSync(join(PANES, n), "utf8"))).length;
    const falseHit = idle.filter((n) => menuSign(readFileSync(join(PANES, n), "utf8"))).length;
    expect(hit / dialogs.length).toBeGreaterThan(0.6);
    expect(falseHit / idle.length).toBeLessThan(0.25);
  });

  test("the mutations are deterministic per seed", () => {
    const a = casesOf(42).map((c) => c.screen);
    const b = casesOf(42).map((c) => c.screen);
    expect(a).toEqual(b);
  });

  test("I7: on a screen with a menu sign, no road of Collie's own, the person's first tap or the override writes Enter, a digit or a letter", async () => {
    expect((await results()).i7).toEqual([]);
  }, 120_000);

  test("I4: no override is refused on a screen with no menu sign for a reason outside the known-red buckets", async () => {
    expect((await results()).i4.get("other") ?? []).toEqual([]);
  }, 120_000);

  const blind = knownRed("i7-blind-road");
  test.failing(`I7: the blind road (an agent with no profile) writes no Enter, digit or letter onto a menu ${redTitle(blind.id)}`, async () => {
    const hits = (await results()).i7Blind;
    console.info(`[invariants.mutation] i7-blind-road: ${String(hits.length)} hits; first: ${hits[0] ?? "-"}`);
    expect(hits).toEqual([]);
  }, 120_000);

  for (const id of ["i4-bridge-not-free", "i4-bridge-turn"] as const) {
    const red = knownRed(id);
    test.failing(`I4 on mutated captures: ${red.what} ${redTitle(id)}`, async () => {
      const hits = (await results()).i4.get(id) ?? [];
      console.info(`[invariants.mutation] ${id}: ${String(hits.length)} hits`);
      expect(hits).toEqual([]);
    }, 120_000);
  }

  // The draft without a box shows on a few captures only, so the sample may miss it: listed, not asserted.
  test("I4 on mutated captures: the draft-without-a-box refusals are counted (i4-bridge-draft-no-box, asserted in the gates suite)", async () => {
    console.info(`[invariants.mutation] i4-bridge-draft-no-box: ${String(((await results()).i4.get("i4-bridge-draft-no-box") ?? []).length)} hits`);
  }, 120_000);
});
