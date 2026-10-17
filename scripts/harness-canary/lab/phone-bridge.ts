// The phone leg's scratch bridge (M56 spec 10, the phone leg): this checkout's own bridge, started as
// a child process on the lab's throwaway tmux server, so the phone leg drives the Send Protocol the
// way the phone does, over HTTP. It is the only bridge the lab ever starts.
//
// Nothing of the person's is read or written. The child gets:
//   - a port from `freePort` on 127.0.0.1 (never 8787 to 8799), and `COLLIE_SKIP_SERVE=1`, so no
//     `tailscale serve` runs;
//   - its own `HOME`, `COLLIE_STATE_DIR`, `HERDR_PLUGIN_CONFIG_DIR` and XDG folders under `root`, so
//     no config, state, pairing, hook target or front door record of a real instance is touched;
//   - `COLLIE_MUX=tmux` on the lab's socket name;
//   - the lab's installed agent first on `PATH`, so the profile's version command reads the version
//     under test, and `COLLIE_TRANSCRIPT_ROOT` in the phone panes' own config folder, so the bridge
//     finds the beacon hooks the leg wrote there (`hooksInstalledProbe`, bridge/beacon-io.ts).
//
// Pairing is a file, not a code: the leg mints a token, writes its hash into the scratch
// `paired-devices.json` before the bridge starts, and keeps the token in memory. The token is never
// logged. `stop()` ends the child and deletes `root`, the pairing file with it.

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { DEVICES_FILENAME, sha256Hex } from "../../../bridge/pairing";
import { SERVER_ENV_KEYS, type EnvMap } from "./harnesses";
import { PhoneClient } from "./phone-client";
import { freePort, RESERVED_PORTS } from "./ports";

const START_TIMEOUT_MS = 45_000;
const STOP_GRACE_MS = 5000;

export const PHONE_DEVICE_LABEL = "harness-lab-phone";

export interface ScratchBridgeOptions {
  /** This checkout: the bridge runs from `<repoRoot>/bridge/index.ts`. */
  readonly repoRoot: string;
  /** The scratch bridge's own folder. Deleted by `stop()`. */
  readonly root: string;
  /** The lab tmux server's socket name (`harness-lab-<pid>`). */
  readonly tmuxSocket: string;
  readonly tmuxBinary: string;
  /** The folder of the lab's installed agent binary, put first on the bridge's PATH. */
  readonly agentBinDir: string;
  /** The `CLAUDE_CONFIG_DIR` of the phone panes: the bridge's hooks probe and journal read it. */
  readonly agentConfig: string;
  /** The caller's environment. Only the short list ({@link SERVER_ENV_KEYS}) is passed on. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly port?: number;
}

/** The environment the scratch bridge gets. Pure, so a test pins that no real folder leaks in. */
export function scratchBridgeEnv(options: ScratchBridgeOptions, port: number): EnvMap {
  const out: EnvMap = { TERM: "xterm-256color" };
  for (const key of SERVER_ENV_KEYS) {
    const value = options.env[key];
    if (value !== undefined) out[key] = value;
  }
  const home = join(options.root, "home");
  return {
    ...out,
    HOME: home,
    PATH: [options.agentBinDir, options.env.PATH ?? ["/usr/bin", "/bin"].join(delimiter)].join(delimiter),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(options.root, "xdg-state"),
    COLLIE_STATE_DIR: join(options.root, "state"),
    HERDR_PLUGIN_CONFIG_DIR: join(options.root, "config"),
    COLLIE_MUX: "tmux",
    COLLIE_MUX_ENDPOINT_TMUX: options.tmuxSocket,
    COLLIE_TMUX_BIN: options.tmuxBinary,
    COLLIE_HOST: "127.0.0.1",
    COLLIE_PORT: String(port),
    COLLIE_SKIP_SERVE: "1",
    COLLIE_INSTANCE: "harness-lab-phone",
    COLLIE_TRANSCRIPT_ROOT: join(options.agentConfig, "projects"),
  };
}

/** How many folders deep a path sits under its root: `/a/b/c` is 3. */
function depthOf(path: string): number {
  let depth = 0;
  for (let at = path; dirname(at) !== at; at = dirname(at)) depth++;
  return depth;
}

export class ScratchBridge {
  private constructor(
    readonly url: string,
    readonly token: string,
    /** The bridge's state dir. The phone panes' hooks write their edges here (`COLLIE_STATE_DIR`). */
    readonly stateDir: string,
    /** The bridge's XDG state folder. The phone panes get it too, so their hooks find only this bridge. */
    readonly xdgState: string,
    readonly logPath: string,
    private readonly root: string,
    private readonly child: ReturnType<typeof Bun.spawn>,
  ) {}

  static async start(options: ScratchBridgeOptions, log: (line: string) => void): Promise<ScratchBridge> {
    const port = options.port ?? freePort();
    if (port >= RESERVED_PORTS.from && port <= RESERVED_PORTS.to) throw new Error(`the scratch bridge refuses port ${String(port)}: it belongs to the person's Collie`);
    const env = scratchBridgeEnv(options, port);
    const stateDir = env.COLLIE_STATE_DIR!;
    // Fresh state on every start: no pairing, counter or cap of an earlier run reaches this one.
    if (!isAbsolute(options.root) || depthOf(options.root) < 3) throw new Error(`the scratch bridge refuses the folder ${options.root}: it deletes it first`);
    rmSync(options.root, { recursive: true, force: true });
    for (const dir of [options.root, stateDir, env.HERDR_PLUGIN_CONFIG_DIR!, env.HOME!, env.XDG_STATE_HOME!]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    writeFileSync(join(stateDir, DEVICES_FILENAME), `${JSON.stringify({ devices: [{ label: PHONE_DEVICE_LABEL, tokenHash: sha256Hex(token), createdAt: now, lastSeenAt: now }] }, null, 2)}\n`, { mode: 0o600 });
    const logPath = join(options.root, "bridge.log");
    writeFileSync(logPath, "");
    const child = Bun.spawn([process.execPath, join(options.repoRoot, "bridge", "index.ts")], {
      cwd: options.root,
      env,
      stdin: "ignore",
      stdout: Bun.file(logPath),
      stderr: "pipe",
    });
    // stderr goes to the same file, after stdout's lines; Bun.file takes one writer, so stderr is copied.
    void (async () => {
      const reader = child.stderr.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        try {
          appendFileSync(logPath, decoder.decode(value));
        } catch {
          break;
        }
      }
    })();
    const url = `http://127.0.0.1:${String(port)}`;
    const bridge = new ScratchBridge(url, token, stateDir, env.XDG_STATE_HOME!, logPath, options.root, child);
    const probe = new PhoneClient(url, token);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      if (await probe.health()) {
        log(`scratch bridge: pid ${String(child.pid)} on ${url}, tmux socket name ${options.tmuxSocket}`);
        return bridge;
      }
      await Bun.sleep(300);
    }
    const tail = bridge.logTail(15);
    await bridge.stop();
    throw new Error(`the scratch bridge did not answer /api/health within ${String(START_TIMEOUT_MS / 1000)} s${child.exitCode === null ? "" : ` (it exited ${String(child.exitCode)})`}: ${tail.join(" | ")}`);
  }

  /** The last lines the bridge printed. */
  logTail(lines: number): string[] {
    try {
      return readFileSync(this.logPath, "utf8").trimEnd().split("\n").slice(-lines);
    } catch {
      return [];
    }
  }

  /** The bridge's whole log, for the phone leg's run folder. Empty when it is gone. */
  logText(): string {
    try {
      return readFileSync(this.logPath, "utf8");
    } catch {
      return "";
    }
  }

  /** SIGTERM, then SIGKILL after a grace, then the folder goes. Never throws. True when the child is gone. */
  async stop(): Promise<boolean> {
    let gone = this.child.exitCode !== null;
    if (!gone) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      gone = await Promise.race([this.child.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
      if (!gone) {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        gone = await Promise.race([this.child.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
      }
    }
    rmSync(this.root, { recursive: true, force: true });
    return gone;
  }
}
