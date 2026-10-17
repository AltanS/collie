import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSlashLists } from "../slash-commands";
import { scratchBridgeEnv } from "./phone-bridge";
import { beltCommands, operatorBelt, shippedBelt, shippedBeltFromDisk, slashPlan, writeBeaconHooks } from "./phone";
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
    const env = scratchBridgeEnv(options, 40123);
    expect(env.HOME).toBe("/lab/run/phone/bridge/home");
    expect(env.COLLIE_STATE_DIR).toBe("/lab/run/phone/bridge/state");
    expect(env.HERDR_PLUGIN_CONFIG_DIR).toBe("/lab/run/phone/bridge/config");
    expect(env.XDG_STATE_HOME).toBe("/lab/run/phone/bridge/xdg-state");
    expect(env.HERDR_SOCKET_PATH).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(Object.values(env).some((value) => value.includes("/home/alice"))).toBe(false);
    expect(env).toMatchObject({ COLLIE_MUX: "tmux", COLLIE_MUX_ENDPOINT_TMUX: "harness-lab-42", COLLIE_HOST: "127.0.0.1", COLLIE_PORT: "40123", COLLIE_SKIP_SERVE: "1", COLLIE_TRANSCRIPT_ROOT: "/lab/run/phone/config/projects" });
    expect(env.PATH).toBe("/lab/run/bin/node_modules/.bin:/usr/bin");
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
    expect(command).toBe("/usr/bin/bun /repo/cli/main.ts beacon emit # collie-beacon v1");
    const doc = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(Object.keys(doc)).toEqual(["hooks"]);
    expect(Object.keys(doc.hooks)).toContain("UserPromptSubmit");
    expect(JSON.stringify(doc)).not.toContain("PermissionRequest");
  });
});
