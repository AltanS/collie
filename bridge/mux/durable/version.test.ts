import { afterEach, describe, expect, test } from "bun:test";

import { DurableMux, MIN_SNAPSHOT_GAP_MS } from "./adapter.ts";
import { FakeDurableClock, FakeDurableProgram } from "./fixture.ts";
import { negotiateVersion, SPEAKS, speaksRange, versionNotice, versionRefusal, WIRE_VERSION } from "./protocol.ts";

// THE VERSION POLICY (WIRE.md section 2, M55 spec 03). Collie speaks version N and still takes N-1 for one minor after
// N ships. A program whose range meets neither is refused with one object that names both sides, Collie writes one
// line, the pane list shows one notice row, and the program is told once per start so its own log can say the same.

const programs: FakeDurableProgram[] = [];

afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
});

/** A Collie at version N that still accepts N-1. */
const AT_TWO = speaksRange(2, 1);

describe("the version table", () => {
  test("this Collie speaks version 1, and version 1 has no predecessor to accept", () => {
    expect(WIRE_VERSION).toBe(1);
    expect(SPEAKS).toEqual({ min: 1, max: 1 });
  });

  test("version in range: the highest shared version is spoken", () => {
    expect(negotiateVersion({ min: 1, max: 1 })).toBe(1);
    expect(negotiateVersion({ min: 1, max: 5 })).toBe(1);
    expect(negotiateVersion({ min: 2, max: 2 }, AT_TWO)).toBe(2);
    expect(negotiateVersion({ min: 1, max: 9 }, AT_TWO)).toBe(2);
  });

  test("version N-1: a Collie at N still speaks the program that stopped one version back", () => {
    expect(AT_TWO).toEqual({ min: 1, max: 2 });
    expect(negotiateVersion({ min: 1, max: 1 }, AT_TWO)).toBe(1);
    expect(versionRefusal({ min: 1, max: 1 }, AT_TWO)).toBeNull();
    // The minor after that one drops N-1, and the same program is refused.
    expect(negotiateVersion({ min: 1, max: 1 }, speaksRange(2, null))).toBeNull();
  });

  test("version excluded on either side: the refusal names both ranges", () => {
    expect(versionRefusal({ min: 3, max: 4 }, AT_TWO)).toEqual({ code: "version", collie: [1, 2], program: [3, 4] });
    expect(versionRefusal({ min: 0, max: 0 }, AT_TWO)).toEqual({ code: "version", collie: [1, 2], program: [0, 0] });
    expect(versionRefusal({ min: 2, max: 3 })).toEqual({ code: "version", collie: [1, 1], program: [2, 3] });
  });

  test("the version notice row is one line naming the program's newest and this Collie's own", () => {
    const refusal = versionRefusal({ min: 2, max: 3 });
    expect(refusal).not.toBeNull();
    expect(versionNotice(refusal!)).toBe("The durable agent speaks wire v3, this Collie speaks v1. Update Collie, or the agent's SDK.");
    expect(versionNotice({ code: "version", collie: [1, 2], program: [0, 0] })).toBe("The durable agent speaks wire v0, this Collie speaks v2. Update Collie, or the agent's SDK.");
  });
});

describe("a version refusal, both sides", () => {
  async function rig(range: { min: number; max: number }) {
    const program = await FakeDurableProgram.startWire();
    programs.push(program);
    program.range = range;
    const clock = new FakeDurableClock();
    const lines: string[] = [];
    const adapter = new DurableMux(program.wire(), clock, null, (line) => lines.push(line));
    return { program, clock, lines, adapter };
  }

  test("Collie's side: one log line, the refusal kept for the notice row, the census never empty", async () => {
    const { adapter, clock, lines } = await rig({ min: 2, max: 3 });
    for (let poll = 0; poll < 3; poll += 1) {
      const outcome = await adapter.poll();
      expect(outcome.ok).toBe(false);
      clock.advance(MIN_SNAPSHOT_GAP_MS);
    }
    expect(lines).toEqual(["[durable] The durable agent speaks wire v3, this Collie speaks v1. Update Collie, or the agent's SDK."]);
    expect(adapter.versionRefusal()).toEqual({ code: "version", collie: [1, 1], program: [2, 3] });
    expect(await adapter.reachable()).toBe(false);
  });

  test("the program's side: one telling hello per start carries this Collie's version and gets the 409 with the refusal", async () => {
    const { adapter, program, clock } = await rig({ min: 2, max: 3 });
    await adapter.poll();
    clock.advance(MIN_SNAPSHOT_GAP_MS);
    await adapter.poll();
    const told = program.requests.filter((request) => request.version !== null);
    expect(told.map((request) => request.path)).toEqual(["/session/v1/hello"]);
    expect(told[0]?.version).toBe(String(SPEAKS.max));

    const answer = await program.rawGet("/session/v1/hello", { "x-collie-session": "1" });
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({ code: "incompatible", range: { min: 2, max: 3 }, refusal: { code: "version", collie: [1, 1], program: [2, 3] } });

    // A restart of the program is a new start: it is told once more, and Collie writes no second line for the same range.
    program.restart();
    clock.advance(MIN_SNAPSHOT_GAP_MS);
    await adapter.poll();
    // Three: the first start's telling hello, this test's own look at the 409, and the second start's telling hello.
    expect(program.requests.filter((request) => request.version !== null)).toHaveLength(3);
  });

  test("a program that updates into range clears the version refusal", async () => {
    const { adapter, program, clock } = await rig({ min: 2, max: 3 });
    await adapter.poll();
    expect(adapter.versionRefusal()).not.toBeNull();
    program.range = { min: 1, max: 3 };
    clock.advance(MIN_SNAPSHOT_GAP_MS);
    expect((await adapter.poll()).ok).toBe(true);
    expect(adapter.versionRefusal()).toBeNull();
  });

  test("a version a program does not know is ignored as an unknown field would be: an extra hello field changes nothing", async () => {
    const { adapter, program } = await rig({ min: 1, max: 1 });
    program.override = (path) => (path.endsWith("/hello") ? Response.json({ ...program.currentHello(), later: { field: true } }) : undefined);
    expect((await adapter.poll()).ok).toBe(true);
  });
});
