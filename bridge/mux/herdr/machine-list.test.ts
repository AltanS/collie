import { describe, expect, test } from "bun:test";

import { CANDIDATE_TIMEOUT_MS, type HostProbe, type HostProbeResult } from "../host-candidates.ts";
import { herdrMachineCandidates, HERDR_MACHINE_LIST_ARGS, parseHerdrMachines } from "./machine-list.ts";

// `herdr machine list --json` behind a recording probe. **NOTHING here spawns `herdr`**: the probe
// is a function that records `(tool, args, timeoutMs)` and answers from the test's own table, which
// is the same boundary `cli/fakes.ts` draws for every other tool this CLI runs.

interface Recorded {
  tool: string;
  args: readonly string[];
  timeoutMs: number;
}

/** A probe that records what it was asked and answers from the test's own table. */
interface Rig {
  probe: HostProbe;
  calls: Recorded[];
  warnings: string[];
}

function probeFor(answer: Partial<HostProbeResult>): Rig {
  const calls: Recorded[] = [];
  const warnings: string[] = [];
  const probe: HostProbe = {
    run: (tool, args, timeoutMs) => {
      calls.push({ tool, args, timeoutMs });
      return { code: 0, stdout: "", stderr: "", found: true, ...answer };
    },
    warn: (line) => void warnings.push(line),
  };
  return { probe, calls, warnings };
}

const TWO_MACHINES = JSON.stringify([
  { target: "op@attic.lan:22", label: "attic" },
  { target: "build-box", id: "m-2" },
]);

describe("parseHerdrMachines", () => {
  test("reads target, label and id, and ignores extra fields", () => {
    const parsed = parseHerdrMachines(
      JSON.stringify([{ target: "attic", label: "The attic", id: "m-1", colour: "blue", panes: 4 }]),
    );
    expect(parsed).toEqual([{ target: "attic", label: "The attic", id: "m-1" }]);
  });

  test("label and id are optional, and an empty one reads as absent", () => {
    expect(parseHerdrMachines(JSON.stringify([{ target: "attic" }, { target: "nas", label: "  " }]))).toEqual([
      { target: "attic", label: null, id: null },
      { target: "nas", label: null, id: null },
    ]);
  });

  test("an empty list is a valid answer, not a failure", () => {
    expect(parseHerdrMachines("[]")).toEqual([]);
  });

  test("anything that is not an array of targeted objects is null", () => {
    expect(parseHerdrMachines("")).toBeNull();
    expect(parseHerdrMachines("not json")).toBeNull();
    expect(parseHerdrMachines('{"machines":[]}')).toBeNull();
    expect(parseHerdrMachines('["attic"]')).toBeNull();
    expect(parseHerdrMachines("[null]")).toBeNull();
    expect(parseHerdrMachines('[{"label":"attic"}]')).toBeNull();
    expect(parseHerdrMachines('[{"target":""}]')).toBeNull();
    expect(parseHerdrMachines('[{"target":"attic","label":7}]')).toBeNull();
    expect(parseHerdrMachines('[{"target":"attic","id":[]}]')).toBeNull();
  });

  test("one unreadable row fails the whole list rather than being skipped", () => {
    expect(parseHerdrMachines('[{"target":"attic"},{"target":7}]')).toBeNull();
  });
});

describe("herdrMachineCandidates", () => {
  test("healthy: exit 0 and valid JSON are the candidates", () => {
    const { probe, calls, warnings } = probeFor({ stdout: TWO_MACHINES });
    expect(herdrMachineCandidates(probe)).toEqual([
      { target: "op@attic.lan:22", label: "attic", id: null },
      { target: "build-box", label: null, id: "m-2" },
    ]);
    expect(warnings).toEqual([]);
    expect(calls).toEqual([{ tool: "herdr", args: HERDR_MACHINE_LIST_ARGS, timeoutMs: CANDIDATE_TIMEOUT_MS }]);
  });

  test("the one shell-out carries the shared per-call budget", () => {
    const { probe, calls } = probeFor({ stdout: "[]" });
    herdrMachineCandidates(probe);
    expect(calls[0]!.timeoutMs).toBe(CANDIDATE_TIMEOUT_MS);
    expect(CANDIDATE_TIMEOUT_MS).toBe(3_000);
  });

  test("absent: no herdr on PATH is no candidates and no line", () => {
    const { probe, warnings } = probeFor({ found: false, code: 127 });
    expect(herdrMachineCandidates(probe)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("absent: a herdr with no machine subcommand is no candidates and no line", () => {
    const { probe, warnings } = probeFor({ code: 2, stderr: "error: unknown command 'machine'\n" });
    expect(herdrMachineCandidates(probe)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("unhealthy: a non-zero exit is no candidates and exactly ONE line naming the cause", () => {
    const { probe, warnings } = probeFor({ code: 1, stderr: "cannot read machines.json\n" });
    expect(herdrMachineCandidates(probe)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe("warn: `herdr machine list --json` exited 1 — offering no herdr candidates.");
  });

  test("unhealthy: a timeout is named as one, under the same budget", () => {
    const { probe, warnings } = probeFor({ code: 124 });
    expect(herdrMachineCandidates(probe)).toEqual([]);
    expect(warnings).toEqual([
      `warn: \`herdr machine list --json\` did not answer within ${CANDIDATE_TIMEOUT_MS} ms — offering no herdr candidates.`,
    ]);
  });

  test("unhealthy: JSON that fails the shape check is no candidates and one line", () => {
    const { probe, warnings } = probeFor({ stdout: '{"machines":["attic"]}' });
    expect(herdrMachineCandidates(probe)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("something this build cannot read");
  });

  test("neither absent nor unhealthy ever throws — a broken herdr never fails crew add", () => {
    for (const answer of [{ found: false }, { code: 1 }, { code: 124 }, { stdout: "}" }] as const) {
      const { probe } = probeFor(answer);
      expect(() => herdrMachineCandidates(probe)).not.toThrow();
    }
  });
});
