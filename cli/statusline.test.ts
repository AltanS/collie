import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseUsageRecord, usageFileName } from "../bridge/usage.ts";
import type { JsonObject } from "../bridge/json.ts";
import type { Environment } from "./context.ts";
import { context, fakeFiles, STATE } from "./fakes.ts";
import { EXIT } from "./io.ts";
import {
  cmdBeaconStatusline,
  decodeOriginal,
  isWrapped,
  originalOf,
  STATUSLINE_MARKER,
  statusLineBehind,
  statusLineState,
  type StatusLineDeps,
  unwrapStatusLine,
  usageFromStatusLine,
  wrapCommand,
  wrapStatusLine,
} from "./statusline.ts";

const BIN = "/home/pat/.local/bin/collie";
const OWN = "bash /home/pat/.claude/statusline-command.sh";
const SESSION = "ff2dd3c2-e3d5-40db-9474-eea02e606c6c";
const NOW = 1_800_000_000_000;
const TMUX: Environment = { TMUX_PANE: "%7", TMUX: "/tmp/tmux-1000/default,3311,0" };

/** The document Claude Code 2.1.309 hands a statusLine, cut to the fields the wrapper reads and a few it does not. */
function payload(over: JsonObject = {}): JsonObject {
  return {
    session_id: SESSION,
    model: { id: "claude-opus-5-5", display_name: "Opus" },
    context_window: { used_percentage: 42, remaining_percentage: 58, context_window_size: 200000 },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1_800_003_600 },
      seven_day: { used_percentage: 41.2, resets_at: 1_800_500_000 },
    },
    ...over,
  };
}

describe("the wrapped command", () => {
  test("carries the operator's command, decodes back exactly, and needs no shell quoting", () => {
    const weird = `printf '%s' "$(git branch --show-current)" | sed 's/ /_/g' # ünïcode`;
    const wrapped = wrapCommand(BIN, weird);
    expect(wrapped.startsWith(`${BIN} beacon statusline `)).toBe(true);
    expect(wrapped.endsWith(STATUSLINE_MARKER)).toBe(true);
    expect(wrapped.slice(BIN.length)).toMatch(/^ beacon statusline [A-Za-z0-9_-]+ # collie-statusline v1$/);
    expect(isWrapped(wrapped)).toBe(true);
    expect(originalOf(wrapped)).toBe(weird);
    expect(originalOf(OWN)).toBeNull();
  });

  test("a token that is not base64url of text decodes to nothing", () => {
    expect(decodeOriginal("not base64!")).toBeNull();
    expect(decodeOriginal("")).toBeNull();
    expect(decodeOriginal("_w")).toBeNull();
  });
});

describe("the settings document", () => {
  const withLine = (line: JsonObject): JsonObject => ({ theme: "dark", statusLine: line, hooks: {} });

  test("wraps the operator's command and keeps every other key of the statusLine where it was", () => {
    const doc = withLine({ type: "command", command: OWN, padding: 1, refreshInterval: 5 });
    const wrapped = wrapStatusLine(doc, BIN, true);
    expect(wrapped).toEqual(withLine({ type: "command", command: wrapCommand(BIN, OWN), padding: 1, refreshInterval: 5 }));
    expect(Object.keys(wrapped)).toEqual(["theme", "statusLine", "hooks"]);
    // Uninstall puts back exactly what was there.
    expect(unwrapStatusLine(wrapped)).toEqual(doc);
  });

  test("never adds a statusLine, and leaves one that is not a command alone", () => {
    const none: JsonObject = { theme: "dark" };
    expect(wrapStatusLine(none, BIN, true)).toBe(none);
    const other = withLine({ type: "something-new", url: "x" });
    expect(wrapStatusLine(other, BIN, true)).toBe(other);
    const empty = withLine({ type: "command", command: "  " });
    expect(wrapStatusLine(empty, BIN, true)).toBe(empty);
    expect(statusLineState(none).kind).toBe("absent");
    expect(statusLineState(other).kind).toBe("other");
  });

  test("wrapping twice wraps once, and a wrapper from another binary heals around the same command", () => {
    const once = wrapStatusLine(withLine({ type: "command", command: OWN }), BIN, true);
    expect(wrapStatusLine(once, BIN, true)).toEqual(once);
    expect(statusLineBehind(once, BIN)).toBe(false);
    const moved = "/opt/collie/current/bin/collie";
    expect(statusLineBehind(once, moved)).toBe(true);
    expect(wrapStatusLine(once, moved, true)).toEqual(withLine({ type: "command", command: wrapCommand(moved, OWN) }));
    expect(statusLineBehind({}, BIN)).toBe(false);
  });

  test("a plain statusLine is wrapped only when asked, and is never behind (.adr/0115, amended 2026-10-24)", () => {
    const plain = withLine({ type: "command", command: OWN, padding: 1 });
    expect(wrapStatusLine(plain, BIN, false)).toBe(plain);
    expect(wrapStatusLine(plain, BIN, true)).toEqual(withLine({ type: "command", command: wrapCommand(BIN, OWN), padding: 1 }));
    expect(statusLineBehind(plain, BIN)).toBe(false);
    expect(statusLineBehind({}, BIN)).toBe(false);
    expect(statusLineBehind(withLine({ type: "something-new" }), BIN)).toBe(false);
  });

  test("a wrapped statusLine is re-pointed at a new binary without the flag, and is behind until then", () => {
    const old = "/opt/collie-old/bin/collie";
    const wrapped = withLine({ type: "command", command: wrapCommand(old, OWN), padding: 0 });
    expect(statusLineBehind(wrapped, BIN)).toBe(true);
    expect(statusLineBehind(wrapped, old)).toBe(false);
    const healed = wrapStatusLine(wrapped, BIN, false);
    expect(healed).toEqual(withLine({ type: "command", command: wrapCommand(BIN, OWN), padding: 0 }));
    expect(statusLineBehind(healed, BIN)).toBe(false);
  });

  test("leaves a statusLine alone that Claude Code runs another way than `/bin/sh -c`", () => {
    for (const line of [
      { type: "command", command: "node", args: ["status.js"] },
      { type: "command", command: OWN, shell: "powershell" },
    ]) {
      const doc = withLine(line);
      expect(statusLineState(doc).kind).toBe("other");
      expect(wrapStatusLine(doc, BIN, true)).toBe(doc);
      expect(statusLineBehind(doc, BIN)).toBe(false);
    }
  });

  test("unwrap leaves an operator's own command alone", () => {
    const doc = withLine({ type: "command", command: OWN });
    expect(unwrapStatusLine(doc)).toBe(doc);
  });
});

describe("usageFromStatusLine", () => {
  test("takes the context and both windows, with seconds turned to milliseconds", () => {
    expect(usageFromStatusLine(payload(), NOW)).toEqual({
      session: SESSION,
      record: {
        schemaVersion: 1,
        harness: "claude",
        at: NOW,
        context: 42,
        limits: [
          { window: "5h", used: 23.5, resetsAt: 1_800_003_600_000 },
          { window: "7d", used: 41.2, resetsAt: 1_800_500_000_000 },
        ],
      },
    });
  });

  test("an API-key session has no windows; a null early percentage is no number", () => {
    const api = usageFromStatusLine(payload({ rate_limits: null }), NOW);
    expect(api?.record.limits).toBeUndefined();
    expect(api?.record.context).toBe(42);
    const early = usageFromStatusLine(payload({ context_window: { used_percentage: null }, rate_limits: null }), NOW);
    expect(early).toBeNull();
  });

  test("takes the session's cost in dollars, and nothing when it is missing or not a number", () => {
    const withCost = usageFromStatusLine(payload({ cost: { total_cost_usd: 0.1137 } }), NOW);
    expect(withCost?.record.cost).toBe(0.1137);
    expect(usageFromStatusLine(payload(), NOW)?.record.cost).toBeUndefined();
    expect(usageFromStatusLine(payload({ cost: {} }), NOW)?.record.cost).toBeUndefined();
    for (const bad of ["0.5", null, true, -1]) {
      expect(usageFromStatusLine(payload({ cost: { total_cost_usd: bad } }), NOW)?.record.cost).toBeUndefined();
    }
  });

  test("a cost alone is a reading, and survives the file round trip", () => {
    const alone = usageFromStatusLine(
      payload({ context_window: { used_percentage: null }, rate_limits: null, cost: { total_cost_usd: 2 } }),
      NOW,
    );
    expect(alone?.record).toEqual({ schemaVersion: 1, harness: "claude", at: NOW, cost: 2 });
    expect(parseUsageRecord(JSON.stringify(alone?.record))).toEqual(alone!.record);
  });

  test("no session id, or a strange one, is no reading", () => {
    expect(usageFromStatusLine(payload({ session_id: null }), NOW)).toBeNull();
    expect(usageFromStatusLine(payload({ session_id: "../../x" }), NOW)).toBeNull();
  });

  test("what it writes is what the bridge reads", () => {
    const usage = usageFromStatusLine(payload(), NOW);
    expect(parseUsageRecord(JSON.stringify(usage?.record))).toEqual(usage!.record);
  });
});

describe("collie beacon statusline", () => {
  function deps(over: { env?: Environment; stdin?: string; exit?: number; runFails?: boolean } = {}) {
    const files = fakeFiles({});
    const runs: { command: string; input: string }[] = [];
    const d: StatusLineDeps = {
      ctx: context(over.env ?? TMUX),
      files,
      uid: 1000,
      now: () => NOW,
      readStdin: () => Promise.resolve(over.stdin ?? JSON.stringify(payload())),
      run: (command, input) => {
        runs.push({ command, input });
        return over.runFails === true ? Promise.reject(new Error("no sh")) : Promise.resolve(over.exit ?? 0);
      },
    };
    return { d, files, runs };
  }
  const token = Buffer.from(OWN, "utf8").toString("base64url");
  const usagePath = `${STATE}/usage/${usageFileName(SESSION)}`;

  test("writes the reading, then runs the operator's command with the same bytes and returns its exit code", async () => {
    const stdin = JSON.stringify(payload());
    const { d, files, runs } = deps({ stdin, exit: 3 });
    expect(await cmdBeaconStatusline(d, [token])).toBe(3);
    expect(runs).toEqual([{ command: OWN, input: stdin }]);
    const written = files.entries.get(usagePath);
    expect(written?.mode).toBe(0o600);
    expect(parseUsageRecord(written?.text ?? "")?.context).toBe(42);
  });

  test("merges into a file the beacon wrote: the window it noted and the context stay unless this reading has its own", async () => {
    const { d, files } = deps({ stdin: JSON.stringify(payload({ context_window: { used_percentage: null } })) });
    files.write(usagePath, JSON.stringify({ schemaVersion: 1, harness: "claude", at: NOW - 1, context: 17, window: 1_000_000 }));
    await cmdBeaconStatusline(d, [token]);
    const merged = parseUsageRecord(files.entries.get(usagePath)?.text ?? "");
    expect(merged).toMatchObject({ context: 17, window: 1_000_000, at: NOW });
    expect(merged?.limits).toHaveLength(2);
    await cmdBeaconStatusline({ ...d, readStdin: () => Promise.resolve(JSON.stringify(payload())) }, [token]);
    expect(parseUsageRecord(files.entries.get(usagePath)?.text ?? "")).toMatchObject({ context: 42, window: 1_000_000 });
  });

  test("outside a multiplexer it writes nothing and still runs the command", async () => {
    const { d, files, runs } = deps({ env: {} });
    expect(await cmdBeaconStatusline(d, [token])).toBe(EXIT.OK);
    expect(runs.length).toBe(1);
    expect(files.entries.has(usagePath)).toBe(false);
  });

  test("a document that is not JSON costs the reading, never the statusLine", async () => {
    const { d, files, runs } = deps({ stdin: "{not json" });
    expect(await cmdBeaconStatusline(d, [token])).toBe(EXIT.OK);
    expect(runs).toEqual([{ command: OWN, input: "{not json" }]);
    expect(files.entries.has(usagePath)).toBe(false);
  });

  test("with no command to run it prints nothing and exits 0; a command that cannot start fails", async () => {
    const none = deps();
    expect(await cmdBeaconStatusline(none.d, [])).toBe(EXIT.OK);
    expect(await cmdBeaconStatusline(none.d, ["!!"])).toBe(EXIT.OK);
    expect(none.runs).toEqual([]);
    const broken = deps({ runFails: true });
    expect(await cmdBeaconStatusline(broken.d, [token])).toBe(EXIT.FAIL);
  });
});

// ── Stopping a run, with real processes ──────────────────────────────────────────────────────────
//
// The reviewer's case: a compound command whose first part outlives the shell's signal. Before, the
// wrapper passed SIGTERM to `/bin/sh` alone, and `sleep` lived on, orphaned, until it finished. Now
// the signal reaches the whole group, whether the wrapper leads one (as Claude Code starts it) or not.

/** The pids running exactly `sleep <seconds>`: /proc's command line, its arguments NUL-separated. */
function sleepers(seconds: string): number[] {
  const want = `sleep\0${seconds}\0`;
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, "utf8") === want) pids.push(Number(entry));
    } catch {
      // Gone between the list and the read.
    }
  }
  return pids;
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

const RUNNER = join(import.meta.dir, "statusline.ts");

describe.skipIf(process.platform !== "linux")("runShell stops the whole command", () => {
  for (const leads of [true, false]) {
    test(`a SIGTERM to the wrapper stops a compound command's grandchild (${leads ? "leads its group" : "in its parent's group"})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "collie-statusline-"));
      // A unique sleep length, so the probe finds this run's `sleep` and no other.
      const marker = `13.${process.pid}${leads ? 1 : 2}`;
      try {
        const late = join(dir, "late");
        const command = `sleep ${marker}; echo late > ${late}`;
        const script = `import { runShell } from ${JSON.stringify(RUNNER)}; process.exitCode = await runShell(${JSON.stringify(command)}, "{}");`;
        const wrapper = spawn(process.execPath, ["-e", script], { detached: leads, stdio: "ignore" });
        expect(await until(() => sleepers(marker).length > 0, 5000)).toBe(true);
        wrapper.kill("SIGTERM");
        expect(await until(() => sleepers(marker).length === 0, 3000)).toBe(true);
        await new Promise((resolve) => (wrapper.exitCode === null && wrapper.signalCode === null ? wrapper.on("exit", resolve) : resolve(null)));
        // The shell died with the sleep, so the part after it never ran.
        await Bun.sleep(100);
        expect(existsSync(late)).toBe(false);
      } finally {
        for (const pid of sleepers(marker)) process.kill(pid, "SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("passes the command's output and exit code through", async () => {
    const script = `import { runShell } from ${JSON.stringify(RUNNER)}; process.exitCode = await runShell("cat; exit 7", "in");`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe" });
    expect(await child.exited).toBe(7);
    expect(await new Response(child.stdout).text()).toBe("in");
  });
});
