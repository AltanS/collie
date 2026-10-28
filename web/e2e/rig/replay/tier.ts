// Which model tier each of pi and omp runs on in one leg (M67, ADR 0125): `replay` (the stub answers
// from the cassettes in web/e2e/rig/cassettes, no key is loaded, nothing reaches OpenRouter) or `live`
// (the stub passes each request on to OpenRouter with the harness's own key, and records when asked).
// Claude Code is not here: it always runs live on its own login.
//
// THE RULE (auto, the default). A harness replays when the cassettes hold its version for this leg,
// recorded with the same model and the same walky talky skill text. Otherwise it runs live and its
// cassettes are written in this run, so the next run replays: a new harness version is the trigger
// for the live tier, and nothing else is needed to keep the cassettes current.
//
//   COLLIE_RIG_MODEL=auto     the rule above (default)
//   COLLIE_RIG_MODEL=replay   replay or stop: a harness with no cassette fails the run before it starts
//   COLLIE_RIG_MODEL=live     every harness live; records only with COLLIE_RIG_RECORD=1
//   COLLIE_RIG_LIVE=pi,omp    these harnesses live (`all`: both); the rest by the rule
//   COLLIE_RIG_RECORD=1       a live harness writes its cassettes (a version miss records anyway)
//
// A live harness needs COLLIE_RIG_KEY_FILE. Without it, a live harness spends no turn (harnesses.ts
// turns it off, as before M67) and records nothing.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { BIN } from "../bins";
import { parseVersion } from "../nightly";
import { LEG_HARNESSES, type Leg } from "../scenarios";
import { shortHash, versionDir, type CassetteMeta, type Literal } from "./cassette";

/** The harnesses whose model calls go through the stub. */
export const STUB_HARNESSES = ["pi", "omp"] as const;
export type StubHarness = (typeof STUB_HARNESSES)[number];

export type ModelMode = "auto" | "replay" | "live";
export type Tier = "replay" | "live";

/** One harness's tier for one leg, and why. Travels as JSON in COLLIE_RIG_TIERS. */
export interface TierPlan {
  readonly harness: StubHarness;
  readonly leg: string;
  /** The harness's `--version`, or null when it could not be read. */
  readonly version: string | null;
  readonly tier: Tier;
  /** A live harness writes its cassettes in this run. */
  readonly record: boolean;
  readonly reason: string;
  /** The model the harness starts on, `openrouter/anthropic/claude-haiku-4.5`. */
  readonly model: string;
  /** The skill hash the cassettes were (or will be) recorded with. */
  readonly skill: string;
  /** On replay: the cases whose recording comes from a live run in which the case did not pass. */
  readonly failed?: readonly string[];
}

/** The tier of each stub harness the leg runs. A harness the leg does not start (omp on the crew leg) has no plan. */
export interface TierPlans {
  pi?: TierPlan;
  omp?: TierPlan;
}

/** The `--version` of each stub harness's binary, null where it did not answer. */
export interface HarnessVersions {
  readonly pi: string | null;
  readonly omp: string | null;
}

/** The environment name the plans travel in, from the global setup to the rig daemon and the workers. */
export const TIERS_ENV = "COLLIE_RIG_TIERS";

/** This checkout: web/e2e/rig/replay/tier.ts is four levels below it. */
const WORKTREE = resolve(import.meta.dirname, "..", "..", "..", "..");
/** Where the cassettes live, in the checkout the leg runs from. */
export const CASSETTE_ROOT = resolve(import.meta.dirname, "..", "cassettes");
/** The walky talky skill's template: its text goes into pi's prompt, so it keys the cassettes. */
export const SKILL_TEMPLATE = join(WORKTREE, "cli", "skills", "walky-talky.md");

export function skillHash(): string {
  return shortHash(readFileSync(SKILL_TEMPLATE, "utf8"));
}

/** The model a harness starts on (harnesses.ts SETUPS reads it from here). */
export function modelFor(harness: StubHarness, env: Readonly<Record<string, string | undefined>> = process.env): string {
  return (harness === "pi" ? env.COLLIE_RIG_PI_MODEL : env.COLLIE_RIG_OMP_MODEL) ?? "openrouter/anthropic/claude-haiku-4.5";
}

/** What the environment asks for. */
export interface TierAsk {
  readonly mode: ModelMode;
  readonly live: ReadonlySet<StubHarness>;
  readonly record: boolean;
  readonly keyFile: boolean;
}

export function readTierAsk(env: Readonly<Record<string, string | undefined>>): TierAsk {
  const mode = env.COLLIE_RIG_MODEL ?? "auto";
  if (mode !== "auto" && mode !== "replay" && mode !== "live") throw new Error(`COLLIE_RIG_MODEL is auto, replay or live, not "${mode}"`);
  const live = new Set<StubHarness>();
  for (const word of (env.COLLIE_RIG_LIVE ?? "").split(",").map((w) => w.trim())) {
    if (word === "") continue;
    if (word === "all") STUB_HARNESSES.forEach((h) => live.add(h));
    else if (word === "pi" || word === "omp") live.add(word);
    else throw new Error(`COLLIE_RIG_LIVE names pi, omp or all, not "${word}"`);
  }
  if (mode === "live") STUB_HARNESSES.forEach((h) => live.add(h));
  if (mode === "replay" && live.size > 0) throw new Error("COLLIE_RIG_MODEL=replay and COLLIE_RIG_LIVE ask for opposite things");
  return { mode, live, record: /^(1|true|yes)$/iu.test(env.COLLIE_RIG_RECORD ?? ""), keyFile: (env.COLLIE_RIG_KEY_FILE ?? "") !== "" };
}

/** Why a leg's cassettes do not cover this run, or null when they do. */
export function coverGap(meta: CassetteMeta | null, harness: StubHarness, version: string, leg: string, model: string, skill: string): string | null {
  const legMeta = meta?.legs[leg];
  if (meta === null || legMeta === undefined) return `no cassettes for ${harness} ${version} (${leg} leg)`;
  if (legMeta.model !== model) return `the ${harness} ${version} cassettes are for ${legMeta.model}, not ${model}`;
  if (legMeta.skill !== skill) return `the ${harness} ${version} cassettes were recorded with another walky talky skill text (${legMeta.skill}, now ${skill})`;
  return null;
}

/** The one decision, pure. Throws for COLLIE_RIG_MODEL=replay when the cassettes do not cover the run. */
export function decideTier(harness: StubHarness, version: string | null, leg: string, meta: CassetteMeta | null, model: string, skill: string, ask: TierAsk): TierPlan {
  const base = { harness, leg, version, model, skill };
  const gap = version === null ? `the ${harness} version could not be read` : coverGap(meta, harness, version, leg, model, skill);
  if (ask.live.has(harness)) {
    const record = ask.record && ask.keyFile && version !== null;
    return { ...base, tier: "live", record, reason: `forced live (${ask.mode === "live" ? "COLLIE_RIG_MODEL=live" : "COLLIE_RIG_LIVE"})${record ? ", recording" : ""}` };
  }
  if (gap === null) {
    const failed = meta?.legs[leg]?.failed ?? [];
    const note = failed.length === 0 ? "" : `; ${String(failed.length)} recorded in a case that did not pass: ${failed.join(", ")}`;
    return { ...base, tier: "replay", record: false, reason: `cassettes ${harness}/${version ?? "?"} (${leg} leg)${note}`, failed };
  }
  if (ask.mode === "replay") throw new Error(`COLLIE_RIG_MODEL=replay: ${gap}. Record them once: COLLIE_RIG_MODEL=live COLLIE_RIG_RECORD=1 COLLIE_RIG_KEY_FILE=... (web/e2e/rig/README.md)`);
  // A version miss runs live and records, so the next run replays. Never record under an unknown version.
  const record = ask.keyFile && version !== null;
  return { ...base, tier: "live", record, reason: `${gap}: live${record ? ", recording" : ask.keyFile ? "" : ", no key file: no turns"}` };
}

export function readMeta(root: string, harness: StubHarness, version: string): CassetteMeta | null {
  const file = join(root, harness, versionDir(version), "meta.json");
  if (!existsSync(file)) return null;
  // SAFETY: meta.json is the stub's own output (stub.ts writeMeta); a broken file throws here, before a paid step.
  return JSON.parse(readFileSync(file, "utf8")) as CassetteMeta;
}

/** The version of the binary the rig starts for a harness (bins.ts), or null when it does not answer. */
export function binaryVersion(harness: StubHarness): string | null {
  const r = spawnSync(BIN[harness], ["--version"], { encoding: "utf8", timeout: 30_000 });
  return r.status === 0 ? (parseVersion(`${r.stdout}${r.stderr}`) ?? null) : null;
}

export function readVersions(): HarnessVersions {
  return { pi: binaryVersion("pi"), omp: binaryVersion("omp") };
}

/**
 * The folders a cassette never names as they are: the rig's state root, this checkout and the home
 * folder. The recorder writes the placeholder, and a replay puts its own folder back in.
 */
export function rigLiterals(stateRoot: string): Literal[] {
  return [
    [stateRoot, "{{lab}}"],
    [WORKTREE, "{{worktree}}"],
    [homedir(), "{{home}}"],
  ];
}

/** Plan the stub harnesses a leg runs (LEG_HARNESSES in scenarios.ts). A harness the leg does not run needs no cassette. */
export function planTiers(leg: Leg, env: Readonly<Record<string, string | undefined>>, versions: HarnessVersions, root: string = CASSETTE_ROOT): TierPlans {
  const ask = readTierAsk(env);
  const skill = skillHash();
  const plan = (h: StubHarness): TierPlan => {
    const version = versions[h];
    return decideTier(h, version, leg, version === null ? null : readMeta(root, h, version), modelFor(h, env), skill, ask);
  };
  const runs = (h: StubHarness): boolean => LEG_HARNESSES[leg].some((id) => id === h);
  const plans: TierPlans = {};
  if (runs("pi")) plans.pi = plan("pi");
  if (runs("omp")) plans.omp = plan("omp");
  return plans;
}

/** The plans this process was given (the global setup sets them before the rig and the workers start), or null. */
export function tiersFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): TierPlans | null {
  const raw = env[TIERS_ENV];
  if (raw === undefined || raw === "") return null;
  // SAFETY: the global setup wrote this value with JSON.stringify(planTiers(...)) in this same run.
  return JSON.parse(raw) as TierPlans;
}

/** One line per harness for the leg's summary. */
export function tierLine(plan: TierPlan): string {
  return `${plan.harness} ${plan.version ?? "?"}: ${plan.tier}${plan.record ? " + record" : ""} (${plan.reason})`;
}
