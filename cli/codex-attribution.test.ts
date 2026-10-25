import { describe, expect, test } from "bun:test";

import type { ProcessProbe } from "../bridge/proc-probe.ts";
import { attributeCodexHook, bindingsDir, forgetSession, isAppServerArgs, isExecArgs, type AttributionDeps } from "./codex-attribution.ts";
import { fakeFiles, STATE } from "./fakes.ts";

// Which Codex a native hook speaks for. A wrong answer puts a permission card on the wrong pane, so the
// tests are about the answers that must stay "unattributed" as much as the ones that attribute.

interface Proc {
  readonly ppid: number;
  readonly startTime: number;
  readonly comm: string;
  readonly args: readonly string[];
}

/** A process table as the probe sees it. Mutable: a test reuses a pid by replacing its row. */
function table(rows: Record<number, Proc>) {
  const probe: ProcessProbe = {
    startTimeOf: (pid) => rows[pid]?.startTime ?? null,
    identityOf: (pid) => (rows[pid] === undefined ? null : { pid, ppid: rows[pid].ppid, startTime: rows[pid].startTime, comm: rows[pid].comm }),
    argsOf: (pid) => (rows[pid] === undefined ? null : [...rows[pid].args]),
  };
  return { probe, rows };
}

const HERDR_A = { HERDR_PANE_ID: "w1:pA", HERDR_SOCKET_PATH: "/run/herdr.sock" };
const HERDR_B = { HERDR_PANE_ID: "w1:pB", HERDR_SOCKET_PATH: "/run/herdr.sock" };

const tui = (ppid: number, startTime: number): Proc => ({ ppid, startTime, comm: "codex", args: ["codex", "--yolo"] });
const shell = (ppid: number, startTime: number): Proc => ({ ppid, startTime, comm: "zsh", args: ["zsh", "-lc", "hook"] });
const hook = (ppid: number, startTime: number): Proc => ({ ppid, startTime, comm: "collie", args: ["collie", "codex-hook"] });

function deps(rows: Record<number, Proc>, env: Record<string, string>, over: Partial<AttributionDeps> = {}): AttributionDeps & { rows: Record<number, Proc> } {
  const t = table(rows);
  return { probe: t.probe, rows: t.rows, files: fakeFiles(), env, stateDir: STATE, selfPid: 9000, parentPid: 8000, ...over };
}

describe("attributeCodexHook: the host is the Codex the kernel says is above the hook", () => {
  test("a hook under a login shell under a TUI is that TUI, with the markers of its environment", () => {
    const d = deps({ 9000: hook(8000, 500), 8000: shell(100, 400), 100: tui(1, 300) }, HERDR_A);
    expect(attributeCodexHook(d)).toMatchObject({ kind: "attributed", pid: 100, pidStartTime: 300, via: "parent", markers: [{ namespace: "herdr", pane: "w1:pA" }] });
  });

  test("a shell that exec'd the hook leaves the TUI as the direct parent", () => {
    const d = deps({ 9000: hook(100, 500), 100: tui(1, 300) }, HERDR_A, { parentPid: 100 });
    expect(attributeCodexHook(d)).toMatchObject({ kind: "attributed", pid: 100 });
  });

  test("two sessions in the same folder are two TUIs: each hook is its own pane's, never the first match", () => {
    // B is older and lists first; the hook of A must still be A's.
    const rows = { 9000: hook(8000, 500), 8000: shell(100, 400), 100: tui(1, 300), 200: tui(1, 250), 9100: hook(8100, 510), 8100: shell(200, 405) };
    const a = attributeCodexHook(deps(rows, HERDR_A));
    const b = attributeCodexHook(deps(rows, HERDR_B, { selfPid: 9100, parentPid: 8100 }));
    expect(a).toMatchObject({ kind: "attributed", pid: 100, markers: [{ pane: "w1:pA" }] });
    expect(b).toMatchObject({ kind: "attributed", pid: 200, markers: [{ pane: "w1:pB" }] });
  });

  test("a subagent's hook runs under the same TUI, so it is the same pane", () => {
    const d = deps({ 9000: hook(8000, 500), 8000: shell(100, 400), 100: tui(1, 300) }, HERDR_A, { session: "agent-session" });
    expect(attributeCodexHook(d)).toMatchObject({ kind: "attributed", pid: 100, pidStartTime: 300 });
  });

  test("the shared app-server daemon is never a host: its markers are whichever pane started it", () => {
    const rows = { 9000: hook(8000, 500), 8000: shell(100, 400), 100: { ppid: 1, startTime: 300, comm: "codex", args: ["codex", "app-server", "--manage"] } } satisfies Record<number, Proc>;
    expect(isAppServerArgs(rows[100].args)).toBe(true);
    expect(attributeCodexHook(deps(rows, HERDR_A))).toEqual({ kind: "unattributed", reason: "daemon-hosted" });
  });

  test("codex exec has no pane", () => {
    const rows = { 9000: hook(100, 500), 100: { ppid: 1, startTime: 300, comm: "codex", args: ["codex", "exec", "fix it"] } } satisfies Record<number, Proc>;
    expect(isExecArgs(rows[100].args)).toBe(true);
    expect(attributeCodexHook(deps(rows, HERDR_A, { parentPid: 100 }))).toEqual({ kind: "unattributed", reason: "exec-session" });
  });

  test("a TUI with no multiplexer markers is unattributed", () => {
    const d = deps({ 9000: hook(100, 500), 100: tui(1, 300) }, {}, { parentPid: 100 });
    expect(attributeCodexHook(d)).toEqual({ kind: "unattributed", reason: "no-markers" });
  });

  test("a parent younger than its child is a reused pid", () => {
    const d = deps({ 9000: hook(100, 500), 100: tui(1, 900) }, HERDR_A, { parentPid: 100 });
    expect(attributeCodexHook(d)).toEqual({ kind: "unattributed", reason: "pid-reuse" });
  });

  test("a re-parented hook (its real parent already died) is not guessed at", () => {
    const d = deps({ 9000: hook(1, 500), 100: tui(1, 300) }, HERDR_A, { parentPid: 100 });
    expect(attributeCodexHook(d)).toEqual({ kind: "unattributed", reason: "reparented" });
  });

  test("a Codex whose argv cannot be read is not classified", () => {
    const d = deps({ 9000: hook(100, 500), 100: tui(1, 300) }, HERDR_A, { parentPid: 100 });
    const blind: ProcessProbe = { ...d.probe, argsOf: () => null };
    expect(attributeCodexHook({ ...d, probe: blind })).toEqual({ kind: "unattributed", reason: "probe-failed" });
  });
});

describe("attributeCodexHook: session identity", () => {
  const verified = () => ({ 9000: hook(100, 500), 100: tui(1, 300) });
  const SESSION = "0199a111-aaaa-7bbb-8ccc-000000000001";

  /** A hook that detached itself: its parent chain holds no Codex at all. */
  function detached(rows: Record<number, Proc>, over: Partial<AttributionDeps>): AttributionDeps {
    return { ...deps({ ...rows, 9500: hook(1, 600) }, {}, { selfPid: 9500, parentPid: 1, ...over }) };
  }

  test("a verified hook records its session, and a later detached hook of that session is attributed through it", () => {
    const first = deps(verified(), HERDR_A, { parentPid: 100, session: SESSION });
    expect(attributeCodexHook(first).kind).toBe("attributed");
    const later = detached(first.rows, { files: first.files, session: SESSION });
    expect(attributeCodexHook(later)).toMatchObject({ kind: "attributed", pid: 100, pidStartTime: 300, via: "session", markers: [{ pane: "w1:pA" }] });
  });

  test("another session does not borrow it", () => {
    const first = deps(verified(), HERDR_A, { parentPid: 100, session: SESSION });
    attributeCodexHook(first);
    expect(attributeCodexHook(detached(first.rows, { files: first.files, session: "0199a111-aaaa-7bbb-8ccc-000000000002" }))).toEqual({ kind: "unattributed", reason: "no-binding" });
  });

  test("a recorded host whose pid was reused is stale, never attributed", () => {
    const first = deps(verified(), HERDR_A, { parentPid: 100, session: SESSION });
    attributeCodexHook(first);
    first.rows[100] = tui(1, 777_000);
    expect(attributeCodexHook(detached(first.rows, { files: first.files, session: SESSION }))).toEqual({ kind: "unattributed", reason: "stale-binding" });
    first.rows[100] = { ppid: 1, startTime: 300, comm: "sleep", args: ["sleep", "9"] };
    expect(attributeCodexHook(detached(first.rows, { files: first.files, session: SESSION }))).toEqual({ kind: "unattributed", reason: "stale-binding" });
  });

  test("a chain that proves another host never falls back to the record", () => {
    const first = deps(verified(), HERDR_A, { parentPid: 100, session: SESSION });
    attributeCodexHook(first);
    const rows = { ...first.rows, 200: { ppid: 1, startTime: 310, comm: "codex", args: ["codex", "app-server"] }, 9600: hook(200, 620) } satisfies Record<number, Proc>;
    const viaDaemon = deps(rows, HERDR_A, { files: first.files, selfPid: 9600, parentPid: 200, session: SESSION });
    expect(attributeCodexHook(viaDaemon)).toEqual({ kind: "unattributed", reason: "daemon-hosted" });
  });

  test("SessionEnd forgets the record, and records of dead hosts are pruned when the next is written", () => {
    const first = deps(verified(), HERDR_A, { parentPid: 100, session: SESSION });
    attributeCodexHook(first);
    forgetSession({ files: first.files, stateDir: STATE }, SESSION);
    expect(attributeCodexHook(detached(first.rows, { files: first.files, session: SESSION }))).toEqual({ kind: "unattributed", reason: "no-binding" });

    const second = deps(verified(), HERDR_A, { parentPid: 100, session: "old-session" });
    attributeCodexHook(second);
    delete second.rows[100];
    const third = deps({ 9000: hook(300, 500), 300: tui(1, 320) }, HERDR_B, { files: second.files, parentPid: 300, session: "new-session" });
    attributeCodexHook(third);
    expect(second.files.list(bindingsDir(STATE))).toHaveLength(1);
  });

  test("a session id that is not an identifier is never recorded", () => {
    const d = deps(verified(), HERDR_A, { parentPid: 100, session: "../../etc/passwd" });
    expect(attributeCodexHook(d)).toMatchObject({ kind: "attributed", pid: 100 });
    expect(d.files.list(bindingsDir(STATE))).toEqual([]);
  });
});
