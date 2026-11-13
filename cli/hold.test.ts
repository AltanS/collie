// Two emitters, one card (M99 spec 04): the settings hook (`collie beacon hold`) and the Claude mod
// both give a permission hold. Where the pane's part owns permissions, the part's hold is the card,
// the mod gets the answer, and the hook returns at once with no decision.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ownerHold } from "../bridge/inside/owner.ts";
import { PartAsks } from "../bridge/inside/asks.ts";
import { HOST } from "../bridge/host.ts";
import { AskBook } from "../bridge/surface/ask.ts";
import { HoldBook, HoldServer, takeHold, type HoldTarget } from "../bridge/surface/hold.ts";
import { parseAnsi } from "../web/src/lib/ansi.ts";
import { splitLines } from "../web/src/lib/blocks.ts";
import { liftDialog, readerBlocks } from "../web/src/lib/surface/lift.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";
import { readPidStartTime } from "./beacon.ts";
import { context } from "./fakes.ts";
import { cmdBeaconHold, netConnect } from "./hold.ts";
import { EXIT } from "./io.ts";
import { realFiles } from "./sys.ts";

const PANE = "%1";
const GEN = "claude:session-1";
const BASH = readFileSync(join(import.meta.dir, "..", "web", "src", "fixtures", "panes", "claude--permission-bash.txt"), "utf8");
const INPUT = { command: "mkfifo fixture-fifo", description: "Make a fifo" };
const ENV = { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/run/herdr.sock" };
const POSIX_ONLY = HOST.platform !== "linux";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-two-emitters-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** One session: its hold book, its screen asks, the part's asks, and the hook's target under the owner rule. */
function session() {
  const holds = new HoldBook({ now: () => 2_000_000, salt: "hold-salt", log: () => undefined, schedule: () => () => undefined });
  const book = new AskBook(() => 2_000_000, "salt");
  book.attachHolds(holds);
  const deps = { book: holds, generation: () => GEN, profile: (harness: string) => loadProfiles().get(harness)?.hold, reread: () => undefined };
  const answers: string[] = [];
  const partAsks = new PartAsks({
    sessionOf: () => ({ harnessOf: () => "claude", holdProfile: (harness) => loadProfiles().get(harness)?.hold, takeHold: (paneId, request, conn, onClose) => takeHold(deps, paneId, request, conn, onClose), settle: (held, outcome) => (outcome === "void" ? holds.end(held, "void") : holds.settle(held, outcome)) }),
    enqueue: (_address, command) => {
      answers.push(`${command.ask}=${command.decision}`);
      return { ok: true };
    },
  });
  const part = { partId: "p".repeat(22), address: { session: "main", paneId: PANE }, capabilities: new Set(["send", "wake"] as const), asks: new Set(["permission"] as const), boundAt: 0, pid: process.pid, pidStartTime: 7 };
  const hookHold = ownerHold((paneId, request) => partAsks.ownsDialog("main", paneId, request), (paneId, request, conn, onClose) => {
    takeHold(deps, paneId, request, conn, onClose);
  }, () => undefined);
  const poll = () => book.publish(PANE, GEN, liftDialog(readerBlocks(splitLines(parseAnsi(BASH)), "claude")));
  return { holds, book, asks: partAsks, part, hookHold, poll, answers };
}

/**
 * A person's tap, past the answer route: the answerer marks the hold answering, then the book decides
 * (bridge/surface/ask.ts). The full route, with its hash check and receipt, is in holds.test.ts.
 */
function tap(holds: HoldBook, decision: "allow" | "deny"): boolean {
  const held = holds.holdsOn(PANE).find((one) => one.state === "held");
  if (held === undefined) return false;
  held.state = "answering";
  return holds.decide(held, decision);
}

/** A hold server for the session, on a real socket, placing every request on {@link PANE}. */
async function serve(hold: HoldTarget["hold"]): Promise<{ path: string; stop: () => void }> {
  const path = join(dir, "state", "hold", "sock");
  const target: HoldTarget = {
    session: "main",
    matcher: { namespace: "herdr", notesWithoutHooks: { agentDetection: "", agentSessionRef: "" }, scope: () => Promise.resolve("/run/herdr.sock"), matches: (pane, marker) => marker.pane === "w1:p1" && pane.paneId === PANE },
    paneIds: () => [PANE],
    deliver: () => undefined,
    hold,
  };
  const startTime = readPidStartTime({ files: realFiles, pidProbe: { platform: "linux" } }, process.pid);
  const server = new HoldServer({ socketPath: path, liveness: { startTimeOf: () => Promise.resolve(startTime) }, targets: () => [target], log: () => undefined });
  if (!(await server.start())) throw new Error("the hold socket did not start");
  return { path, stop: () => server.stop() };
}

/** Run the settings hook once, as Claude Code runs it, against the socket. */
async function runHook(path: string): Promise<{ code: number; printed: string[]; ms: number }> {
  const printed: string[] = [];
  const started = Date.now();
  const code = await cmdBeaconHold({
    ctx: context(ENV),
    files: realFiles,
    readStdin: () => Promise.resolve(JSON.stringify({ session_id: "s-1", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: INPUT })),
    agentPid: process.pid,
    pidProbe: { platform: "linux" },
    // The test runs on Linux only (POSIX_ONLY), where the uid is there.
    uid: process.getuid?.() ?? 0,
    sockets: () => [path],
    connect: netConnect,
    print: (text) => {
      printed.push(text);
      return Promise.resolve();
    },
  });
  return { code, printed, ms: Date.now() - started };
}

describe("two emitters, one card", () => {
  test.skipIf(POSIX_ONLY)("with no owning part the hook's hold is the card, as before", async () => {
    const s = session();
    const server = await serve(s.hookHold);
    const run = runHook(server.path);
    // Wait until the hook's request is held, then tap Yes through the book.
    for (let i = 0; i < 100 && s.holds.holdsOn(PANE).length === 0; i++) await Bun.sleep(10);
    const ask = s.poll();
    expect(ask?.channel).toBe("hook");
    expect(tap(s.holds, "allow")).toBe(true);
    const done = await run;
    expect(done.code).toBe(EXIT.OK);
    expect(done.printed.join("")).toContain('"allow"');
    server.stop();
  });

  test.skipIf(POSIX_ONLY)("the part owns permissions: one card from the part, the hook returns at once with no decision", async () => {
    const s = session();
    // The mod's ask arrives first (its tool.call hook runs before the settings hook fires).
    expect(s.asks.ask(s.part, { id: "perm-1", kind: "permission", tool: "Bash", input: INPUT })).toMatchObject({ wait: true });
    const server = await serve(s.hookHold);
    const done = await runHook(server.path);
    expect(done.code).toBe(EXIT.OK);
    expect(done.printed).toEqual([]);
    expect(done.ms).toBeLessThan(2000);
    // One card: the part's hold, one hook-channel ask on the phone.
    const ask = s.poll();
    expect(ask?.channel).toBe("hook");
    expect(s.holds.holdsOn(PANE)).toHaveLength(1);
    // The person's tap goes to the mod, not to the hook.
    expect(tap(s.holds, "allow")).toBe(true);
    expect(s.answers).toEqual(["perm-1=allow"]);
    server.stop();
  });

  test.skipIf(POSIX_ONLY)("the hook comes first: its card stays until the part's hold opens, then the hook returns with no decision and the part's hold is the one card", async () => {
    const s = session();
    const server = await serve(s.hookHold);
    const run = runHook(server.path);
    for (let i = 0; i < 100 && s.holds.holdsOn(PANE).length === 0; i++) await Bun.sleep(10);
    expect(s.poll()?.channel).toBe("hook");
    s.asks.ask(s.part, { id: "perm-1", kind: "permission", tool: "Bash", input: INPUT });
    const done = await run;
    expect(done.printed).toEqual([]);
    expect(done.ms).toBeLessThan(2000);
    expect(s.holds.holdsOn(PANE).filter((held) => held.state === "held")).toHaveLength(1);
    expect(s.poll()?.channel).toBe("hook");
    expect(tap(s.holds, "allow")).toBe(true);
    expect(s.answers).toEqual(["perm-1=allow"]);
    server.stop();
  });
});
