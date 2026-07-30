import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FirstmateProvider,
  normalizeBearings,
  ProcessFirstmateRunner,
  resolveEndpoints,
  type FirstmateRunner,
} from "./firstmate.ts";
import type { SessionRegistry } from "./sessions.ts";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  delete process.env.COLLIE_LEAK_SENTINEL;
});

function bearings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "fm-bearings.v1",
    home: "workspace/firstmate",
    generated: "2026-07-30T10:00:00Z",
    in_flight: [{ id: "TRA-1", kind: "task", state: "working", doing: "Implement bridge" }],
    decisions_open: [{ id: "TRA-2", key: "x", verb: "hold", summary: "Choose path", owner: "(main)" }],
    gates: [{ id: "TRA-3", title: "Waiting", blocked_by: "TRA-2", reason: "decision", owner: "(main)" }],
    landed: [{ id: "TRA-4", what: "Delivered", artifact: "/secret/report", owner: "(main)" }],
    endpoints: [{ id: "TRA-1", backend: "herdr", target: "default:pane:1", exists: true, agent: "alive" }],
    prs: "checked (1 repo, 1 open)",
    candidate_prs: [{ num: "42", repo: "owner/repo", task: "TRA-1", url: "https://github.com/owner/repo/pull/42", review: "APPROVED", mergeable: "MERGEABLE", checks: "passing" }],
    paths: [{ id: "TRA-1", worktree: "/LEAK_SENTINEL/worktree" }],
    actions: [{ id: "TRA-1", steer: "run /LEAK_SENTINEL/action" }],
    credentials: [{ token: "LEAK_SENTINEL_CREDENTIAL" }],
    ...overrides,
  };
}

class QueueRunner implements FirstmateRunner {
  calls: boolean[] = [];
  constructor(private readonly values: Array<unknown | Promise<unknown>>) {}
  run(includePrs: boolean): Promise<unknown> {
    this.calls.push(includePrs);
    const value = this.values.shift();
    return value instanceof Promise ? value : Promise.resolve(value);
  }
}

function provider(runner: FirstmateRunner, includePrs = false): FirstmateProvider {
  return new FirstmateProvider({
    home: "/trusted/firstmate",
    refreshMs: 30_000,
    includePrs,
    prRefreshMs: 120_000,
    runner,
  });
}

function executable(script: string): string {
  const home = mkdtempSync(join(tmpdir(), "collie-firstmate-runner-"));
  tempDirs.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin);
  const path = join(bin, "fm-bearings-snapshot.sh");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o700);
  return home;
}

describe("ProcessFirstmateRunner", () => {
  test("uses fixed argv, a minimal environment, and separate PR invocation", async () => {
    process.env.COLLIE_LEAK_SENTINEL = "must-not-pass";
    const home = executable(
      `printf '{"args":"%s","leak":"%s","timeout":"%s","repos":"%s","limit":"%s"}' "$*" "\${COLLIE_LEAK_SENTINEL-unset}" "$FM_BEARINGS_PR_TIMEOUT" "$FM_BEARINGS_PR_REPOS" "$FM_BEARINGS_PR_LIMIT"`,
    );
    const runner = new ProcessFirstmateRunner(home);
    const limits = { leak: "unset", timeout: "5", repos: "3", limit: "20" };
    await expect(runner.run(false)).resolves.toEqual({ args: "--json --fields endpoints", ...limits });
    await expect(runner.run(true)).resolves.toEqual({
      args: "--json --fields endpoints --include-prs",
      ...limits,
    });
  });

  test("bounds stdout and hard-times out the process group", async () => {
    const noisy = new ProcessFirstmateRunner(executable("printf 123456789"), { outputLimitBytes: 4 });
    await expect(noisy.run(false)).rejects.toThrow("output-limit");

    const slow = new ProcessFirstmateRunner(executable("sleep 5"), { timeoutMs: 20 });
    await expect(slow.run(false)).rejects.toThrow("timeout");
  });

  test("rejects a missing or non-executable fixed script", async () => {
    const home = mkdtempSync(join(tmpdir(), "collie-firstmate-missing-"));
    tempDirs.push(home);
    await expect(new ProcessFirstmateRunner(home).run(false)).rejects.toThrow("not-executable");
  });
});

describe("bearings normalization", () => {
  test("strictly allowlists bounded semantic fields and drops leak sentinels", () => {
    const normalized = normalizeBearings(bearings(), false);
    expect(normalized).not.toBeNull();
    expect(normalized!.landed).toEqual([{ id: "TRA-4", what: "Delivered", owner: "(main)" }]);
    expect(normalized!.prs).toEqual([]);
    expect(JSON.stringify(normalized)).not.toContain("LEAK_SENTINEL");
    expect(JSON.stringify(normalized)).not.toContain("artifact");
  });

  test("redacts absolute paths from every allowlisted display field", () => {
    const normalized = normalizeBearings(bearings({
      in_flight: [{ id: "TRA-1", kind: "task", state: "working", doing: "Inspect </Users/alice/.ssh/config> then https://docs.example/path and docs/setup.md" }],
      decisions_open: [{ id: "TRA-2", summary: "Choose,/private/tmp/decision then inspect./Users/alice/dot", owner: "(main)" }],
      gates: [{ id: "TRA-3", title: "Waiting,\\\\server\\share and-C:\\Users\\alice\\gate", blocked_by: "TRA-2", reason: "write >/private/tmp/result, read \"/Users/Alice Smith/secret\", and,~/secret", owner: "(main)" }],
      landed: [{ id: "TRA-4", what: "artifact_/home/alice/output", owner: "(main)" }],
      prs: "checked /var/tmp/result",
      candidate_prs: [{ num: "42", repo: "owner/repo", task: "TRA-1", url: "https://github.com/owner/repo/pull/42", review: "run&&/opt/review", mergeable: "MERGEABLE", checks: "passing" }],
    }), true);
    expect(normalized!.inFlight[0]!.doing).toBe("Inspect <[path]");
    expect(normalized!.gates[0]!.reason).toBe("write >[path]");

    const output = JSON.stringify(normalized);
    expect(output).toContain("[path]");
    for (const leaked of ["/Users/alice", "/private/tmp", "\\\\server\\share", "C:\\Users\\alice", "/Users/Alice Smith", "Smith/secret", "~/secret", "/home/alice", "/var/tmp", "/opt/review"]) {
      expect(output).not.toContain(leaked);
    }

    const unquotedSpaces = normalizeBearings(bearings({
      in_flight: [{ id: "TRA-1", kind: "task", state: "working", doing: "Inspect /Users/alice/Secret Project/O'Brien/client-list.csv" }],
      gates: [
        { id: "TRA-3", title: "Gate", blocked_by: "TRA-2", reason: "Read C:\\Program Files\\Acme\\secret.txt", owner: "(main)" },
        { id: "TRA-4", title: "Gate", blocked_by: "TRA-2", reason: "Read /Users/alice/reports/Q1,final/client.csv", owner: "(main)" },
      ],
    }), false);
    expect(unquotedSpaces!.inFlight[0]!.doing).toBe("Inspect [path]");
    expect(unquotedSpaces!.gates[0]!.reason).toBe("Read [path]");
    expect(unquotedSpaces!.gates[1]!.reason).toBe("Read [path]");

    const safeReferences = normalizeBearings(bearings({
      in_flight: [{ id: "TRA-1", kind: "task", state: "working", doing: "See https://docs.example/path and docs/setup.md, ./scripts/test.sh, ../src/x" }],
    }), false);
    expect(safeReferences!.inFlight[0]!.doing).toBe(
      "See https://docs.example/path and docs/setup.md, ./scripts/test.sh, ../src/x",
    );
  });

  test("bounds malformed quoted path input before redaction", () => {
    const malicious = `"/${"\\".repeat(10_000)}`;
    const normalized = normalizeBearings(bearings({
      in_flight: [{ id: "TRA-1", kind: "task", state: "working", doing: malicious }],
    }), false);
    expect(normalized!.inFlight[0]!.doing).toBe("\"[path]");
  });

  test("rejects the wrong schema or malformed required rows and caps row counts", () => {
    expect(normalizeBearings(bearings({ schema: "fm-bearings.v2" }), false)).toBeNull();
    expect(normalizeBearings(bearings({ home: "/LEAK_SENTINEL/home" }), false)).toBeNull();
    expect(normalizeBearings(bearings({ gates: [{ id: "missing-fields" }] }), false)).toBeNull();
    const many = Array.from({ length: 80 }, (_, index) => ({
      id: `T-${index}`,
      kind: "task",
      state: "working",
      doing: "work",
    }));
    expect(normalizeBearings(bearings({ in_flight: many }), false)!.inFlight).toHaveLength(50);
  });

  test("accepts a valid empty semantic snapshot", () => {
    const normalized = normalizeBearings(bearings({
      in_flight: [],
      decisions_open: [],
      gates: [],
      landed: [],
      endpoints: [],
    }), false);
    expect(normalized).toMatchObject({
      inFlight: [],
      decisions: [],
      gates: [],
      landed: [],
      prs: [],
    });
  });

  test("normalizes only verified GitHub PR URLs and the closed checks enum", () => {
    expect(normalizeBearings(bearings(), true)!.prs).toEqual([{
      number: "42",
      repo: "owner/repo",
      task: "TRA-1",
      url: "https://github.com/owner/repo/pull/42",
      review: "APPROVED",
      mergeable: "MERGEABLE",
      checks: "passing",
    }]);
    expect(normalizeBearings(bearings(), true)!.prSummary).toBe("checked (1 repo, 1 open)");
    expect(normalizeBearings(bearings({ prs: 42 }), true)).toBeNull();
    expect(normalizeBearings(bearings({ prs: 42 }), false)).not.toBeNull();
    const unknown = bearings({
      candidate_prs: [{ num: "7", repo: "o/r", task: "T", url: "https://github.com/o/r/pull/7", review: "none", mergeable: "UNKNOWN", checks: "surprise" }],
    });
    expect(normalizeBearings(unknown, true)!.prs[0]!.checks).toBe("unknown");
    const hostile = bearings({
      candidate_prs: [{ num: "7", repo: "o/r", task: "T", url: "https://github.com/attacker/repo/pull/7", review: "none", mergeable: "UNKNOWN", checks: "none" }],
    });
    expect(normalizeBearings(hostile, true)).toBeNull();
  });
});

describe("FirstmateProvider", () => {
  test("is single-flight, transitions loading to ready, then stale, then recovers", async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { release = resolve; });
    const runner = new QueueRunner([pending, { bad: true }, bearings()]);
    const subject = provider(runner);
    expect(subject.status()).toEqual({ state: "loading" });
    const first = subject.refreshBase();
    const duplicate = subject.refreshBase();
    expect(first).toBe(duplicate);
    expect(runner.calls).toEqual([false]);
    release(bearings());
    await first;
    expect(subject.status()).toMatchObject({ state: "ready", prState: "disabled" });
    expect(subject.status()).not.toHaveProperty("home");
    await subject.refreshBase();
    expect(subject.status().state).toBe("stale");
    await subject.refreshBase();
    expect(subject.status().state).toBe("ready");
  });

  test("reports a bounded cold failure and retains base plus last-good PRs on PR failure", async () => {
    const cold = provider(new QueueRunner([{ bad: true }]));
    await cold.refreshBase();
    expect(cold.status()).toEqual({ state: "unavailable", reason: "invalid-output" });

    const runner = new QueueRunner([bearings(), bearings(), { bad: true }, bearings({ prs: "checked (1 repo, 0 open)", candidate_prs: [] })]);
    const subject = provider(runner, true);
    await subject.refreshBase();
    expect(subject.status()).toMatchObject({ state: "ready", prState: "loading", prs: [] });
    await subject.refreshPrs();
    expect(subject.status()).toMatchObject({
      state: "ready",
      prState: "ready",
      prSummary: "checked (1 repo, 1 open)",
      prs: [{ number: "42" }],
    });
    await subject.refreshPrs();
    expect(subject.status()).toMatchObject({
      state: "ready",
      prState: "stale",
      prSummary: "checked (1 repo, 1 open)",
      prs: [{ number: "42" }],
    });
    expect(runner.calls).toEqual([false, true, true]);
    await subject.refreshPrs();
    expect(subject.status()).toMatchObject({
      state: "ready",
      prState: "ready",
      prSummary: "checked (1 repo, 0 open)",
      prs: [],
    });
  });

  test("reports a cold PR failure without making the current base unavailable", async () => {
    const subject = provider(new QueueRunner([bearings(), { bad: true }]), true);
    await subject.refreshBase();
    await subject.refreshPrs();
    expect(subject.status()).toMatchObject({
      state: "ready",
      prState: "unavailable",
      prs: [],
    });
  });
});

describe("live endpoint resolution", () => {
  test("splits on the first colon and links only registry-verified Herdr panes", () => {
    const registry = {
      get(name?: string) {
        if (name !== "default") return undefined;
        return {
          name: "default",
          engine: {
            current: () => ({
              bridge: "connected",
              agents: [{ paneId: "pane:1" }],
              shellPanes: [],
            }),
          },
        };
      },
    } as unknown as SessionRegistry;
    const resolved = resolveEndpoints([
      { id: "good", backend: "herdr", target: "default:pane:1" },
      { id: "wrong-backend", backend: "omp", target: "default:pane:1" },
      { id: "dead-pane", backend: "herdr", target: "default:missing" },
      { id: "unknown-session", backend: "herdr", target: "other:pane:1" },
      { id: "malformed", backend: "herdr", target: "no-colon" },
    ], registry);
    expect([...resolved.entries()]).toEqual([["good", { session: "default", paneId: "pane:1" }]]);
  });

  test("keeps unresolved tasks visible but unlinked in provider status", async () => {
    const subject = provider(new QueueRunner([bearings()]));
    await subject.refreshBase();
    const registry = { get: () => undefined } as unknown as SessionRegistry;
    expect(subject.status(registry)).toMatchObject({
      inFlight: [{ id: "TRA-1" }],
    });
    expect((subject.status(registry) as { inFlight: Array<{ endpoint?: unknown }> }).inFlight[0]!.endpoint).toBeUndefined();
  });
});
