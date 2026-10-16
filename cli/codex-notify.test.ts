import { describe, expect, test } from "bun:test";

import { parseEdge } from "../bridge/beacon/parse.ts";
import { edgeKindOf } from "../web/src/lib/surface/edges.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";
import type { BeaconEmitDeps } from "./beacon.ts";
import { cmdCodexNotify, codexTuiFor, isAppServer, isCodexTui, runCodexNotify } from "./codex-notify.ts";
import { context, fakeFiles, STATE } from "./fakes.ts";
import { EXIT } from "./io.ts";

// `collie beacon emit codex <payload>` (M56 spec 13), against a fake /proc. The shapes are the lab's
// (Codex 0.163.0, 2026-10-16): the TUI starts an app-server daemon, and the daemon runs notify with
// the event JSON as the last argument. The daemon carries the markers of the pane that started it.

const HOME = "/lab/codex-home";
const DAEMON = ["/lab/codex-home/packages/app-server-daemon/releases/0.163.0/bin/codex", "app-server", "--listen", "unix://", "--manage"];
const SOCKET = "/run/user/1000/herdr.sock";

interface Proc {
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly start: number;
}

/** A /proc/<pid>/stat line with the start time in field 22. */
const statOf = (pid: number, start: number): string => `${String(pid)} (codex) S 1 ${Array.from({ length: 17 }, (_v, i) => i).join(" ")} ${String(start)} 0 0`;

function rig(procs: Record<number, Proc>, parent: number): BeaconEmitDeps & { files: ReturnType<typeof fakeFiles> } {
  const seed: Record<string, string> = {};
  for (const [pid, proc] of Object.entries(procs)) {
    seed[`/proc/${pid}/cmdline`] = `${proc.args.join("\u0000")}\u0000`;
    seed[`/proc/${pid}/environ`] = `${Object.entries(proc.env).map(([k, v]) => `${k}=${v}`).join("\u0000")}\u0000`;
    seed[`/proc/${pid}/stat`] = statOf(Number(pid), proc.start);
  }
  const files = fakeFiles(seed);
  for (const [pid, proc] of Object.entries(procs)) files.realPaths.set(`/proc/${pid}/cwd`, proc.cwd);
  return { ctx: context({}), files, readStdin: () => Promise.resolve(""), agentPid: parent, now: () => 1_792_000_000_000, uid: 1000 };
}

const tui = (pane: string, cwd: string, home = HOME, start = 100): Proc => ({ args: ["codex"], env: { CODEX_HOME: home, HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: SOCKET }, cwd, start });
const daemon = (pane: string): Proc => ({ args: DAEMON, env: { CODEX_HOME: HOME, HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: SOCKET }, cwd: "/work/proj", start: 120 });

function payload(cwd: string, type = "agent-turn-complete"): string {
  return JSON.stringify({ type, "thread-id": "019a-thread", "turn-id": "019a-turn", cwd, client: "codex-tui", "input-messages": ["say hi"], "last-assistant-message": "hi" });
}

function edges(files: ReturnType<typeof fakeFiles>): ReturnType<typeof parseEdge>[] {
  return [...files.entries]
    .filter(([path]) => path.startsWith(`${STATE}/edges/`) && path.endsWith(".json") && !path.includes("/."))
    .map(([, entry]) => parseEdge(entry.text));
}

describe("codex: which TUI a notify belongs to", () => {
  test("codex: knows a TUI from an app-server by its arguments", () => {
    expect(isCodexTui(["codex"])).toBe(true);
    expect(isCodexTui(["/usr/bin/codex", "--model", "x"])).toBe(true);
    expect(isCodexTui(DAEMON)).toBe(false);
    expect(isAppServer(DAEMON)).toBe(true);
    expect(isCodexTui(["codex", "exec", "hi"])).toBe(false);
    expect(isCodexTui(["node", "codex"])).toBe(false);
  });

  test("codex: a daemon's notify goes to the TUI in the payload's folder, with that TUI's own markers", () => {
    const d = rig({ 500: tui("w9:p1", "/work/proj"), 600: daemon("w9:p1"), 700: tui("w9:p2", "/work/other") }, 600);
    expect(codexTuiFor(d.files, 600, "/work/other")).toBe(700);
    expect(cmdCodexNotify(d, [payload("/work/other")])).toBe(EXIT.OK);
    const written = edges(d.files);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      harness: "codex",
      event: "agent-turn-complete",
      detail: null,
      pid: 700,
      pidStartTime: 100,
      promptHash: null,
      markers: [{ namespace: "herdr", scope: SOCKET, pane: "w9:p2" }],
    });
  });

  test("codex: two TUIs in one folder on one CODEX_HOME get no edge", () => {
    const d = rig({ 500: tui("w9:p1", "/work/proj"), 600: daemon("w9:p1"), 700: tui("w9:p2", "/work/proj") }, 600);
    expect(codexTuiFor(d.files, 600, "/work/proj")).toBeNull();
    expect(cmdCodexNotify(d, [payload("/work/proj")])).toBe(EXIT.OK);
    expect(edges(d.files)).toEqual([]);
  });

  test("codex: a TUI on another CODEX_HOME is not a match", () => {
    const d = rig({ 500: tui("w9:p1", "/work/proj"), 600: daemon("w9:p1"), 700: tui("w9:p2", "/work/proj", "/home/pat/.codex") }, 600);
    expect(codexTuiFor(d.files, 600, "/work/proj")).toBe(500);
  });

  test("codex: the default setup sets no CODEX_HOME: both sides read $HOME/.codex from their own environment (K6)", () => {
    const plain = (pid: number, pane: string, cwd: string, args: readonly string[] = ["codex"]): Proc => ({ args, env: { HOME: "/home/pat", HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: SOCKET }, cwd, start: 100 + pid });
    const d = rig({ 500: plain(500, "w9:p1", "/work/proj"), 600: plain(600, "w9:p1", "/work/proj", DAEMON), 700: plain(700, "w9:p2", "/work/other") }, 600);
    expect(codexTuiFor(d.files, 600, "/work/other")).toBe(700);
    expect(cmdCodexNotify(d, [payload("/work/other")])).toBe(EXIT.OK);
    expect(edges(d.files)[0]).toMatchObject({ pid: 700, markers: [{ pane: "w9:p2" }] });
    // Another user's default home is another Codex home.
    const other = rig({ 500: plain(500, "w9:p1", "/work/proj"), 600: { ...plain(600, "w9:p1", "/work/proj", DAEMON), env: { HOME: "/home/sam" } } }, 600);
    expect(codexTuiFor(other.files, 600, "/work/proj")).toBeNull();
  });

  test("codex: CODEX_HOME set on one side and the default on the other match as real paths (K6)", () => {
    const d = rig(
      {
        500: { args: ["codex"], env: { HOME: "/home/pat", HERDR_PANE_ID: "w9:p1", HERDR_SOCKET_PATH: SOCKET }, cwd: "/work/proj", start: 100 },
        600: { args: DAEMON, env: { CODEX_HOME: "/home/pat/.codex-link", HERDR_PANE_ID: "w9:p1", HERDR_SOCKET_PATH: SOCKET }, cwd: "/work/proj", start: 120 },
      },
      600,
    );
    d.files.realPaths.set("/home/pat/.codex-link", "/home/pat/.codex");
    d.files.realPaths.set("/home/pat/.codex", "/home/pat/.codex");
    expect(codexTuiFor(d.files, 600, "/work/proj")).toBe(500);
  });

  test("codex: an older Codex runs notify itself: the parent is the TUI", () => {
    const d = rig({ 500: tui("w9:p1", "/work/proj") }, 500);
    expect(cmdCodexNotify(d, [payload("/somewhere/else")])).toBe(EXIT.OK);
    expect(edges(d.files)[0]).toMatchObject({ pid: 500, markers: [{ pane: "w9:p1" }] });
  });

  test("codex: a TUI outside a multiplexer gets no edge", () => {
    const d = rig({ 500: { args: ["codex"], env: { CODEX_HOME: HOME }, cwd: "/work/proj", start: 100 } }, 500);
    expect(cmdCodexNotify(d, [payload("/work/proj")])).toBe(EXIT.OK);
    expect(edges(d.files)).toEqual([]);
  });
});

describe("codex: it never fails, and it never speaks", () => {
  test("codex: another event type, garbage, no payload and an unknown parent all exit 0 with no edge", () => {
    for (const args of [[payload("/work/proj", "approval-requested")], ["not json"], [], ["[1,2]"]]) {
      const d = rig({ 500: tui("w9:p1", "/work/proj"), 600: daemon("w9:p1") }, 600);
      expect(cmdCodexNotify(d, args)).toBe(EXIT.OK);
      expect(edges(d.files)).toEqual([]);
    }
    const lost = rig({}, 999);
    expect(cmdCodexNotify(lost, [payload("/work/proj")])).toBe(EXIT.OK);
    expect(edges(lost.files)).toEqual([]);
    expect(runCodexNotify(() => {
      throw new Error("no context");
    }, [payload("/work/proj")])).toBe(EXIT.OK);
  });

  test("codex: the edge it writes is a stop edge under the Codex profile", () => {
    const d = rig({ 500: tui("w9:p1", "/work/proj"), 600: daemon("w9:p1") }, 600);
    cmdCodexNotify(d, [payload("/work/proj")]);
    const edge = edges(d.files)[0]!;
    expect(edge).not.toBeNull();
    expect(edgeKindOf(loadProfiles().get("codex")!.edges!.events, edge!.event, edge!.detail)).toBe("stop");
  });
});
