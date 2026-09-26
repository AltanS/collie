// The canary's own Herdr session, and the only door to it.
//
// Every command goes out as `herdr --session collie-canary …` with HERDR_SOCKET_PATH pointed at that
// session's socket and every inherited HERDR_* caller variable removed, so no command can resolve to
// the operator's session or to the pane the canary was started from (README: "Session targeting").
// On top of that, every pane and workspace command checks the id against the set this object
// created: a pane id the canary did not make is refused before any key is sent.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachClient, type CanaryClient } from "./client";
import { asJsonObject, asJsonString, parseJson, type JsonObject } from "../../web/src/lib/json";

export const CANARY_SESSION = "collie-canary";

/** Environment variables a pane must not inherit from the process that started the canary. The
 *  HERDR_* ones name the operator's session and pane; the CLAUDE* ones mark a nested Claude Code
 *  session, which makes a Claude started in a pane behave as a child (no transcript saved). */
const INHERITED = /^(HERDR_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$)/;

export function cleanEnv(env: NodeJS.ProcessEnv, socket: string | null, config: string | null = null) {
  const kept = Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && !INHERITED.test(e[0]));
  if (socket !== null) kept.push(["HERDR_SOCKET_PATH", socket]);
  if (config !== null) kept.push(["HERDR_CONFIG_PATH", config]);
  return Object.fromEntries(kept);
}

/**
 * The canary session's own Herdr config, so the operator's is never read or written by it: no
 * sound and no toast for agents that finish in the canary's workspaces, no update check, no
 * onboarding screen for the canary's client.
 */
const CANARY_CONFIG = `# Written by the Collie canary for its own Herdr session; deleted when the run ends.
onboarding = false

[update]
version_check = false

[ui.toast]
delivery = "off"

[ui.sound]
enabled = false
`;

/** The workspace the canary's client looks at. Nothing is ever typed into it. */
const VIEW_LABEL = "canary-view";

type CleanEnv = ReturnType<typeof cleanEnv>;

interface HerdrRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export interface CreatedWorkspace {
  readonly workspaceId: string;
  readonly paneId: string;
}

interface SessionRow {
  readonly name: string;
  readonly running: boolean;
  readonly socket: string;
}

function herdrSync(args: readonly string[], env: CleanEnv): HerdrRun {
  const r = Bun.spawnSync(["herdr", ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
}

export function listSessions(): SessionRow[] {
  const r = herdrSync(["session", "list", "--json"], cleanEnv(process.env, null));
  const list = asJsonObject(parseJson(r.out))?.sessions;
  if (!Array.isArray(list)) throw new Error(`herdr session list: unexpected output ${r.out.slice(0, 200)}`);
  return list.map((raw) => {
    const row = asJsonObject(raw);
    return {
      name: asJsonString(row?.name) ?? "",
      running: row?.running === true,
      socket: asJsonString(row?.socket_path) ?? "",
    };
  });
}

export interface PaneInfo {
  /** Herdr's agent label for the pane's foreground process, or null when it sees a plain shell. */
  readonly agent: string | null;
  /** idle | working | blocked | done | unknown. */
  readonly status: string;
}

export class CanarySession {
  private readonly panes = new Set<string>();
  private readonly workspaces = new Set<string>();
  private stopped = false;
  private client: CanaryClient | null = null;

  private constructor(
    readonly socket: string,
    private readonly configDir: string,
  ) {}

  private get config(): string {
    return join(this.configDir, "config.toml");
  }

  /**
   * Start the headless server of the canary's own session. Refuses when a session of that name
   * already exists: it is either another canary run or a crashed one, and neither is this run's to
   * take over or delete.
   */
  static async start(): Promise<CanarySession> {
    if (listSessions().some((s) => s.name === CANARY_SESSION)) {
      throw new Error(
        `a Herdr session named ${CANARY_SESSION} already exists. Another canary may be running; if not, remove it with ` +
          `\`herdr session stop ${CANARY_SESSION}; herdr session delete ${CANARY_SESSION}\``,
      );
    }
    const configDir = mkdtempSync(join(tmpdir(), "collie-canary-herdr-"));
    const config = join(configDir, "config.toml");
    writeFileSync(config, CANARY_CONFIG);
    // Detached and unreferenced: the server outlives nothing but this run, and the teardown stops it
    // by name. A Ctrl+C in the operator's terminal reaches this process, whose handler tears down.
    const child = spawn("herdr", ["--session", CANARY_SESSION, "server"], {
      env: cleanEnv(process.env, null, config),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const row = listSessions().find((s) => s.name === CANARY_SESSION);
      if (row?.running && row.socket !== "") {
        const session = new CanarySession(row.socket, configDir);
        if (session.probe()) {
          try {
            await session.attach();
          } catch (err) {
            session.teardown();
            throw err;
          }
          return session;
        }
      }
      await Bun.sleep(200);
    }
    rmSync(configDir, { recursive: true, force: true });
    throw new Error(`the ${CANARY_SESSION} Herdr server did not come up in 10 s`);
  }

  private env() {
    return cleanEnv(process.env, this.socket, this.config);
  }

  private probe(): boolean {
    return herdrSync(["--session", CANARY_SESSION, "workspace", "list"], this.env()).code === 0;
  }

  /**
   * Put the view workspace up first, so it is the one the client looks at, then attach the client
   * and wait until it has asked for colours and been answered (client.ts says why).
   */
  private async attach(): Promise<void> {
    this.createWorkspace(tmpdir(), VIEW_LABEL);
    this.client = attachClient(CANARY_SESSION, this.env());
    const deadline = Date.now() + 10_000;
    while (!this.client.answered()) {
      if (Date.now() > deadline) throw new Error("the canary's Herdr client never asked for the terminal colours");
      await Bun.sleep(100);
    }
    // Herdr takes the answers in after the query round; give it a moment before any pane starts.
    await Bun.sleep(1000);
  }

  /** One CLI call into the canary session. Throws with Herdr's own message on an error reply. */
  private cli(args: readonly string[]): JsonObject {
    if (this.stopped) throw new Error("the canary session is already torn down");
    const r = herdrSync(["--session", CANARY_SESSION, ...args], this.env());
    const doc = asJsonObject(parseJson(r.out));
    const error = asJsonObject(doc?.error);
    if (r.code !== 0 || error !== undefined) {
      throw new Error(`herdr ${args.slice(0, 2).join(" ")}: ${asJsonString(error?.message) ?? (r.err || r.out).trim()}`);
    }
    return asJsonObject(doc?.result) ?? {};
  }

  private owned(paneId: string): string {
    if (!this.panes.has(paneId)) throw new Error(`refusing pane ${paneId}: the canary did not create it`);
    return paneId;
  }

  createWorkspace(cwd: string, label: string): CreatedWorkspace {
    const result = this.cli(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
    const workspaceId = asJsonString(asJsonObject(result.workspace)?.workspace_id);
    const paneId = asJsonString(asJsonObject(result.root_pane)?.pane_id);
    if (workspaceId === undefined || paneId === undefined) throw new Error("herdr workspace create: no ids in the reply");
    this.workspaces.add(workspaceId);
    this.panes.add(paneId);
    return { workspaceId, paneId };
  }

  closeWorkspace(workspaceId: string): void {
    if (!this.workspaces.has(workspaceId)) throw new Error(`refusing workspace ${workspaceId}: the canary did not create it`);
    this.cli(["workspace", "close", workspaceId]);
    this.workspaces.delete(workspaceId);
    for (const p of this.panes) if (p.startsWith(`${workspaceId}:`)) this.panes.delete(p);
  }

  isOwnedPane(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  /** Literal text, not submitted. Herdr pastes it the way `herdr pane send-text` always does. */
  sendText(paneId: string, text: string): void {
    this.cli(["pane", "send-text", this.owned(paneId), text]);
  }

  sendKeys(paneId: string, keys: readonly string[]): void {
    if (keys.length === 0) return;
    this.cli(["pane", "send-keys", this.owned(paneId), ...keys]);
  }

  paneInfo(paneId: string): PaneInfo {
    const pane = asJsonObject(this.cli(["pane", "get", this.owned(paneId)]).pane);
    return { agent: asJsonString(pane?.agent) ?? null, status: asJsonString(pane?.agent_status) ?? "unknown" };
  }

  /**
   * Stop and delete the session, closing this run's workspaces first. Synchronous, so a signal
   * handler can run it to the end. Every step is attempted even when an earlier one failed; the
   * return value lists what could not be done.
   */
  teardown(): string[] {
    if (this.stopped) return [];
    const problems: string[] = [];
    const env = this.env();
    this.client?.close();
    this.client = null;
    for (const w of this.workspaces) {
      const r = herdrSync(["--session", CANARY_SESSION, "workspace", "close", w], env);
      if (r.code !== 0) problems.push(`workspace close ${w}: ${(r.err || r.out).trim()}`);
    }
    this.workspaces.clear();
    this.panes.clear();
    this.stopped = true;
    const stop = herdrSync(["session", "stop", CANARY_SESSION], cleanEnv(process.env, null));
    if (stop.code !== 0) problems.push(`session stop: ${(stop.err || stop.out).trim()}`);
    // `session stop` returns before the server is gone, and a running session cannot be deleted, so
    // the delete is retried for a few seconds.
    let del = herdrSync(["session", "delete", CANARY_SESSION], cleanEnv(process.env, null));
    for (let i = 0; i < 25 && del.code !== 0; i++) {
      Bun.sleepSync(200);
      del = herdrSync(["session", "delete", CANARY_SESSION], cleanEnv(process.env, null));
    }
    if (del.code !== 0) problems.push(`session delete: ${(del.err || del.out).trim()}`);
    rmSync(this.configDir, { recursive: true, force: true });
    return problems;
  }
}
