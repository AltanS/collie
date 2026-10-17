// The throwaway tmux of a lab run (M56 spec 10). The lab starts its own server,
// `tmux -f /dev/null -L harness-lab-<pid>`, so the person's tmux server is never named, read or
// written. `-f /dev/null` reads no config file. The socket name holds the process id of the run.
//
// The adapter is Collie's own TmuxMux, pointed at that socket, so the protocol under test sends keys
// and reads the screen the way the bridge does.

import { existsSync, rmSync } from "node:fs";
import { TmuxMux } from "../../../bridge/mux/tmux/adapter";
import { resolveTmuxBinary, SpawnTmuxExec } from "../../../bridge/mux/tmux/exec";

export const LAB_COLS = 120;
export const LAB_ROWS = 40;
export const SESSION = "lab";
const TMUX_TIMEOUT_MS = 5000;

export function socketName(pid: number = process.pid): string {
  return `harness-lab-${String(pid)}`;
}

/** One word for a shell, in single quotes. */
export function shellWord(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The shell line a pane runs: `env K=V ... program args`, every word quoted. */
export function paneCommand(env: Readonly<Record<string, string>>, program: string, args: readonly string[]): string {
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${shellWord(value)}`);
  return ["env", ...assignments, shellWord(program), ...args.map(shellWord)].join(" ");
}

export class LabTmux {
  readonly socket: string;
  private readonly binary: string;

  constructor(socket: string = socketName(), binary: string | null = resolveTmuxBinary("")) {
    if (binary === null) throw new Error("no tmux binary found");
    this.socket = socket;
    this.binary = binary;
  }

  /** The flags every tmux call of this lab carries: no config file, and a socket of its own. */
  serverArgs(): string[] {
    return ["-f", "/dev/null", "-L", this.socket];
  }

  /** The adapter the protocol and the walk use. */
  adapter(): TmuxMux {
    return new TmuxMux(new SpawnTmuxExec(this.binary, this.serverArgs(), TMUX_TIMEOUT_MS));
  }

  /** Start the server with one window that runs `command` in `cwd`. `env` is the short list the server gets. */
  async start(cwd: string, command: string, env: Readonly<Record<string, string>>): Promise<void> {
    const child = Bun.spawn([this.binary, "-u", ...this.serverArgs(), "new-session", "-d", "-s", SESSION, "-x", String(LAB_COLS), "-y", String(LAB_ROWS), "-c", cwd, command], {
      env: { ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`tmux new-session failed (${String(code)}): ${err.trim()}`);
  }

  /**
   * The size a session gets when a client creates it with no size of its own: the phone leg's scratch
   * bridge makes its panes with `new-session -d`, which tmux sizes from this option (80x24 by default).
   * Set to the lab's own {@link LAB_COLS} x {@link LAB_ROWS}, so every lab pane has one size.
   */
  async setDefaultSize(): Promise<void> {
    const child = Bun.spawn([this.binary, "-u", ...this.serverArgs(), "set-option", "-g", "default-size", `${String(LAB_COLS)}x${String(LAB_ROWS)}`], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`tmux set-option default-size failed (${String(code)}): ${err.trim()}`);
  }

  /** The tmux binary this server runs on. The scratch bridge is given the same one. */
  binaryPath(): string {
    return this.binary;
  }

  /** The id of the one pane, from the adapter's own snapshot. */
  async paneId(): Promise<string> {
    const snapshot = await this.adapter().snapshot();
    const pane = snapshot.panes[0];
    if (pane === undefined) throw new Error("the lab tmux has no pane");
    return pane.paneId;
  }

  /** Stop the server and make sure its socket is gone. Never throws. */
  async stop(): Promise<boolean> {
    try {
      const child = Bun.spawn([this.binary, "-u", ...this.serverArgs(), "kill-server"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      await child.exited;
    } catch {
      // The server may already be gone.
    }
    for (let i = 0; i < 20; i++) {
      if (!(await this.alive())) {
        // tmux can leave the socket file behind when it dies on kill-server. Nothing answers on it,
        // and the name holds this run's pid, so the file is ours to remove.
        rmSync(this.socketPath(), { force: true });
        return true;
      }
      await Bun.sleep(100);
    }
    return false;
  }

  /** Whether a server still answers on the socket. */
  async alive(): Promise<boolean> {
    const child = Bun.spawn([this.binary, "-u", ...this.serverArgs(), "list-sessions"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await child.exited) === 0;
  }

  /** The path tmux keeps the socket at, for a leftover check. */
  socketPath(uid: number = process.getuid?.() ?? 0, tmpdir: string = process.env.TMUX_TMPDIR ?? "/tmp"): string {
    return `${tmpdir}/tmux-${String(uid)}/${this.socket}`;
  }

  leftover(): boolean {
    return existsSync(this.socketPath());
  }
}
