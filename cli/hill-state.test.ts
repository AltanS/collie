import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEntry } from "../bridge/audit.ts";
import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import { hillCrewStatePath, HillCrewStateFile, readHillCrewState, writeHillCrewState } from "../bridge/hill/crew-state.ts";
import type { HillLeadForward } from "../bridge/hill/crew.ts";
import { memoryHillReceipts } from "../bridge/hill/receipts.ts";
import { HillService, type HillCrewMode } from "../bridge/hill/service.ts";
import { HillStore } from "../bridge/hill/store.ts";
import { walkyPlace } from "../bridge/hill/walky.ts";
import type { WalkyHost, WalkyPane } from "../bridge/walky/deliver.ts";
import { WalkyLog } from "../bridge/walky/log.ts";
import { readWalkyRequest } from "../bridge/walky/parse.ts";
import { WalkyService } from "../bridge/walky/service.ts";
import { answerRequest, HILL_PERSON_ONLY, type PlaceTarget } from "../bridge/walky/socket.ts";
import { spaceOf } from "../bridge/walky/space.ts";
import { capture, context } from "./fakes.ts";
import { cmdHillPost, cmdHillState, CREW_STATE_MEANING, crewStateSince, personOnlyRefusal, type HillDeps } from "./hill.ts";
import { EXIT } from "./io.ts";
import { realFiles } from "./sys.ts";

// `collie hill state` and the post's last line (1.29.0), against the real request reader and the real
// socket answer (`answerRequest`), in this process: no socket file, so these run on every platform.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

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

/** The socket path the CLI is told of; the fake files make it pass the CLI's safety check, and `ask` answers in process. */
const SOCK = "/run/collie-test/walky/sock";

interface Bridge {
  readonly hill: HillService;
  readonly stateDir: string;
  readonly audit: AuditEntry[];
  readonly lines: string[];
  readonly ask: HillDeps["ask"];
}

function bridge(mode: HillCrewMode = "solo", forward?: HillLeadForward): Bridge {
  const stateDir = temp("hill-state-bridge-");
  const host: WalkyHost = { panes: () => panes, send: async () => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
  const walky = new WalkyService({ log: new WalkyLog(join(stateDir, "walky")), host, memberId: null, enabled: () => true, machine: "lodge", keyPem: () => null });
  const audit: AuditEntry[] = [];
  const hill = new HillService({
    store: new HillStore(null, () => 1000),
    receipts: memoryHillReceipts(),
    place: walkyPlace(walky, null),
    send: async () => "typed",
    crewMode: () => mode,
    walkyOn: () => true,
    memberId: "m_aaaaaaaaaa",
    machine: "lodge",
    now: () => Date.UTC(2026, 10, 11, 14, 2),
    mintId: () => "dc_state0000001",
    audit: (entry) => audit.push(entry),
    crewState: new HillCrewStateFile(stateDir, () => undefined, () => Date.UTC(2026, 10, 11, 14, 2)),
    forward,
  });
  const lines: string[] = [];
  const ask: HillDeps["ask"] = async (_path, line) => {
    lines.push(line);
    const read = readWalkyRequest(line.trim());
    if (!read.ok) return `${JSON.stringify({ ok: false, error: read.reason })}\n`;
    return `${JSON.stringify(await answerRequest(walky, read.request, [target], hill))}\n`;
  };
  return { hill, stateDir, audit, lines, ask };
}

function deps(over: Partial<HillDeps> & { readonly env?: Record<string, string> } = {}): HillDeps & { readonly io: ReturnType<typeof capture> } {
  const io = capture();
  const { env, ...rest } = over;
  return {
    ctx: context(env ?? {}, { stateDir: temp("hill-state-own-") }),
    files: { ...realFiles, entryType: (path) => (path === SOCK ? "other" : "directory"), mode: () => 0o700 },
    uid: undefined,
    platform: "linux",
    readStdin: async () => "",
    stdinIsTty: true,
    ask: async () => `${JSON.stringify({ ok: false, error: "not here" })}\n`,
    sockets: () => [SOCK],
    mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f",
    now: () => 1000,
    ...rest,
    io,
  };
}

describe("collie hill state", () => {
  test("reads the state from anywhere: one word, then a line with since when", async () => {
    const b = bridge();
    const plain = deps({ ask: b.ask });
    expect(await cmdHillState(plain, [])).toBe(EXIT.OK);
    expect(plain.io.stdout).toEqual(["here", "since always: nobody set it, so it is the default"]);
    b.hill.setCrewState("away", "Pixel 9", "Pixel 9");
    const agent = deps({ ask: b.ask, env: inPane("%1"), paneKind: async () => "agent" });
    expect(await cmdHillState(agent, [])).toBe(EXIT.OK);
    expect(agent.io.stdout).toEqual(["away", "since 2026-11-11 14:02 UTC, set by Pixel 9"]);
  });

  test("an agent's pane may not set it: the CLI refuses with exit 4 and nothing is written", async () => {
    const b = bridge();
    const d = deps({ ask: b.ask, env: inPane("%1"), paneKind: async () => "agent" });
    expect(await cmdHillState(d, ["away"])).toBe(EXIT.REFUSED);
    expect(d.io.stderr).toEqual(personOnlyRefusal("collie hill state away"));
    expect(b.lines).toEqual([]);
    expect(b.hill.crewState().state).toBe("here");
  });

  test("the bridge refuses a set from an agent's pane too, when the CLI's own check is skipped", async () => {
    const b = bridge();
    const d = deps({ ask: b.ask, env: inPane("%1") });
    expect(await cmdHillState(d, ["quiet"])).toBe(EXIT.REFUSED);
    expect(d.io.stderr).toEqual([`hill: ${HILL_PERSON_ONLY} (person_only)`]);
    expect(b.hill.crewState().state).toBe("here");
  });

  test("a plain terminal sets it through the bridge, which writes one audit line", async () => {
    const b = bridge();
    const shell = deps({ ask: b.ask, env: inPane("%3"), paneKind: async () => "shell" });
    expect(await cmdHillState(shell, ["away"])).toBe(EXIT.OK);
    expect(shell.io.stdout[0]).toBe(`Crew state: away. ${CREW_STATE_MEANING.away}`);
    expect(b.hill.crewState()).toMatchObject({ state: "away", by: "terminal" });
    expect(b.audit).toContainEqual({ action: "hill.state", device: "terminal", detail: { state: "away" } });
    const bare = deps({ ask: b.ask });
    expect(await cmdHillState(bare, ["here", "--json"])).toBe(EXIT.OK);
    expect(JSON.parse(bare.io.stdout[0] ?? "{}")).toMatchObject({ crewState: { state: "here", by: "terminal" } });
  });

  test("a word that is no crew state is a usage error", async () => {
    const d = deps();
    expect(await cmdHillState(d, ["asleep"])).toBe(EXIT.USAGE);
    expect(d.io.stderr[0]).toBe("error: `asleep` is not a crew state: here, quiet or away");
  });

  test("on a member it asks the lead; a lead too old to say is one plain line and a non-zero exit", async () => {
    const lead: HillLeadForward = {
      post: async () => ({ ok: false, code: null, error: "-" }),
      one: async () => ({ ok: false, missing: false, error: "-" }),
      list: async () => ({ ok: false, error: "-" }),
      state: async () => ({ ok: false, error: "the lead (lodge) runs a Collie too old to say the crew state", older: true }),
    };
    const b = bridge("peer", lead);
    const d = deps({ ask: b.ask });
    expect(await cmdHillState(d, [])).toBe(EXIT.REFUSED);
    expect(d.io.stdout).toEqual([]);
    expect(d.io.stderr).toEqual(["hill: the lead (lodge) runs a Collie too old to say the crew state (lead_too_old)"]);
    const set = deps({ ask: b.ask });
    expect(await cmdHillState(set, ["away"])).toBe(EXIT.REFUSED);
    expect(set.io.stderr[0]).toContain("the crew state lives on the crew's lead");
  });

  test("with no running Collie it reads and writes this machine's file", async () => {
    const read = deps({ sockets: () => [] });
    expect(await cmdHillState(read, [])).toBe(EXIT.OK);
    expect(read.io.stdout[0]).toBe("here");
    const write = deps({ sockets: () => [] });
    expect(await cmdHillState(write, ["quiet"])).toBe(EXIT.OK);
    expect(readHillCrewState(write.ctx.stateDir).view).toMatchObject({ state: "quiet", by: "terminal" });
    expect(existsSync(hillCrewStatePath(write.ctx.stateDir))).toBe(true);
  });

  test("the since line names no setter for a value with none", () => {
    expect(crewStateSince({ state: "quiet", at: Date.UTC(2026, 0, 2, 3, 4), by: null, told: null })).toBe("since 2026-01-02 03:04 UTC");
  });
});

describe("collie hill post's result", () => {
  const POST = ["--title", "Ship the fix?", "--summary", "The leg is green.", "--option", "yes=Yes"];

  test("ends with `Crew state: away.` while the state is not here, and prints the id alone under here", async () => {
    const b = bridge();
    const here = deps({ ask: b.ask, env: inPane("%1") });
    expect(await cmdHillPost(here, POST)).toBe(EXIT.OK);
    expect(here.io.stdout).toEqual(["dc_state0000001"]);
    writeHillCrewState(b.stateDir, { state: "away", by: "Pixel 9" }, 5);
    const away = deps({ ask: b.ask, env: inPane("%1"), mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e70" });
    // The same id is minted again by the fake; the store answers the repeat of the first request as stored.
    expect(await cmdHillPost(away, [...POST, "--request-id", "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f"])).toBe(EXIT.OK);
    expect(away.io.stdout).toEqual(["dc_state0000001", "Crew state: away."]);
    const json = deps({ ask: b.ask, env: inPane("%1") });
    expect(await cmdHillPost(json, [...POST, "--json"])).toBe(EXIT.OK);
    expect(JSON.parse(json.io.stdout[0] ?? "{}")).toMatchObject({ crewState: "away", decision: { id: "dc_state0000001" } });
  });
});
