import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PUSH_TITLE_CODE_LIST, PUSH_TITLES, pushTitle, type PushTitleCode } from "./push-titles.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE DRIFT GUARD, as `error-codes.test.ts` keeps one for the error catalogue.
//
// The push title codes exist in two files that CANNOT import each other: `bridge/push-titles.ts` and
// `web/src/lib/push-title-codes.ts`. This reads BOTH as TEXT and compares the code sets. A code added
// on one side and forgotten on the other fails here, rather than on a phone whose notification quietly
// stays in English.
// ─────────────────────────────────────────────────────────────────────────────

const REPO = join(import.meta.dir, "..");
const BRIDGE_CATALOGUE = join(REPO, "bridge", "push-titles.ts");
const WEB_MIRROR = join(REPO, "web", "src", "lib", "push-title-codes.ts");
const WEB_ENGLISH = join(REPO, "web", "src", "lib", "i18n", "messages", "en.ts");

/** The text between a named declaration's opening bracket and its `} as const` / `] as const`. */
function blockAfter(source: string, opener: string, closer: string): string {
  const start = source.indexOf(opener);
  expect(start, `no \`${opener}\` in the source`).toBeGreaterThan(-1);
  const end = source.indexOf(closer, start);
  expect(end, `no \`${closer}\` after \`${opener}\``).toBeGreaterThan(start);
  return source.slice(start + opener.length, end);
}

/** The codes the BRIDGE file declares, read as text: quoted keys at the start of a line only. */
function bridgeCodesFromSource(): string[] {
  const block = blockAfter(readFileSync(BRIDGE_CATALOGUE, "utf8"), "export const PUSH_TITLES = {", "} as const;");
  const codes: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const match = /^\s{2}"([^"]+)":/.exec(line);
    if (match) codes.push(match[1]!);
  }
  return codes;
}

/** The codes the WEB mirror lists, one entry per line. */
function webCodesFromSource(): string[] {
  const block = blockAfter(readFileSync(WEB_MIRROR, "utf8"), "export const PUSH_TITLE_CODES = [", "] as const;");
  const codes: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const match = /^\s{2}"([^"]+)",$/.exec(line);
    if (match) codes.push(match[1]!);
  }
  return codes;
}

/** The `{slot}` names in a template, sorted, so two spellings of one sentence compare equal. */
function slotsOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).toSorted();
}

describe("push title codes — bridge and web mirror", () => {
  test("the text read of the bridge catalogue agrees with what the module exports", () => {
    expect(bridgeCodesFromSource()).toEqual([...PUSH_TITLE_CODE_LIST]);
    expect(PUSH_TITLE_CODE_LIST.length).toBeGreaterThan(0);
  });

  test("the web mirror lists exactly the bridge's codes, in the bridge's order", () => {
    expect(webCodesFromSource()).toEqual(bridgeCodesFromSource());
  });

  test("codes are lower-snake, dot-grouped by surface", () => {
    const ungrouped = PUSH_TITLE_CODE_LIST.filter((code) => !/^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/.test(code));
    expect(ungrouped).toEqual([]);
  });

  test("the web's English template for every code is the bridge's sentence, byte for byte", () => {
    // The phone's English and the bridge's English are one sentence written twice. If they drifted, an
    // English-speaking device would read a different headline than the one the bridge sent.
    const english = readFileSync(WEB_ENGLISH, "utf8");
    for (const code of PUSH_TITLE_CODE_LIST) {
      const line = new RegExp(`^\\s{2}"pushTitle\\.${code.replace(".", "\\.")}": "([^"]*)",$`, "m").exec(english);
      expect(line?.[1], `no pushTitle.${code} in en.ts`).toBe(PUSH_TITLES[code]);
    }
  });
});

describe("pushTitle — the English comes from the catalogue", () => {
  test("a code with no slots renders its sentence and carries no detail key", () => {
    const title = pushTitle("update.available");
    expect(title).toEqual({ title: "Collie update available", titleCode: "update.available" });
    expect("titleDetail" in title).toBe(false);
  });

  test("a slot is filled from detail, and the detail rides along for a translated title", () => {
    expect(pushTitle("agent.blocked", { agent: "claude" })).toEqual({
      title: "claude needs you",
      titleCode: "agent.blocked",
      titleDetail: { agent: "claude" },
    });
    expect(pushTitle("herd.mixed", { count: 3 }).title).toBe("3 agents need attention");
    expect(pushTitle("cache.cold_soon", { minutes: 5 }).title).toBe("Cache goes cold in about 5 min");
  });

  test("interpolation is ONE pass — an agent's name is never re-scanned for slots", () => {
    expect(pushTitle("agent.done", { agent: "{count}" }).title).toBe("{count} is done");
  });

  test("the sentences are the ones the bridge sent before codes existed", () => {
    // Changing one is a user-visible change for every device on an English phone or an older worker.
    expect(PUSH_TITLES).toEqual({
      "agent.blocked": "{agent} needs you",
      "agent.done": "{agent} is done",
      "herd.blocked": "{count} agents need you",
      "herd.done": "{count} agents done",
      "herd.mixed": "{count} agents need attention",
      "update.available": "Collie update available",
      "cache.cold_soon": "Cache goes cold in about {minutes} min",
      "machine.cpu": "CPU stays high on {machine}",
      "machine.mem": "Memory stays high on {machine}",
      "machine.disk": "Disk stays full on {machine}",
    });
  });

  test("every slotted template names only the slots its call site fills", () => {
    // The call sites are few and fixed: an agent title fills `agent`, a digest `count`, the cache
    // warning `minutes`. A template that grew a slot nobody fills would render a hole.
    const filled = {
      "agent.blocked": ["agent"],
      "agent.done": ["agent"],
      "herd.blocked": ["count"],
      "herd.done": ["count"],
      "herd.mixed": ["count"],
      "update.available": [],
      "cache.cold_soon": ["minutes"],
      "machine.cpu": ["machine"],
      "machine.mem": ["machine"],
      "machine.disk": ["machine"],
    } satisfies Record<PushTitleCode, string[]>;
    for (const code of PUSH_TITLE_CODE_LIST) expect(slotsOf(PUSH_TITLES[code])).toEqual(filled[code]);
  });
});
