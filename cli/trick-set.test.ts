import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import type { WalkyHost, WalkyPane } from "../bridge/walky/deliver.ts";
import { WalkyLog } from "../bridge/walky/log.ts";
import { readWalkyRequest } from "../bridge/walky/parse.ts";
import { WalkyService } from "../bridge/walky/service.ts";
import { answerRequest, TRICK_SET_PERSON_ONLY, walkySocketPath, type PlaceTarget, type TrickSetSocket } from "../bridge/walky/socket.ts";
import { spaceOf } from "../bridge/walky/space.ts";
import type { ValueAnswer } from "../bridge/tricks/service.ts";
import type { WireTrickInfo } from "../web/src/lib/tricks/schema.ts";
import { capture, context } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { realFiles } from "./sys.ts";
import { TRICK_SUBCOMMANDS } from "./trick.ts";
import { cmdTrickSet, parseSetArgs, setAgentPaneRefusal, type TrickSetDeps } from "./trick-set.ts";

// `collie trick set` (contract 3): through the bridge's socket, refused in an agent's pane twice.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const RID = "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f";
const SECRET = "lodge-workshop-private-value";
const SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });
const matcher: BeaconMatcher = {
  namespace: "tmux",
  scope: async () => "/tmp/tmux-1/default",
  matches: (pane, marker, scope) => marker.scope === scope && pane.paneId === marker.pane,
  notesWithoutHooks: { agentDetection: "", agentSessionRef: "" },
};
const target: PlaceTarget = { session: "main", matcher, paneIds: () => ["%1", "%3"] };
const inPane = (pane: string) => ({ TMUX: "/tmp/tmux-1/default,123,0", TMUX_PANE: pane });
const panes: WalkyPane[] = [
  { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SPACE },
  { session: "main", paneId: "%3", agent: false, harness: null, label: "repo#shell", state: "idle", activeAt: null, instance: "cccc", terminal: true, off: false, space: SPACE },
];

interface Bridge {
  readonly calls: { id: string; rid: string; key: string; text: string | null }[];
  readonly lines: string[];
  readonly ask: TrickSetDeps["ask"];
}

function bridge(answer: (text: string | null) => ValueAnswer, withTricks = true): Bridge {
  const stateDir = mkdtempSync(join(tmpdir(), "trick-set-bridge-"));
  roots.push(stateDir);
  const host: WalkyHost = { panes: () => panes, send: async () => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
  const walky = new WalkyService({ log: new WalkyLog(join(stateDir, "walky")), host, memberId: null, enabled: () => true, machine: "lodge", keyPem: () => null });
  const calls: Bridge["calls"] = [];
  const tricks: TrickSetSocket = {
    setValueText: async (id, rid, key, text) => {
      calls.push({ id, rid, key, text });
      return answer(text);
    },
  };
  const lines: string[] = [];
  const ask: TrickSetDeps["ask"] = async (_path, line) => {
    lines.push(line);
    const read = readWalkyRequest(line.trim());
    if (!read.ok) return `${JSON.stringify({ ok: false, error: read.reason })}\n`;
    return `${JSON.stringify(await answerRequest(walky, read.request, [target], undefined, undefined, undefined, withTricks ? tricks : undefined))}\n`;
  };
  return { calls, lines, ask };
}

const ROW: WireTrickInfo = { host: "lodge", id: "legs", name: "Legs", icon: "flask", on: true, state: "ok", places: ["belt"], provenance: { via: "folder" } };
const okAnswer = (changed = true): ValueAnswer => ({ status: 200, body: { rid: RID, code: "ok", key: "repo", changed, info: ROW } });

function deps(over: Partial<TrickSetDeps> & { readonly env?: Record<string, string> } = {}): TrickSetDeps & { readonly io: ReturnType<typeof capture> } {
  const io = capture();
  const { env, ...rest } = over;
  const stateDir = mkdtempSync(join(tmpdir(), "trick-set-own-"));
  roots.push(stateDir);
  const sock = walkySocketPath(stateDir);
  return {
    ctx: context(env ?? {}, { stateDir }),
    files: { ...realFiles, entryType: (path) => (path === sock ? "other" : "directory"), mode: () => 0o700 },
    uid: undefined,
    platform: "linux",
    readStdin: async () => "",
    stdinIsTty: true,
    ask: async () => `${JSON.stringify({ ok: false, error: "not here" })}\n`,
    mintRequestId: () => RID,
    ...rest,
    io,
  };
}

describe("collie trick set", () => {
  test("is a trick sub-verb", () => {
    expect(TRICK_SUBCOMMANDS).toContain("set");
  });

  test("reads <id> <key> <value>, or --clear, and refuses the rest with usage", () => {
    expect(parseSetArgs(["legs", "repo", "lodge/workshop"])).toEqual({ id: "legs", key: "repo", text: "lodge/workshop" });
    expect(parseSetArgs(["legs", "repo", "--clear"])).toEqual({ id: "legs", key: "repo", text: null });
    expect(parseSetArgs(["legs", "repo"])).toHaveProperty("error");
    expect(parseSetArgs(["legs", "repo", "a", "b"])).toHaveProperty("error");
    expect(parseSetArgs(["Legs", "repo", "a"])).toHaveProperty("error");
    expect(parseSetArgs(["legs", "repo", "a", "--clear"])).toHaveProperty("error");
  });

  test("writes through the bridge with a request id, and never prints the value back", async () => {
    const b = bridge(() => okAnswer());
    const d = deps({ ask: b.ask, env: inPane("%3"), paneKind: async () => "shell" });
    expect(await cmdTrickSet(d, ["legs", "repo", SECRET])).toBe(EXIT.OK);
    expect(b.calls).toEqual([{ id: "legs", rid: RID, key: "repo", text: SECRET }]);
    expect(d.io.stdout).toEqual(["Saved repo of legs. A trick that is on runs once with it."]);
    expect([...d.io.stdout, ...d.io.stderr].join("\n")).not.toContain(SECRET);
    const clear = deps({ ask: b.ask });
    expect(await cmdTrickSet(clear, ["legs", "repo", "--clear"])).toBe(EXIT.OK);
    expect(b.calls.at(-1)?.text).toBeNull();
    const same = deps({ ask: bridge(() => okAnswer(false)).ask });
    expect(await cmdTrickSet(same, ["legs", "repo", "x"])).toBe(EXIT.OK);
    expect(same.io.stdout).toEqual(["repo of legs is unchanged."]);
  });

  test("refuses in an agent's pane: the CLI first, and the bridge when the CLI was not asked; nothing is written", async () => {
    const b = bridge(() => okAnswer());
    const cli = deps({ ask: b.ask, env: inPane("%1"), paneKind: async () => "agent" });
    expect(await cmdTrickSet(cli, ["legs", "repo", "x"])).toBe(EXIT.REFUSED);
    expect(cli.io.stderr).toEqual(setAgentPaneRefusal("legs"));
    expect(b.lines).toEqual([]);
    // Without the CLI's own check, the bridge refuses the agent's pane by its markers.
    const socket = deps({ ask: b.ask, env: inPane("%1") });
    expect(await cmdTrickSet(socket, ["legs", "repo", "x"])).toBe(EXIT.REFUSED);
    expect(socket.io.stderr).toEqual(setAgentPaneRefusal("legs"));
    expect(b.calls).toEqual([]);
    expect(TRICK_SET_PERSON_ONLY).toContain("agent works");
  });

  test("passes the bridge's refusal sentence on, with an exit code by kind", async () => {
    const refused = deps({ ask: bridge(() => ({ status: 400, body: { error: "value-refused", rid: RID, code: "range", message: '"Rows" is from 1 to 50. Send a number in that range.' } })).ask });
    expect(await cmdTrickSet(refused, ["legs", "rows", "99"])).toBe(EXIT.REFUSED);
    expect(refused.io.stderr).toEqual(['error: "Rows" is from 1 to 50. Send a number in that range.']);
    const member = deps({ ask: bridge(() => ({ status: 409, body: { error: "not-here", message: "Set it on the lead." } })).ask });
    expect(await cmdTrickSet(member, ["legs", "repo", "x"])).toBe(EXIT.STATE);
  });

  test("says so when no bridge answers, or the bridge is older", async () => {
    const none = deps({ ask: async () => Promise.reject(new Error("gone")) });
    expect(await cmdTrickSet(none, ["legs", "repo", "x"])).toBe(EXIT.UNREACHABLE);
    const older = deps({ ask: bridge(() => okAnswer(), false).ask });
    expect(await cmdTrickSet(older, ["legs", "repo", "x"])).toBe(EXIT.STATE);
    expect(older.io.stderr[0]).toContain("cannot set a trick's settings yet");
  });
});
