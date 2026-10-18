import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { loadSlashLists } from "../slash-commands";
import { asJsonObject, parseJson, type JsonValue } from "../../../web/src/lib/json";
import { ScratchBridge, scratchBridgeEnv } from "./phone-bridge";
import { PhoneClient } from "./phone-client";
import { beltCommands, fullScreenCandidates, operatorBelt, otherScreenIn, sendStartLine, SHELL_TWO_TAPS, shippedBelt, shippedBeltFromDisk, slashPlan, writeBeaconHooks, type PhoneEnv } from "./phone";
import { viewOf } from "./screens";
import { freePort, RESERVED_PORTS } from "./ports";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("the belt the slash scenario sends", () => {
  test("Claude's shipped belt still parses from harness-bar.ts", () => {
    const belt = shippedBeltFromDisk("claude");
    expect(belt).toContain("/model");
    expect(belt.length).toBeGreaterThanOrEqual(2);
  });

  test("a commented-out row is not on the belt", () => {
    const source = 'const CLAUDE: readonly HarnessBarItem[] = [\n  { id: "model", command: "/model" },\n  // { id: "x", command: "/usage" },\n  { id: "effort", command: "/effort" },\n];\n';
    expect(shippedBelt(source)).toEqual(["/model", "/effort"]);
    expect(shippedBelt(source, "CODEX")).toEqual([]);
  });

  test("the operator's own bar rows replace the shipped belt, scoped to the harness", () => {
    const config = { commands: [{ command: "/fork", bar: true }, { command: "/x", bar: true, agent: "codex" }, { command: "/y", bar: false }] };
    expect(operatorBelt(config, "claude")).toEqual(["/fork"]);
    expect(beltCommands(["/model"], ["/fork"])).toEqual(["/fork"]);
    expect(beltCommands(["/model"], [])).toEqual(["/model"]);
    expect(operatorBelt(undefined, "claude")).toEqual([]);
  });

  test("a command the agent's menu marks removed is never sent, even from the belt or the safe list", () => {
    const plan = slashPlan(["/model", "/effort", "/agents"], loadSlashLists("claude"), ["/effort", "/agents"]);
    expect(plan.send).toEqual(["/model", "/help"]);
    expect(plan.removed).toEqual(["/effort", "/agents"]);
  });

  test("/model and /help go first, then the belt's safe commands; /clear and /compact are never sent", () => {
    const plan = slashPlan(["/model", "/effort", "/compact", "/resume", "/clear"], loadSlashLists("claude"));
    expect(plan.send).toEqual(["/model", "/help", "/effort", "/resume"]);
    expect(plan.skipped).toEqual(["/compact", "/clear"]);
  });
});

describe("the scratch bridge", () => {
  const options = {
    repoRoot: "/repo",
    root: "/lab/run/phone/bridge",
    tmuxSocket: "harness-lab-42",
    tmuxBinary: "/usr/bin/tmux",
    agentBinDir: "/lab/run/bin/node_modules/.bin",
    agentConfig: "/lab/run/phone/config",
    env: { PATH: "/usr/bin", HOME: "/home/alice", HERDR_SOCKET_PATH: "/home/alice/.config/herdr/herdr.sock", COLLIE_STATE_DIR: "/home/alice/.local/state/collie", CLAUDE_CONFIG_DIR: "/home/alice/.claude", USER: "alice" },
  };

  test("its environment holds no folder of the person's and no inherited Collie or Herdr setting", () => {
    // Expected paths come from the host's own join and PATH delimiter, so the claims hold on Windows too.
    const env = scratchBridgeEnv(options, 40123);
    expect(env.HOME).toBe(join(options.root, "home"));
    expect(env.COLLIE_STATE_DIR).toBe(join(options.root, "state"));
    expect(env.HERDR_PLUGIN_CONFIG_DIR).toBe(join(options.root, "config"));
    expect(env.XDG_STATE_HOME).toBe(join(options.root, "xdg-state"));
    expect(env.HERDR_SOCKET_PATH).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(Object.values(env).some((value) => value.includes("/home/alice"))).toBe(false);
    expect(env).toMatchObject({ COLLIE_MUX: "tmux", COLLIE_MUX_ENDPOINT_TMUX: "harness-lab-42", COLLIE_HOST: "127.0.0.1", COLLIE_PORT: "40123", COLLIE_SKIP_SERVE: "1", COLLIE_TRANSCRIPT_ROOT: join(options.agentConfig, "projects") });
    expect(env.PATH).toBe([options.agentBinDir, "/usr/bin"].join(delimiter));
  });

  test("a free port is never one of the person's Collie ports", () => {
    const offers = [8787, 8799, 45000];
    expect(freePort(() => ({ port: offers.shift() ?? 0, stop() {} }))).toBe(45000);
    expect(() => freePort(() => ({ port: 8788, stop() {} }))).toThrow(/ports the person's Collie uses/);
    const real = freePort();
    expect(real < RESERVED_PORTS.from || real > RESERVED_PORTS.to).toBe(true);
  });

  test("the phone panes' settings carry the beacon hooks with this checkout's CLI, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "lab-phone-hooks-"));
    dirs.push(dir);
    const command = writeBeaconHooks(dir, "/repo", "/usr/bin/bun");
    expect(command).toBe(`/usr/bin/bun ${join("/repo", "cli", "main.ts")} beacon emit # collie-beacon v1`);
    const doc = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(Object.keys(doc)).toEqual(["hooks"]);
    expect(Object.keys(doc.hooks)).toContain("UserPromptSubmit");
    expect(JSON.stringify(doc)).not.toContain("PermissionRequest");
  });
});

describe("scenario 6: a screen of its own", () => {
  const lists = loadSlashLists("claude");

  test("/agents is tried first only when the menu lists it and does not mark it removed; then safe dialogs, agent and task names first", () => {
    const names = ["/agents", "/help", "/tasks", "/context", "/mystery", "/clear"];
    expect(fullScreenCandidates({ names, removed: [] }, lists)).toEqual(["/agents", "/tasks", "/help"]);
    expect(fullScreenCandidates({ names, removed: ["/agents"] }, lists)).toEqual(["/tasks", "/help"]);
    expect(fullScreenCandidates({ names: ["/mystery", "/clear"], removed: [] }, lists)).toEqual([]);
  });

  test("the agents screen's footer row is read from the profile's otherScreens", () => {
    const panes = join(import.meta.dir, "..", "..", "..", "web", "src", "fixtures", "panes");
    const agents = viewOf(readFileSync(join(panes, "claude-lab--agents-screen--w82.txt"), "utf8"), "claude");
    const idle = viewOf(readFileSync(join(panes, "claude--fresh-idle.txt"), "utf8"), "claude");
    expect(otherScreenIn(agents.plain, "claude")).toBe("agents screen");
    expect(otherScreenIn(idle.plain, "claude")).toBeNull();
  });
});

describe("the start line on a shell pane", () => {
  interface Leg {
    readonly env: PhoneEnv;
    readonly bodies: JsonValue[];
    readonly client: PhoneClient;
  }

  /** A leg env around a fake bridge whose /api/send answers come from `answers`, in order. */
  function legWith(answers: JsonValue[]): Leg {
    const bodies: JsonValue[] = [];
    const client = new PhoneClient("http://127.0.0.1:41000", "t", async (url, init) => {
      if (url.endsWith("/api/workspace")) return new Response(JSON.stringify({ ok: true, pane: { paneId: "%1" } }));
      bodies.push(parseJson(init.body ?? "") ?? null);
      return new Response(JSON.stringify(answers.shift() ?? {}));
    });
    const env: PhoneEnv = {
      harness: "claude",
      version: "2.1.302",
      client,
      target: "scratch",
      streamWanted: ["effective"],
      agentBinary: "/bin/true",
      agentArgs: [],
      agentEnv: {},
      workDir: "/nowhere",
      outDir: "/nowhere",
      redact: (text) => text,
      turns: { used: 0, cap: 14 },
      gaps: [],
      lists: loadSlashLists("claude"),
      belt: [],
      log: () => {},
    };
    return { env, bodies, client };
  }

  test("a blind send that comes back sent on the first tap passes, with the no-profile screen words", async () => {
    const { env, bodies, client } = legWith([{ receipt: { requestId: "r1", outcome: "sent", keys: ["Enter"], saw: { turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-profile" } }, offers: [] }]);
    const pane = await client.createPane("/p", "x");
    const done = await sendStartLine(env, "idle-send", pane, "exec /p/start.sh");
    expect(done.went).toBe(true);
    expect(done.check).toMatchObject({ verdict: "pass" });
    expect(done.check.detail).toContain("saw no-profile");
    expect(bodies).toHaveLength(1);
  });

  test("refused unconfirmed on the first tap fails as a two-tap shell send, and the commit tap still starts the agent", async () => {
    const { env, bodies, client } = legWith([{ receipt: { requestId: "r1", outcome: "refused", reason: "unconfirmed", keys: [] }, rowsHash: "h1", offers: ["commit"] }, { receipt: { requestId: "r2", outcome: "unknown", reason: "no_evidence", keys: ["Enter"] }, offers: [] }]);
    const pane = await client.createPane("/p", "x");
    const done = await sendStartLine(env, "idle-send", pane, "exec /p/start.sh");
    expect(done.check.verdict).toBe("fail");
    expect(done.check.detail).toStartWith(SHELL_TWO_TAPS);
    expect(done.went).toBe(true);
    expect(asJsonObject(bodies[1] ?? null)?.rowsHash).toBe("h1");
  });
});

describe("the scratch bridge's folder", () => {
  test("it refuses a folder too near the root, because it deletes the folder first", async () => {
    const options = { repoRoot: "/repo", root: "/lab", tmuxSocket: "s", tmuxBinary: "/usr/bin/tmux", agentBinDir: "/b", agentConfig: "/c", env: {}, port: 45001 };
    await expect(ScratchBridge.start(options, () => {})).rejects.toThrow(/deletes it first/);
  });
});
