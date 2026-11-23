import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import { askFilesResolver } from "../bridge/hill/ask-files.ts";
import { memoryHillReceipts } from "../bridge/hill/receipts.ts";
import { HillService } from "../bridge/hill/service.ts";
import { HillStore } from "../bridge/hill/store.ts";
import { HillSwitch, writeHillSwitch } from "../bridge/hill/switch.ts";
import { walkyPlace } from "../bridge/hill/walky.ts";
import { HOST } from "../bridge/host.ts";
import type { WalkyHost, WalkyPane } from "../bridge/walky/deliver.ts";
import { WalkyLog } from "../bridge/walky/log.ts";
import { WalkyService } from "../bridge/walky/service.ts";
import { walkySocketPath, WalkyServer, type PlaceTarget } from "../bridge/walky/socket.ts";
import { spaceOf } from "../bridge/walky/space.ts";
import { cmdAskCancel, cmdAskStatus, cmdWalkyAsk, cmdWalkyAsks } from "./ask.ts";
import { capture, context } from "./fakes.ts";
import type { HillDeps } from "./hill.ts";
import { EXIT } from "./io.ts";
import { realFiles } from "./sys.ts";
import { askSocket } from "./walky.ts";

// `collie walky ask` and its verbs against a real bridge socket (Asks, 2026-11-22): the ask.* ops, the
// service, and the linked files checked under a real Files root. Only the panes and the send are fakes.

const socketTest = test.skipIf(HOST.platform === "win32");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

const SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });
const matcher: BeaconMatcher = {
  namespace: "tmux",
  scope: async () => "/tmp/tmux-1/default",
  matches: (pane, marker, scope) => marker.scope === scope && pane.paneId === marker.pane,
  notesWithoutHooks: { agentDetection: "", agentSessionRef: "" },
};
const target: PlaceTarget = { session: "main", matcher, paneIds: () => ["%1"] };
const panes: WalkyPane[] = [{ session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SPACE }];

function dir(prefix: string): string {
  const made = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(made, { recursive: true, force: true }));
  return made;
}

async function bridge(workspace: string, home: string): Promise<{ readonly socket: string; readonly hill: HillService }> {
  const stateDir = dir("ask-socket-");
  const host: WalkyHost = { panes: () => panes, send: async () => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
  const walky = new WalkyService({ log: new WalkyLog(join(stateDir, "walky")), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
  writeHillSwitch(stateDir, true);
  let n = 0;
  const hill = new HillService({
    store: new HillStore(null, () => 1000),
    receipts: memoryHillReceipts(),
    place: walkyPlace(walky, null),
    send: async () => "typed",
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: "m_aaaaaaaaaa",
    machine: "desk",
    now: () => 1000,
    mintAskId: () => `ak_sock${String((n += 1)).padStart(8, "0")}`,
    hillSwitch: new HillSwitch(stateDir, null, () => undefined),
    askFiles: askFilesResolver({ paneRoot: async (paneId) => (paneId === "%1" ? { root: workspace } : null), home, privateFolders: [stateDir] }),
  });
  const server = new WalkyServer({ socketPath: walkySocketPath(stateDir), service: walky, targets: () => [target], log: () => undefined, hill });
  expect(await server.start()).toBe(true);
  cleanups.push(() => server.stop());
  return { socket: walkySocketPath(stateDir), hill };
}

function deps(socket: string, cwd: string): HillDeps & { readonly io: ReturnType<typeof capture> } {
  const io = capture();
  return {
    ctx: context({ TMUX: "/tmp/tmux-1/default,123,0", TMUX_PANE: "%1" }, { stateDir: dir("ask-own-") }),
    stagingRoot: () => dir("ask-stage-"),
    files: realFiles,
    uid: process.getuid?.(),
    platform: "linux",
    readStdin: async () => "",
    stdinIsTty: true,
    ask: (path, line) => askSocket(path, line, 2000),
    sockets: () => [socket],
    mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f",
    now: () => 1000,
    cwd: () => cwd,
    io,
  };
}

const ASK = ["Ship the fix on Edge first?", "--fact", "The fix is green.", "--option", "edge=Ship it on Edge first", "--does", "edge=Testers get it today.", "--option", "stable=Ship it on Stable now", "--does", "stable=Everyone gets it."];

describe("walky ask over the socket", () => {
  socketTest("posts an ask with its files as pointers, lists it, reads it, and takes it back", async () => {
    const home = dir("ask-home-");
    const workspace = join(home, "repo");
    mkdirSync(join(workspace, "docs"), { recursive: true });
    writeFileSync(join(workspace, "docs", "a.md"), "# A\n");
    const b = await bridge(workspace, home);
    const d = deps(b.socket, workspace);
    expect(await cmdWalkyAsk(d, [...ASK, "--file", "docs/a.md#A", "--", "Background."])).toBe(EXIT.OK);
    expect(d.io.stdout[0]).toBe("ak_sock00000001");
    expect(d.io.stdout).toContain("  docs/a.md#A");
    const stored = b.hill.list().open[0]!;
    expect(stored.ask).toEqual({ words: false, files: [{ path: "docs/a.md", heading: "A" }], root: "%1", mark: "fresh" });
    const listed = deps(b.socket, workspace);
    expect(await cmdWalkyAsks(listed, [])).toBe(EXIT.OK);
    expect(listed.io.stdout).toEqual(["ak_sock00000001 Ship the fix on Edge first?"]);
    const status = deps(b.socket, workspace);
    expect(await cmdAskStatus(status, ["ak_sock00000001"])).toBe(EXIT.OK);
    expect(status.io.stdout[0]).toBe("ak_sock00000001 open");
    const cancel = deps(b.socket, workspace);
    expect(await cmdAskCancel(cancel, ["ak_sock00000001", "--because", "The test answers it."])).toBe(EXIT.OK);
    expect(cancel.io.stdout).toContain("reason: by the poster: The test answers it.");
  });

  socketTest("refuses a --file outside the workspace, and a sixth open ask", async () => {
    const home = dir("ask-home-");
    const workspace = join(home, "repo");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(home, "outside.md"), "x");
    const b = await bridge(workspace, home);
    const out = deps(b.socket, workspace);
    expect(await cmdWalkyAsk(out, [...ASK, "--file", join(home, "outside.md")])).toBe(EXIT.REFUSED);
    expect(out.io.stderr[0]).toContain("is outside the workspace root");
    expect(out.io.stderr[0]).toContain("(bad_file)");
    for (const n of [1, 2, 3, 4, 5]) {
      const one = deps(b.socket, workspace);
      expect(await cmdWalkyAsk(one, [...ASK, "--request-id", `00000000-0000-4000-8000-00000000000${String(n)}`])).toBe(EXIT.OK);
    }
    const sixth = deps(b.socket, workspace);
    expect(await cmdWalkyAsk(sixth, [...ASK, "--request-id", "00000000-0000-4000-8000-000000000006"])).toBe(EXIT.REFUSED);
    expect(sixth.io.stderr[0]).toContain("Take one back or replace one");
  });
});
