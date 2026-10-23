import { describe, expect, test } from "bun:test";

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
    const wrapped = wrapStatusLine(doc, BIN);
    expect(wrapped).toEqual(withLine({ type: "command", command: wrapCommand(BIN, OWN), padding: 1, refreshInterval: 5 }));
    expect(Object.keys(wrapped)).toEqual(["theme", "statusLine", "hooks"]);
    // Uninstall puts back exactly what was there.
    expect(unwrapStatusLine(wrapped)).toEqual(doc);
  });

  test("never adds a statusLine, and leaves one that is not a command alone", () => {
    const none: JsonObject = { theme: "dark" };
    expect(wrapStatusLine(none, BIN)).toBe(none);
    const other = withLine({ type: "something-new", url: "x" });
    expect(wrapStatusLine(other, BIN)).toBe(other);
    const empty = withLine({ type: "command", command: "  " });
    expect(wrapStatusLine(empty, BIN)).toBe(empty);
    expect(statusLineState(none).kind).toBe("absent");
    expect(statusLineState(other).kind).toBe("other");
  });

  test("wrapping twice wraps once, and a wrapper from another binary heals around the same command", () => {
    const once = wrapStatusLine(withLine({ type: "command", command: OWN }), BIN);
    expect(wrapStatusLine(once, BIN)).toEqual(once);
    expect(statusLineBehind(once, BIN)).toBe(false);
    const moved = "/opt/collie/current/bin/collie";
    expect(statusLineBehind(once, moved)).toBe(true);
    expect(wrapStatusLine(once, moved)).toEqual(withLine({ type: "command", command: wrapCommand(moved, OWN) }));
    expect(statusLineBehind(withLine({ type: "command", command: OWN }), BIN)).toBe(true);
    expect(statusLineBehind({}, BIN)).toBe(false);
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
