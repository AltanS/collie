import { describe, expect, test } from "bun:test";

import { CANDIDATE_TIMEOUT_MS, type HostProbe, type HostProbeResult } from "../host-candidates.ts";
import {
  HC_MACHINE_LIST_ARGS,
  herdrCoreMachineCandidates,
  parseHcMachines,
  VIA_BLOCKED_REASON,
} from "./machine-list.ts";

// `hc machine ls --json` behind a recording probe. **NOTHING here spawns `hc`**: the probe is a
// function that records `(tool, args, timeoutMs)` and answers from the test's own table, the same
// boundary `../herdr/machine-list.test.ts` draws for the TUI.

interface Recorded {
  tool: string;
  args: readonly string[];
  timeoutMs: number;
}

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

const listOf = (machines: readonly object[]): string => JSON.stringify({ machines });

const TWO_MACHINES = listOf([
  { target: "op@attic.lan:22", name: "attic", via: false, temporary: false, state: "connected", version: "0.1.14" },
  { target: "build-box", id: "m-2" },
]);

/** The live answer of a stopped core: JSON on stdout, exit 5. */
const UNAVAILABLE = JSON.stringify({
  error: {
    hint: "XDG_RUNTIME_DIR or HC_SOCKET differs from where the core started",
    kind: "unavailable",
    message: "the core listens at /run/user/1000/herdr-core/default.sock, but this shell looks at /nonexistent/x.sock",
  },
});

describe("parseHcMachines", () => {
  test("reads target, name as the label and id, and ignores extra fields", () => {
    const parsed = parseHcMachines(
      listOf([
        {
          host: "attic",
          id: "bb92",
          name: "The attic",
          session: null,
          state: "connected",
          target: "altan@attic",
          temporary: false,
          version: "0.1.14",
          via: false,
          colour: "blue",
        },
      ]),
    );
    expect(parsed).toEqual([{ target: "altan@attic", label: "The attic", id: "bb92", blocked: null }]);
  });

  test("name and id are optional, and an empty one reads as absent", () => {
    expect(parseHcMachines(listOf([{ target: "attic" }, { target: "nas", name: "  ", id: null }]))).toEqual([
      { target: "attic", label: null, id: null, blocked: null },
      { target: "nas", label: null, id: null, blocked: null },
    ]);
  });

  test("a missing via or temporary reads false", () => {
    expect(parseHcMachines(listOf([{ target: "attic" }]))).toEqual([
      { target: "attic", label: null, id: null, blocked: null },
    ]);
    expect(parseHcMachines(listOf([{ target: "attic", via: null, temporary: null }]))).toEqual([
      { target: "attic", label: null, id: null, blocked: null },
    ]);
  });

  test("an empty list is a valid answer, not a failure", () => {
    expect(parseHcMachines('{"machines":[]}')).toEqual([]);
  });

  test("a sandbox (temporary) is dropped", () => {
    expect(
      parseHcMachines(listOf([{ target: "sandbox-1", temporary: true }, { target: "attic", temporary: false }])),
    ).toEqual([{ target: "attic", label: null, id: null, blocked: null }]);
  });

  test("a via row is kept and blocked with the reason", () => {
    expect(parseHcMachines(listOf([{ target: "altan@vps", name: "vps", via: true }]))).toEqual([
      { target: "altan@vps", label: "vps", id: null, blocked: "reached without ssh (added with --via)" },
    ]);
    expect(VIA_BLOCKED_REASON).toBe("reached without ssh (added with --via)");
  });

  test("anything that is not an object with a machines array of targeted objects is null", () => {
    expect(parseHcMachines("")).toBeNull();
    expect(parseHcMachines("not json")).toBeNull();
    expect(parseHcMachines("[]")).toBeNull();
    expect(parseHcMachines('[{"target":"attic"}]')).toBeNull();
    expect(parseHcMachines("null")).toBeNull();
    expect(parseHcMachines("{}")).toBeNull();
    expect(parseHcMachines('{"machines":"attic"}')).toBeNull();
    expect(parseHcMachines('{"machines":["attic"]}')).toBeNull();
    expect(parseHcMachines('{"machines":[null]}')).toBeNull();
    expect(parseHcMachines('{"machines":[{"name":"attic"}]}')).toBeNull();
    expect(parseHcMachines('{"machines":[{"target":""}]}')).toBeNull();
    expect(parseHcMachines('{"machines":[{"target":"attic","name":7}]}')).toBeNull();
    expect(parseHcMachines('{"machines":[{"target":"attic","id":[]}]}')).toBeNull();
    expect(parseHcMachines('{"machines":[{"target":"attic","via":"yes"}]}')).toBeNull();
    expect(parseHcMachines('{"machines":[{"target":"attic","temporary":1}]}')).toBeNull();
  });

  test("one unreadable row fails the whole list rather than being skipped", () => {
    expect(parseHcMachines('{"machines":[{"target":"attic"},{"target":7}]}')).toBeNull();
    // Even a row that would have been dropped as a sandbox must be readable.
    expect(parseHcMachines('{"machines":[{"target":"attic"},{"temporary":true}]}')).toBeNull();
  });
});

describe("herdrCoreMachineCandidates", () => {
  test("healthy: exit 0 and valid JSON are the candidates", () => {
    const { probe, calls, warnings } = probeFor({ stdout: TWO_MACHINES });
    expect(herdrCoreMachineCandidates(probe)).toEqual([
      { target: "op@attic.lan:22", label: "attic", id: null, blocked: null },
      { target: "build-box", label: null, id: "m-2", blocked: null },
    ]);
    expect(warnings).toEqual([]);
    expect(calls).toEqual([{ tool: "hc", args: HC_MACHINE_LIST_ARGS, timeoutMs: CANDIDATE_TIMEOUT_MS }]);
    expect(HC_MACHINE_LIST_ARGS).toEqual(["machine", "ls", "--json"]);
  });

  test("the one shell-out carries the shared per-call budget", () => {
    const { probe, calls } = probeFor({ stdout: '{"machines":[]}' });
    herdrCoreMachineCandidates(probe);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.timeoutMs).toBe(3_000);
  });

  test("absent: no hc on PATH is no candidates and no line", () => {
    const { probe, warnings } = probeFor({ found: false, code: 127 });
    expect(herdrCoreMachineCandidates(probe)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("absent: a core that is not running (unavailable, exit 5) is no candidates and SILENT", () => {
    const { probe, warnings } = probeFor({ code: 5, stdout: UNAVAILABLE });
    expect(herdrCoreMachineCandidates(probe)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("absent: an hc with no machine subcommand is no candidates and no line", () => {
    const { probe, warnings } = probeFor({
      code: 2,
      stdout: JSON.stringify({ error: { kind: "usage", message: "unrecognized subcommand 'machine'" } }),
    });
    expect(herdrCoreMachineCandidates(probe)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("unhealthy: a non-zero exit names the core's own message when it gave one", () => {
    const { probe, warnings } = probeFor({
      code: 1,
      stdout: JSON.stringify({ error: { kind: "internal", message: "cannot read machines" } }),
    });
    expect(herdrCoreMachineCandidates(probe)).toEqual([]);
    expect(warnings).toEqual(["warn: `hc machine ls --json` exited 1 (cannot read machines) — offering no hc candidates."]);
  });

  test("unhealthy: a non-zero exit without JSON names the exit code", () => {
    const { probe, warnings } = probeFor({ code: 3, stderr: "boom\n" });
    expect(herdrCoreMachineCandidates(probe)).toEqual([]);
    expect(warnings).toEqual(["warn: `hc machine ls --json` exited 3 — offering no hc candidates."]);
  });

  test("unhealthy: a timeout is named as one, under the same budget", () => {
    const { probe, warnings } = probeFor({ code: 124 });
    expect(herdrCoreMachineCandidates(probe)).toEqual([]);
    expect(warnings).toEqual([
      `warn: \`hc machine ls --json\` did not answer within ${CANDIDATE_TIMEOUT_MS} ms — offering no hc candidates.`,
    ]);
  });

  test("unhealthy: JSON that fails the shape check is no candidates and one line", () => {
    for (const stdout of ['{"machines":["attic"]}', '[{"target":"attic"}]', "garbage"]) {
      const { probe, warnings } = probeFor({ stdout });
      expect(herdrCoreMachineCandidates(probe)).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("something this build cannot read");
    }
  });

  test("a sandbox is dropped and a via row is blocked, end to end", () => {
    const { probe, warnings } = probeFor({
      stdout: listOf([
        { target: "altan@minibuch", name: "minibuch" },
        { target: "sbx", temporary: true },
        { target: "altan@vps", name: "vps", via: true },
      ]),
    });
    expect(herdrCoreMachineCandidates(probe)).toEqual([
      { target: "altan@minibuch", label: "minibuch", id: null, blocked: null },
      { target: "altan@vps", label: "vps", id: null, blocked: VIA_BLOCKED_REASON },
    ]);
    expect(warnings).toEqual([]);
  });

  test("neither absent nor unhealthy ever throws — a broken core never fails crew add", () => {
    const answers: readonly Partial<HostProbeResult>[] = [
      { found: false },
      { code: 1 },
      { code: 5, stdout: UNAVAILABLE },
      { code: 124 },
      { stdout: "}" },
    ];
    for (const answer of answers) {
      const { probe, warnings } = probeFor(answer);
      expect(() => herdrCoreMachineCandidates(probe)).not.toThrow();
      expect(warnings.length).toBeLessThanOrEqual(1);
    }
  });
});
