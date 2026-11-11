// Pins every number that moved into `web/src/lib/tricks/limits.ts` to the literal value it had in its
// own file before the move (read from the integration tip dc82f5778, where each constant still lived in
// the bridge or CLI module named beside it). The move was meant to change no limit. If a later change to
// `limits.ts` moves one of these, this test fails, and the change has to say so out loud: edit the literal
// here in the same commit, on purpose.
//
// The test also holds the key set: a constant added to `limits.ts` fails until it is pinned here.

import { describe, expect, test } from "bun:test";

import * as limits from "../web/src/lib/tricks/limits.ts";

const DAY_MS = 86_400_000;

/** Name, value, and the file it lived in at dc82f5778. Plain numbers: no arithmetic that could hide a slip. */
const PINNED: ReadonlyArray<readonly [name: string, value: unknown, was: string]> = [
  // bridge/tricks/run.ts
  ["RUN_TIMEOUT_MS", 10_000, "bridge/tricks/run.ts"],
  ["STDOUT_CAP_BYTES", 65_536, "bridge/tricks/run.ts"],
  ["STDERR_CAP_BYTES", 8_192, "bridge/tricks/run.ts"],
  // bridge/tricks/service.ts
  ["RUNS_MAX", 4, "bridge/tricks/service.ts"],
  ["HILL_QUEUE_MAX", 32, "bridge/tricks/service.ts"],
  ["BACKOFF_MS", [60_000, 300_000, 1_800_000], "bridge/tricks/service.ts"],
  // bridge/tricks/env.ts
  [
    "BASE_ENV_NAMES",
    ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TZ", "TERM", "TMPDIR", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "NVM_DIR", "BUN_INSTALL"],
    "bridge/tricks/env.ts",
  ],
  // bridge/tricks/approved.ts, cli/trick.ts
  ["SEED_FILES_MAX", 500, "bridge/tricks/approved.ts"],
  ["SEED_BYTES_MAX", 67_108_864, "bridge/tricks/approved.ts"],
  ["SKILL_BYTES_MAX", 32_768, "cli/trick.ts"],
  // bridge/tricks/inputs.ts
  ["INPUT_TEXT_MAX_BYTES", 262_144, "bridge/tricks/inputs.ts"],
  ["INPUT_IMAGE_MAX_BYTES", 2_097_152, "bridge/tricks/inputs.ts"],
  ["INPUT_ANSWER_MAX_BYTES", 8_388_608, "bridge/tricks/inputs.ts"],
  ["INPUT_RUN_MAX_BYTES", 25_165_824, "bridge/tricks/inputs.ts"],
  // bridge/tricks/propose-wire.ts
  ["PROPOSE_LIMITS", { files: 300, bytes: 5_242_880, depth: 8, pathChars: 256, stepBytes: 255 }, "bridge/tricks/propose-wire.ts"],
  // bridge/tricks/proposals.ts
  ["PROPOSALS_SENDER_OPEN_MAX", 2, "bridge/tricks/proposals.ts"],
  ["PROPOSALS_SENDER_HOUR_MAX", 6, "bridge/tricks/proposals.ts"],
  ["PROPOSALS_MEMBER_OPEN_MAX", 4, "bridge/tricks/proposals.ts"],
  ["PROPOSALS_MACHINE_HOUR_MAX", 12, "bridge/tricks/proposals.ts"],
  ["PROPOSALS_OPEN_MAX", 8, "bridge/tricks/proposals.ts"],
  ["PROPOSAL_EXPIRY_MS", 259_200_000, "bridge/tricks/proposals.ts"],
  // bridge/tricks/card-group.ts (HILL_GROUP_PARTS.max was 8, so seven cards of code)
  ["GROUP_CODE_CARDS", 7, "bridge/tricks/card-group.ts"],
  ["GROUP_CARD_CODE_BYTES", 6_144, "bridge/tricks/card-group.ts"],
  ["GROUP_CODE_BYTES", 43_008, "bridge/tricks/card-group.ts"],
  ["GROUP_FILES_MAX", 64, "bridge/tricks/card-group.ts"],
  // bridge/hill/service.ts
  ["HILL_DEFAULT_EXPIRY_DAYS", 14, "bridge/hill/service.ts"],
  ["HILL_DEFAULT_EXPIRY_MS", 14 * DAY_MS, "bridge/hill/service.ts"],
  ["HILL_MAX_EXPIRY_DAYS", 30, "bridge/hill/service.ts"],
  ["HILL_MAX_EXPIRY_MS", 30 * DAY_MS, "bridge/hill/service.ts"],
];

/** What limits.ts exports, by name. */
const EXPORTED = new Map(Object.entries(limits));

describe("tricks limits: no value moved with the constants", () => {
  test("the pinned names are exactly the names limits.ts exports", () => {
    expect(PINNED.map(([name]) => name).toSorted()).toEqual(Object.keys(limits).toSorted());
  });

  for (const [name, value, was] of PINNED) {
    test(`${name} is what ${was} held`, () => {
      expect(EXPORTED.has(name)).toBe(true);
      expect(EXPORTED.get(name)).toEqual(value);
    });
  }

  test("summary", () => {
    const equal = PINNED.filter(([name, value]) => Bun.deepEquals(EXPORTED.get(name), value)).length;
    console.log(`${String(PINNED.length)} constants, ${equal === PINNED.length ? "all equal" : `${String(PINNED.length - equal)} DIFFER`}`);
    expect(equal).toBe(PINNED.length);
  });
});
