import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import type { SessionRegistry } from "./sessions.ts";
import type {
  FirstmateChecks,
  FirstmateDecision,
  FirstmateGate,
  FirstmateInFlight,
  FirstmateLanded,
  FirstmatePullRequest,
  FirstmateStatus,
  FirstmateUnavailableReason,
} from "./types.ts";

const COMMAND_TIMEOUT_MS = 20_000;
const OUTPUT_LIMIT_BYTES = 512 * 1024;
const MAX_ROWS = 50;
const MAX_ID = 120;
const MAX_TEXT = 240;

interface EndpointCandidate {
  id: string;
  backend: string;
  target: string;
}

interface BearingsData {
  home: string;
  generatedAt: string;
  inFlight: FirstmateInFlight[];
  decisions: FirstmateDecision[];
  gates: FirstmateGate[];
  landed: FirstmateLanded[];
  prs: FirstmatePullRequest[];
  prSummary: string | null;
  endpoints: EndpointCandidate[];
}

class FirstmateRunError extends Error {
  constructor(readonly reason: FirstmateUnavailableReason) {
    super(reason);
  }
}

export interface FirstmateRunner {
  run(includePrs: boolean): Promise<unknown>;
  stop?(): void;
}

interface FirstmateProviderOptions {
  home: string;
  refreshMs: number;
  includePrs: boolean;
  prRefreshMs: number;
  runner?: FirstmateRunner;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.slice(0, max);
}

function githubPullUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      !/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeList<T>(value: unknown, normalize: (row: Record<string, unknown>) => T | null): T[] | null {
  const input = Array.isArray(value) ? value.slice(0, MAX_ROWS) : null;
  if (!input) return null;
  const output: T[] = [];
  for (const value of input) {
    const item = record(value);
    if (!item) return null;
    const normalized = normalize(item);
    if (!normalized) return null;
    output.push(normalized);
  }
  return output;
}

/** Strictly projects the allowlisted fm-bearings.v1 fields; no source paths or actions survive. */
export function normalizeBearings(value: unknown, includePrs: boolean): BearingsData | null {
  const root = record(value);
  if (!root || root.schema !== "fm-bearings.v1") return null;
  const home = boundedString(root.home, 120);
  const generatedAt = boundedString(root.generated, 64);
  if (
    !home ||
    !generatedAt ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(generatedAt) ||
    !Number.isFinite(Date.parse(generatedAt))
  ) return null;
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(home) || home.split(/[\\/]/).includes("..")) return null;

  const inFlight = normalizeList(root.in_flight, (item) => {
    const id = boundedString(item.id, MAX_ID);
    const kind = boundedString(item.kind, 40);
    const state = boundedString(item.state, 40);
    const doing = boundedString(item.doing);
    return id && kind && state && doing !== null ? { id, kind, state, doing } : null;
  });
  const decisions = normalizeList(root.decisions_open, (item) => {
    const id = boundedString(item.id, MAX_ID);
    const summary = boundedString(item.summary);
    const owner = boundedString(item.owner, MAX_ID);
    return id && summary && owner ? { id, summary, owner } : null;
  });
  const gates = normalizeList(root.gates, (item) => {
    const id = boundedString(item.id, MAX_ID);
    const title = boundedString(item.title);
    const blockedBy = boundedString(item.blocked_by);
    const reason = boundedString(item.reason);
    const owner = boundedString(item.owner, MAX_ID);
    return id && title && blockedBy && reason && owner ? { id, title, blockedBy, reason, owner } : null;
  });
  const landed = normalizeList(root.landed, (item) => {
    const id = boundedString(item.id, MAX_ID);
    const what = boundedString(item.what);
    const owner = boundedString(item.owner, MAX_ID);
    return id && what && owner ? { id, what, owner } : null;
  });
  const endpoints = normalizeList(root.endpoints, (item) => {
    const id = boundedString(item.id, MAX_ID);
    const backend = boundedString(item.backend, 40);
    const target = boundedString(item.target, 200);
    return id && backend && target ? { id, backend, target } : null;
  });
  if (!inFlight || !decisions || !gates || !landed || !endpoints) return null;

  let prs: FirstmatePullRequest[] = [];
  let prSummary: string | null = null;
  if (includePrs) {
    prSummary = boundedString(root.prs, 160);
    if (prSummary === null) return null;
    const normalized = normalizeList(root.candidate_prs, (item) => {
      const number = boundedString(item.num, 20);
      const repo = boundedString(item.repo, 120);
      const task = boundedString(item.task, MAX_ID);
      const rawUrl = githubPullUrl(item.url);
      const url =
        number &&
        repo &&
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) &&
        rawUrl &&
        new URL(rawUrl).pathname.replace(/\/$/, "").toLowerCase() ===
          `/${repo}/pull/${number}`.toLowerCase()
          ? rawUrl
          : null;
      const reviewRaw = boundedString(item.review, 40);
      const review = reviewRaw === "" ? "none" : reviewRaw;
      const mergeable = boundedString(item.mergeable, 40);
      const rawChecks = boundedString(item.checks, 20);
      const checks: FirstmateChecks = ["none", "pending", "passing", "failing"].includes(rawChecks ?? "")
        ? (rawChecks as FirstmateChecks)
        : "unknown";
      return number && /^\d+$/.test(number) && repo && task && url && review && mergeable
        ? { number, repo, task, url, review, mergeable, checks }
        : null;
    });
    if (!normalized) return null;
    prs = normalized;
  }

  return { home, generatedAt, inFlight, decisions, gates, landed, prs, prSummary, endpoints };
}

interface ProcessRunnerLimits {
  timeoutMs?: number;
  outputLimitBytes?: number;
}

export class ProcessFirstmateRunner implements FirstmateRunner {
  private readonly command: string | null;
  private readonly home: string;
  private readonly timeoutMs: number;
  private readonly outputLimitBytes: number;
  private readonly terminateActive = new Set<() => void>();

  constructor(home: string, limits: ProcessRunnerLimits = {}) {
    this.timeoutMs = limits.timeoutMs ?? COMMAND_TIMEOUT_MS;
    this.outputLimitBytes = limits.outputLimitBytes ?? OUTPUT_LIMIT_BYTES;
    try {
      const resolvedHome = realpathSync(home);
      if (!statSync(resolvedHome).isDirectory()) throw new Error("not a directory");
      const command = realpathSync(join(resolvedHome, "bin", "fm-bearings-snapshot.sh"));
      const info = statSync(command);
      const contained = command.startsWith(resolvedHome.endsWith(sep) ? resolvedHome : `${resolvedHome}${sep}`);
      this.home = resolvedHome;
      this.command = contained && info.isFile() && (info.mode & 0o111) !== 0 ? command : null;
    } catch {
      this.home = home;
      this.command = null;
    }
  }

  run(includePrs: boolean): Promise<unknown> {
    if (!this.command) return Promise.reject(new FirstmateRunError("not-executable"));
    const args = ["--json", "--fields", "endpoints", ...(includePrs ? ["--include-prs"] : [])];
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "GH_CONFIG_DIR"]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    env.FM_BEARINGS_PR_TIMEOUT = "5";
    env.FM_BEARINGS_PR_REPOS = "3";
    env.FM_BEARINGS_PR_LIMIT = "20";

    return new Promise((resolve, reject) => {
      const child = spawn(this.command!, args, {
        cwd: this.home,
        detached: process.platform !== "win32",
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const terminate = () => {
        if (child.pid && process.platform !== "win32") {
          try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
          setTimeout(() => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
          }, 100).unref();
        } else child.kill("SIGTERM");
      };
      this.terminateActive.add(terminate);
      const fail = (reason: FirstmateUnavailableReason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        terminate();
        reject(new FirstmateRunError(reason));
      };
      const timeout = setTimeout(() => fail("timeout"), this.timeoutMs);
      timeout.unref();

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.outputLimitBytes) return fail("output-limit");
        output.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > this.outputLimitBytes) fail("output-limit");
      });
      child.on("error", () => fail("command-failed"));
      child.on("close", (code) => {
        this.terminateActive.delete(terminate);
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) return reject(new FirstmateRunError("command-failed"));
        try {
          resolve(JSON.parse(Buffer.concat(output).toString("utf8")));
        } catch {
          reject(new FirstmateRunError("invalid-output"));
        }
      });
    });
  }
  stop(): void {
    for (const terminate of this.terminateActive) terminate();
    this.terminateActive.clear();
  }
}

export class FirstmateProvider {
  private base: BearingsData | null = null;
  private prs: FirstmatePullRequest[] = [];
  private prSucceeded = false;
  private prFailed = false;
  private prSummary: string | null = null;
  private failure: FirstmateUnavailableReason | null = null;
  private baseFlight: Promise<void> | null = null;
  private prFlight: Promise<void> | null = null;
  private baseTimer: ReturnType<typeof setInterval> | null = null;
  private prTimer: ReturnType<typeof setInterval> | null = null;
  private readonly runner: FirstmateRunner;

  constructor(private readonly options: FirstmateProviderOptions) {
    this.runner = options.runner ?? new ProcessFirstmateRunner(options.home);
  }

  start(): void {
    if (this.baseTimer) return;
    void this.refreshBase();
    this.baseTimer = setInterval(() => void this.refreshBase(), this.options.refreshMs);
    this.baseTimer.unref();
    if (this.options.includePrs) {
      void this.refreshPrs();
      this.prTimer = setInterval(() => void this.refreshPrs(), this.options.prRefreshMs);
      this.prTimer.unref();
    }
  }

  stop(): void {
    if (this.baseTimer) clearInterval(this.baseTimer);
    if (this.prTimer) clearInterval(this.prTimer);
    this.baseTimer = null;
    this.runner.stop?.();
    this.prTimer = null;
  }

  refreshBase(): Promise<void> {
    if (this.baseFlight) return this.baseFlight;
    this.baseFlight = this.runner.run(false).then((value) => {
      const normalized = normalizeBearings(value, false);
      if (!normalized) throw new FirstmateRunError("invalid-output");
      this.base = normalized;
      this.failure = null;
    }).catch((error: unknown) => {
      this.failure = error instanceof FirstmateRunError ? error.reason : "command-failed";
    }).finally(() => {
      this.baseFlight = null;
    });
    return this.baseFlight;
  }

  refreshPrs(): Promise<void> {
    if (!this.options.includePrs) return Promise.resolve();
    if (this.prFlight) return this.prFlight;
    this.prFlight = this.runner.run(true).then((value) => {
      const normalized = normalizeBearings(value, true);
      if (!normalized) throw new FirstmateRunError("invalid-output");
      this.prs = normalized.prs;
      this.prSummary = normalized.prSummary;
      this.prSucceeded = true;
      this.prFailed = false;
    }).catch(() => {
      this.prFailed = true;
      // PR enrichment is independent: retain the last good PR cache and base freshness.
    }).finally(() => {
      this.prFlight = null;
    });
    return this.prFlight;
  }

  status(registry?: SessionRegistry): FirstmateStatus {
    if (!this.base) return this.failure ? { state: "unavailable", reason: this.failure } : { state: "loading" };
    const state = this.failure ? "stale" : "ready";
    const endpoints = registry ? resolveEndpoints(this.base.endpoints, registry) : new Map<string, { session: string; paneId: string }>();
    const attach = <T extends { id: string }>(item: T): T & { endpoint?: { session: string; paneId: string } } => {
      const endpoint = endpoints.get(item.id);
      return endpoint ? { ...item, endpoint } : item;
    };
    const prState = !this.options.includePrs
      ? "disabled"
      : this.prFailed
        ? (this.prSucceeded ? "stale" : "unavailable")
        : (this.prSucceeded ? "ready" : "loading");
    return {
      state,
      home: this.base.home,
      generatedAt: this.base.generatedAt,
      inFlight: this.base.inFlight.map(attach),
      decisions: this.base.decisions.map(attach),
      gates: this.base.gates.map(attach),
      landed: this.base.landed,
      prState,
      ...(this.prSummary !== null ? { prSummary: this.prSummary } : {}),
      prs: this.prs.map((pr) => {
        const endpoint = endpoints.get(pr.task);
        return endpoint ? { ...pr, endpoint } : pr;
      }),
    };
  }
}

export function resolveEndpoints(
  candidates: EndpointCandidate[],
  registry: SessionRegistry,
): Map<string, { session: string; paneId: string }> {
  const resolved = new Map<string, { session: string; paneId: string }>();
  for (const candidate of candidates) {
    if (candidate.backend !== "herdr") continue;
    const colon = candidate.target.indexOf(":");
    if (colon <= 0 || colon === candidate.target.length - 1) continue;
    const session = candidate.target.slice(0, colon);
    const paneId = candidate.target.slice(colon + 1);
    const runtime = registry.get(session);
    if (!runtime || runtime.name !== session) continue;
    const snapshot = runtime.engine.current();
    if (snapshot.bridge !== "connected") continue;
    if (![...snapshot.agents, ...snapshot.shellPanes].some((pane) => pane.paneId === paneId)) continue;
    resolved.set(candidate.id, { session, paneId });
  }
  return resolved;
}
