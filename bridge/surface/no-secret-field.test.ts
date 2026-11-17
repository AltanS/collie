// A sign-in code (`secret: true`) goes only into a sign-in field the reader knows (2026-11-17, second review).
// Before the fix a code sent where S0 read no such field (the field closed between the look and the tap, or
// the pane has no profile) only lost its line and was typed into the agent's box or the shell, where it
// reached the model or the history. Now it is refused `no_secret_field` before any key, and its record keeps
// no line. The sign-in fixtures that are accepted as before live in protocol.sign-in.test.ts.
import { afterEach, describe, expect, test } from "bun:test";

import type { Surface } from "../../web/src/lib/surface/surface.ts";
import { NO_SECRET_FIELD } from "./protocol.ts";
import { invariantRig, nextId, writesSince, type InvariantRig, type RigOptions } from "./invariants-rig.ts";

const AGENT = { harness: "claude", pinVersions: [{ range: "2.1.0 - 2.1.296", low: "2.1.0", high: "2.1.296", status: "verified", verifiedThrough: "2.1.296", verifiedOn: "2026-10-12" }] } satisfies Pick<RigOptions, "harness" | "pinVersions">;
const CODE = "FAKEcode1234#FAKEstate";

const rigs: InvariantRig[] = [];
afterEach(() => {
  for (const rig of rigs.splice(0)) rig.dispose();
});

async function sendCode(options: RigOptions, before?: (rig: InvariantRig) => void) {
  const rig = invariantRig(options);
  rigs.push(rig);
  before?.(rig);
  const id = nextId();
  const from = rig.pane.log.length;
  const answer = await rig.handle({ id, text: CODE, mode: "send", fromPhone: true, secret: true });
  return { rig, answer, writes: writesSince(rig.pane, from), record: rig.store.get(id) };
}

function expectRefused(result: Awaited<ReturnType<typeof sendCode>>): void {
  expect(result.answer.receipt?.outcome).toBe("refused");
  expect(result.answer.receipt?.reason).toBe("no_secret_field");
  expect(result.answer.receipt?.detail).toBe(NO_SECRET_FIELD);
  expect(result.writes).toEqual([]);
  expect(result.rig.pane.box).not.toContain(CODE);
  expect(JSON.stringify(result.record)).not.toContain(CODE);
}

describe("a sign-in code with no sign-in field on the screen is refused before any key", () => {
  test("the agent's idle, empty box", async () => {
    expectRefused(await sendCode({ ...AGENT, draw: { kind: "box" } }));
  });

  test("the agent's box with a draft in it", async () => {
    const result = await sendCode({ ...AGENT, draw: { kind: "box" } }, (rig) => {
      rig.pane.box = "a draft of mine";
    });
    expectRefused(result);
    expect(result.rig.pane.box).toBe("a draft of mine");
  });

  test("a running turn over an empty box", async () => {
    expectRefused(await sendCode({ ...AGENT, draw: { kind: "box" }, surface: { revision: 7, turn: "running", modal: "none", composer: "empty" } satisfies Surface }));
  });

  test("a shell prompt (no profile, the blind road)", async () => {
    expectRefused(await sendCode({ harness: "bash", draw: { kind: "bare" }, version: null }));
  });
});
