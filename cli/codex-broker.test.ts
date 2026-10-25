import { describe, expect, test } from "bun:test";

import type { HoldDecision } from "../web/src/lib/surface/hold.ts";
import { BROKER_DEADLINE_MS, brokerPermission, decisionLine, providerDecision, type BrokerDeps, type CancelOutcome, type HoldRun, type ProviderEnd, type ProviderRun } from "./codex-broker.ts";

// The broker is the one place two phones can answer the same permission. Every test is about an order
// of events or an answer that must NOT count; the real process and socket halves have their own tests.

/** A promise settled from outside, so a test chooses WHEN each voice answers. */
function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  return Promise.withResolvers<T>();
}

const ALLOW_JSON = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
const DENY_JSON = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no thanks" } } });
const ok = (stdout: string): ProviderEnd => ({ exitCode: 0, stdout });

interface ProviderProbe {
  answer(end: ProviderEnd): void;
  cancels: number[];
  cancelAs: CancelOutcome;
}

interface HoldProbe {
  answer(decision: HoldDecision | null): void;
  cancelled: number;
}

interface TimerProbe {
  ms: number[];
  cancelled: number;
}

interface DecisionBody {
  behavior: string;
  message?: string;
}

interface Rig {
  readonly deps: BrokerDeps;
  readonly provider: ProviderProbe;
  readonly hold: HoldProbe;
  /** Fires the deadline timer. */
  expire(): void;
  readonly timers: TimerProbe;
}

function rig(opts: { provider?: boolean; hold?: boolean } = {}): Rig {
  const providerSettled = gate<ProviderEnd>();
  const holdSettled = gate<HoldDecision | null>();
  const provider: ProviderProbe = { answer: providerSettled.resolve, cancels: [], cancelAs: "exited" };
  const hold: HoldProbe = { answer: holdSettled.resolve, cancelled: 0 };
  const timers: TimerProbe = { ms: [], cancelled: 0 };
  let fire: () => void = () => {};
  const run: ProviderRun = {
    settled: providerSettled.promise,
    cancel: (graceMs) => {
      provider.cancels.push(graceMs);
      return Promise.resolve(provider.cancelAs);
    },
  };
  const holdRun: HoldRun = {
    settled: holdSettled.promise,
    cancel: () => {
      hold.cancelled += 1;
    },
  };
  return {
    deps: {
      startProvider: () => (opts.provider === false ? null : run),
      startHold: () => (opts.hold === false ? null : holdRun),
      after: (ms, cb) => {
        timers.ms.push(ms);
        fire = cb;
        return () => {
          timers.cancelled += 1;
        };
      },
      denyMessage: "The person denied this from Collie.",
    },
    provider,
    hold,
    expire: () => fire(),
    timers,
  };
}

describe("brokerPermission: the first valid answer wins, once", () => {
  test("Collie answers first: it wins, the provider is asked to withdraw, and its late answer is ignored", async () => {
    const r = rig();
    const pending = brokerPermission(r.deps);
    r.hold.answer("allow");
    const result = await pending;
    expect(result).toMatchObject({ decision: "allow", winner: "collie", why: "answered", providerCancel: "exited", holdCancelled: false });
    expect(result.output).toBe(ALLOW_JSON);
    expect(r.provider.cancels).toEqual([3000]);
    r.provider.answer(ok(DENY_JSON));
    await Promise.resolve();
    expect(r.provider.cancels).toHaveLength(1);
  });

  test("the provider answers first: it wins, the hold is told another answer won, and a late tap is ignored", async () => {
    const r = rig();
    const pending = brokerPermission(r.deps);
    r.provider.answer(ok(DENY_JSON));
    const result = await pending;
    expect(result).toMatchObject({ decision: "deny", winner: "provider", providerCancel: null, holdCancelled: true });
    expect(result.output).toBe(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no thanks" } } }));
    expect(r.hold.cancelled).toBe(1);
    r.hold.answer("allow");
    await Promise.resolve();
    expect(r.hold.cancelled).toBe(1);
  });

  test("contradiction: allow first, deny a tick later: allow stands, and the deny is never printed", async () => {
    const r = rig();
    const pending = brokerPermission(r.deps);
    r.hold.answer("allow");
    r.provider.answer(ok(DENY_JSON));
    const result = await pending;
    expect(result.decision).toBe("allow");
    expect(result.output).not.toContain("deny");
  });

  test("the other order: provider deny first, a Collie allow right behind it: deny stands", async () => {
    const r = rig();
    const pending = brokerPermission(r.deps);
    r.provider.answer(ok(DENY_JSON));
    r.hold.answer("allow");
    expect((await pending).decision).toBe("deny");
  });

  test("a provider that did not end when asked is reported as killed, and the answer still stands", async () => {
    const r = rig();
    r.provider.cancelAs = "killed";
    const pending = brokerPermission(r.deps);
    r.hold.answer("deny");
    expect(await pending).toMatchObject({ decision: "deny", providerCancel: "killed" });
  });

  test("a Collie deny carries the profile's message; a provider deny with no words gets it too", async () => {
    const a = rig();
    const first = brokerPermission(a.deps);
    a.hold.answer("deny");
    expect((await first).output).toContain("The person denied this from Collie.");
    const b = rig();
    const second = brokerPermission(b.deps);
    b.provider.answer(ok(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } } })));
    expect((await second).output).toContain("The person denied this from Collie.");
  });
});

describe("brokerPermission: nothing that is not a clean answer decides", () => {
  const bad: [string, ProviderEnd][] = [
    ["a non-zero exit with a valid body", { exitCode: 1, stdout: ALLOW_JSON }],
    ["exit 2, Codex's own deny convention", { exitCode: 2, stdout: "" }],
    ["no output", ok("")],
    ["an empty object (the provider declines)", ok("{}")],
    ["prose", ok("approved")],
    ["a killed provider", { exitCode: null, stdout: "" }],
    ["another event's name", ok(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", decision: { behavior: "allow" } } }))],
    ["an unknown behavior", ok(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "always" } } }))],
    ["an input rewrite", ok(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "rm -rf /" } } } }))],
    ["a permission update", ok(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedPermissions: [] } } }))],
    ["interrupt", ok(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", interrupt: true } } }))],
    ["a top-level stop", ok(JSON.stringify({ continue: false, hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }))],
  ];

  for (const [name, end] of bad) {
    test(`${name} is no decision, and it ends the whole request: the hold is withdrawn, Codex asks the person`, async () => {
      expect(providerDecision(end)).toBeNull();
      const r = rig();
      const pending = brokerPermission(r.deps);
      r.provider.answer(end);
      expect(await pending).toMatchObject({ output: "{}", decision: null, winner: null, why: "no-answer", holdCancelled: true });
      expect(r.hold.cancelled).toBe(1);
      expect(r.provider.cancels).toHaveLength(1);
    });
  }

  test("a provider answer is rebuilt, never copied: nothing but the decision and its message leaves", async () => {
    const r = rig();
    const pending = brokerPermission(r.deps);
    r.provider.answer(ok(JSON.stringify({ systemMessage: "hi", hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } })));
    expect((await pending).output).toBe(ALLOW_JSON);
  });

  test("both voices end with no answer: `{}` and Codex asks the person", async () => {
    const r = rig();
    const pending = brokerPermission(r.deps);
    r.hold.answer(null);
    r.provider.answer(ok("{}"));
    expect(await pending).toMatchObject({ output: "{}", decision: null, winner: null, why: "no-answer" });
  });

  test("the hold ending offline while the provider still waits does not end the request", async () => {
    const r = rig();
    let settled = false;
    const pending = brokerPermission(r.deps).then((result) => {
      settled = true;
      return result;
    });
    r.hold.answer(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    r.provider.answer(ok(ALLOW_JSON));
    expect((await pending).winner).toBe("provider");
  });

  test("with no voice at all there is no decision and nothing is started", async () => {
    const r = rig({ provider: false, hold: false });
    expect(await brokerPermission(r.deps)).toMatchObject({ output: "{}", why: "no-voices" });
  });

  test("a hold with no provider: its answer wins and there is nothing to withdraw", async () => {
    const r = rig({ provider: false });
    const pending = brokerPermission(r.deps);
    r.hold.answer("allow");
    expect(await pending).toMatchObject({ decision: "allow", providerCancel: null });
  });
});

describe("brokerPermission: the deadline and the process's own end", () => {
  test("the deadline is 290 s, inside Codex's 300 s timeout, and it withdraws both voices", async () => {
    const r = rig();
    const pending = brokerPermission(r.deps);
    expect(r.timers.ms).toEqual([BROKER_DEADLINE_MS]);
    expect(BROKER_DEADLINE_MS).toBe(290_000);
    r.expire();
    expect(await pending).toMatchObject({ output: "{}", why: "deadline", providerCancel: "exited", holdCancelled: true });
  });

  test("an answer cancels the deadline, and a deadline after an answer changes nothing", async () => {
    const r = rig();
    const pending = brokerPermission(r.deps);
    r.hold.answer("allow");
    const result = await pending;
    expect(r.timers.cancelled).toBe(1);
    r.expire();
    expect(result.why).toBe("answered");
    expect(r.provider.cancels).toHaveLength(1);
  });

  test("the process being ended (an interrupted turn, a timeout) withdraws both and decides nothing", async () => {
    const r = rig();
    const stop = new AbortController();
    const pending = brokerPermission(r.deps, stop.signal);
    stop.abort();
    expect(await pending).toMatchObject({ output: "{}", why: "aborted", holdCancelled: true, providerCancel: "exited" });
    r.hold.answer("allow");
    await Promise.resolve();
    expect(r.provider.cancels).toHaveLength(1);
  });

  test("an already-aborted signal starts nothing that can answer", async () => {
    const r = rig();
    const stop = new AbortController();
    stop.abort();
    expect(await brokerPermission(r.deps, stop.signal)).toMatchObject({ output: "{}", why: "aborted" });
  });

  test("a provider whose cancel throws is reported as killed, and the decision still goes out", async () => {
    const r = rig();
    const throwing: BrokerDeps = { ...r.deps, startProvider: () => ({ settled: new Promise<ProviderEnd>(() => {}), cancel: () => Promise.reject(new Error("boom")) }) };
    const pending = brokerPermission(throwing);
    r.hold.answer("deny");
    expect(await pending).toMatchObject({ decision: "deny", providerCancel: "killed" });
  });
});

describe("decisionLine", () => {
  test("is the schema's allow and deny, and nothing the schema fails closed on", () => {
    expect(JSON.parse(decisionLine("allow", "ignored"))).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    const deny: { hookSpecificOutput: { decision: DecisionBody } } = JSON.parse(decisionLine("deny", "no"));
    expect(Object.keys(deny.hookSpecificOutput.decision).toSorted()).toEqual(["behavior", "message"]);
  });
});
