import { HERDR_MUX } from "../bridge/mux/herdr/adapter.ts";
import { HERDR_CORE_MUX, herdrCoreSocketFor } from "../bridge/mux/herdr-core/adapter.ts";
import { HC_GENERATION, readHcCore, type HcCoreReading } from "../bridge/mux/herdr-core/client.ts";
import { DURABLE_MUX } from "../bridge/mux/durable/adapter.ts";
import { buildMuxRegistry, muxEndpointVar, muxNames } from "../bridge/mux/registry.ts";
import { TERN_MUX } from "../bridge/mux/tern/adapter.ts";
import { defaultTernSocket, resolveTernBinary, ternBinaryCandidates } from "../bridge/mux/tern/exec.ts";
import { TMUX_MUX } from "../bridge/mux/tmux/adapter.ts";
import { resolveTmuxBinary, tmuxServerArgs, tmuxServerLabel } from "../bridge/mux/tmux/exec.ts";
import { TUIOS_MUX } from "../bridge/mux/tuios/adapter.ts";
import { defaultTuiosSocket } from "../bridge/mux/tuios/client.ts";
import { ZELLIJ_MUX } from "../bridge/mux/zellij/adapter.ts";
import { resolveZellijBinary, zellijBinaryCandidates } from "../bridge/mux/zellij/exec.ts";
import { parseSessionList, ZELLIJ_LIST_SESSIONS_ARGS } from "../bridge/mux/zellij/protocol.ts";
import { liveHookTargets } from "./beacon.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import type { Exec, Files } from "./sys.ts";

// `collie mux list` (M76 spec 02): every multiplexer this build knows, which of them this machine
// has, which Collie instance drives each, and the start command for one nobody drives.
//
// ── WHERE EACH COLUMN COMES FROM ─────────────────────────────────────────────
// • The ROWS come from the mux registry, never from a list written here. A new adapter is a new row;
//   what it lacks, until someone writes it a probe below, is a presence answer, and the row says so.
// • PRESENT comes from read-only probes, each bounded by {@link PROBE_MS}, run side by side. They are
//   the probes `collie start` and `collie doctor` already make (`cli/mux.ts`, `cli/herdr-core-findings.ts`),
//   not new ones: a socket file, a binary, `tmux list-sessions`, `zellij list-sessions`, and the one
//   dial there is, the herdr-core `hello`. A dial that does not answer in time reads as "present, not
//   answering". Nothing here writes to a core or a TUI, and nothing starts a multiplexer.
// • DRIVEN BY comes from the live hook target records (`bridge/beacon/hook-targets.ts`), one per
//   running bridge, so no bridge is dialled. A record whose pid is gone is removed by the same reader
//   the beacon emitter uses (`liveHookTargets`), and a bridge of an older build has no `mux` field.
//   It cannot be placed in a row, so it is listed under the table with `?` where it is unknown.

/** How long one presence probe may take. */
export const PROBE_MS = 500;

/** What a probe saw of one multiplexer on this machine. */
export interface Presence {
  readonly present: boolean;
  /** Whether the thing answered when asked. `null` when the probe only looks for a file and asks nothing. */
  readonly answering: boolean | null;
  /** The socket path or the binary, in the adapter's own words. Empty when there is nothing to name. */
  readonly where: string;
  readonly version: string | null;
}

/** Which bridge drives a multiplexer. `instance` and `port` are null for a record without them. */
export interface Driver {
  readonly instance: string | null;
  readonly port: number | null;
  readonly pid: number;
}

/** One row of the table, and one element of `rows` in `--json`. The shape is pinned by `cli/mux-list.test.ts`. */
export interface MuxRow {
  readonly mux: string;
  /** `terminal` for a multiplexer, `program` for `durable`, which is a program and has nothing to probe. */
  readonly kind: "terminal" | "program";
  readonly present: boolean;
  /** `true`, `false`, or `null` when the probe asks nothing (a socket file, a binary). */
  readonly answering: boolean | null;
  readonly where: string;
  readonly version: string | null;
  readonly drivenBy: readonly Driver[];
  /** The same drivers as one string, `next (8788), hc (8794)`; `?` marks a missing field; empty when nobody drives. */
  readonly drivenByText: string;
  /** The command that starts an instance on this multiplexer. Empty unless it is present and nobody drives it. */
  readonly hint: string;
}

/** What `--json` prints. */
export interface MuxListReport {
  readonly rows: readonly MuxRow[];
  /** Live bridges whose record names no multiplexer this build knows (an older build wrote it). */
  readonly unplaced: readonly (Driver & { readonly mux: string | null })[];
}

/** The seams the verb reads the world through. */
export interface MuxListDeps {
  readonly ctx: CliContext;
  readonly io: Io;
  readonly exec: Exec;
  readonly files: Files;
  readonly uid?: number | undefined;
  /** The herdr-core dial. Absent means the real one. */
  readonly dial?: ((socketPath: string, timeoutMs: number) => Promise<HcCoreReading>) | undefined;
}

type Probe = (deps: MuxListDeps) => Promise<Presence>;

const absent = (where = ""): Presence => ({ present: false, answering: null, where, version: null });

/** Races a probe against {@link PROBE_MS}: a probe that outlives it reads as present, not answering. */
async function within<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), PROBE_MS);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

const probeHerdr: Probe = async (deps) => {
  const socket = deps.ctx.socket;
  if (!deps.files.exists(socket)) return absent();
  const asked = deps.exec.capture("herdr", ["--version"], PROBE_MS);
  const line = asked.found && asked.code === 0 ? (asked.stdout.split("\n")[0]?.trim() ?? "") : "";
  return { present: true, answering: null, where: socket, version: line === "" ? null : line };
};

const probeHerdrCore: Probe = async (deps) => {
  const socket = herdrCoreSocketFor((deps.ctx.env[muxEndpointVar(HERDR_CORE_MUX)] ?? "").trim(), deps.ctx.env);
  if (!deps.files.exists(socket)) return absent();
  const silent: Presence = { present: true, answering: false, where: socket, version: null };
  const dial = deps.dial ?? readHcCore;
  const reading = await within(
    dial(socket, PROBE_MS).catch(() => null),
    null,
  );
  if (reading === null) return silent;
  // A core of another protocol generation answers, but this Collie cannot drive it. The doctor row
  // says so in full; the list says it in the version cell.
  const version = reading.generation === HC_GENERATION ? reading.version : `${reading.version} (generation ${String(reading.generation)})`;
  return { present: true, answering: true, where: socket, version };
};

const probeTmux: Probe = async (deps) => {
  const binary = resolveTmuxBinary((deps.ctx.env.COLLIE_TMUX_BIN ?? "").trim(), (path) => deps.files.exists(path));
  if (binary === null) return absent();
  const endpoint = (deps.ctx.env[muxEndpointVar(TMUX_MUX)] ?? "").trim();
  // `list-sessions` against a server that is not there exits non-zero and starts nothing.
  const asked = deps.exec.capture(binary, [...tmuxServerArgs(endpoint), "list-sessions", "-F", "#{session_name}"], PROBE_MS);
  if (!asked.found || asked.code !== 0) return absent(`${binary}, no server running on ${tmuxServerLabel(endpoint)}`);
  const sessions = asked.stdout.split("\n").filter((line) => line.trim() !== "").length;
  return {
    present: true,
    answering: true,
    where: `${binary}, ${tmuxServerLabel(endpoint)}, ${String(sessions)} session${sessions === 1 ? "" : "s"}`,
    version: null,
  };
};

const probeZellij: Probe = async (deps) => {
  const binary = resolveZellijBinary(
    (deps.ctx.env.COLLIE_ZELLIJ_BIN ?? "").trim(),
    (path) => deps.files.exists(path),
    zellijBinaryCandidates(deps.ctx.home),
  );
  if (binary === null) return absent();
  const asked = deps.exec.capture(binary, [...ZELLIJ_LIST_SESSIONS_ARGS], PROBE_MS);
  // A box with no sessions exits non-zero and explains itself on stderr; that is not a listing.
  const running = parseSessionList(asked.found && asked.code === 0 ? asked.stdout : "").filter((session) => session.running);
  if (running.length === 0) return absent(`${binary}, no session running`);
  return {
    present: true,
    answering: true,
    where: `${binary}, ${String(running.length)} running session${running.length === 1 ? "" : "s"}: ${running.map((session) => session.name).join(", ")}`,
    version: null,
  };
};

const probeTern: Probe = async (deps) => {
  const uid = deps.uid ?? process.getuid?.() ?? 1000;
  const socket = defaultTernSocket(deps.ctx.env.XDG_RUNTIME_DIR, uid);
  if (deps.files.exists(socket)) return { present: true, answering: null, where: socket, version: null };
  const binary = resolveTernBinary((deps.ctx.env.COLLIE_TERN_BIN ?? "").trim(), (path) => deps.files.exists(path), ternBinaryCandidates(deps.ctx.home));
  return binary === null ? absent() : absent(`${binary}, no daemon socket at ${socket}`);
};

const probeTuios: Probe = async (deps) => {
  const uid = deps.uid ?? process.getuid?.() ?? 1000;
  const named = (deps.ctx.env[muxEndpointVar(TUIOS_MUX)] ?? "").trim();
  const socket = named === "" ? defaultTuiosSocket(deps.ctx.env.XDG_RUNTIME_DIR, uid) : named;
  return deps.files.exists(socket) ? { present: true, answering: null, where: socket, version: null } : absent();
};

/** The probe per multiplexer. A registry entry with no probe here reads as "no probe in this build". */
const PROBES: ReadonlyMap<string, Probe> = new Map([
  [HERDR_MUX, probeHerdr],
  [HERDR_CORE_MUX, probeHerdrCore],
  [TMUX_MUX, probeTmux],
  [ZELLIJ_MUX, probeZellij],
  [TERN_MUX, probeTern],
  [TUIOS_MUX, probeTuios],
]);

/** Shown for `durable`, which is not a terminal and has nothing to look for. */
export const PROGRAM_NOTE = "a program, not a terminal";

const PLACEHOLDER = "?";

/** `next (8788)`, `? (8788)`, `next`, or `?` where the record names neither. */
function driverText(driver: Driver): string {
  const name = driver.instance ?? PLACEHOLDER;
  return driver.port === null ? name : `${name} (${String(driver.port)})`;
}

/**
 * The command that starts a bridge on `mux`. `collie start` takes no flags for this: the instance
 * is `COLLIE_INSTANCE`, its port `COLLIE_PORT`, the multiplexer `COLLIE_MUX`, and `start` writes the
 * multiplexer into the instance's `.env` (`cli/mux.ts`). On a machine where no bridge runs yet the
 * host's first Collie needs only the multiplexer; once one runs, another needs its own name and port
 * (`resolveInstance` refuses a named instance without a port).
 */
export function startHint(mux: string, othersRunning: boolean): string {
  return othersRunning ? `COLLIE_INSTANCE=<name> COLLIE_PORT=<port> COLLIE_MUX=${mux} collie start` : `COLLIE_MUX=${mux} collie start`;
}

/** The report: probes side by side, then the live bridges laid over the rows. */
export async function muxListReport(deps: MuxListDeps): Promise<MuxListReport> {
  // `durable` last: it is the one row that is not a terminal.
  const names = muxNames(buildMuxRegistry()).toSorted((a, b) => Number(a === DURABLE_MUX) - Number(b === DURABLE_MUX));
  const seen = await Promise.all(
    names.map(async (mux): Promise<Presence> => {
      if (mux === DURABLE_MUX) return absent(PROGRAM_NOTE);
      const probe = PROBES.get(mux);
      if (probe === undefined) return absent("no presence probe for this multiplexer in this build");
      // The fallback is the race's: a probe that overran is present and not answering. A probe that
      // threw is the same, because something was there to be asked.
      return await within(probe(deps), { present: true, answering: false, where: "", version: null }).catch(
        (): Presence => ({ present: true, answering: false, where: "", version: null }),
      );
    }),
  );

  const targets = liveHookTargets({ ctx: deps.ctx, files: deps.files, uid: deps.uid });
  const driversOf = (mux: string): Driver[] =>
    targets.filter((target) => target.mux === mux).map((target) => ({ instance: target.instance, port: target.port, pid: target.pid }));
  const unplaced = targets
    .filter((target) => target.mux === null || !names.includes(target.mux))
    .map((target) => ({ mux: target.mux, instance: target.instance, port: target.port, pid: target.pid }));

  const rows = names.map((mux, index): MuxRow => {
    const presence = seen[index] ?? absent();
    const drivenBy = driversOf(mux);
    const program = mux === DURABLE_MUX;
    // A bridge that drives a multiplexer is proof it is here, even when the probe, which looks at the
    // default endpoint only, found nothing (a tmux server on a socket the instance names itself).
    const present = !program && (presence.present || drivenBy.length > 0);
    return {
      mux,
      kind: program ? "program" : "terminal",
      present,
      answering: presence.answering,
      where: presence.where,
      version: presence.version,
      drivenBy,
      drivenByText: drivenBy.map(driverText).join(", "),
      hint: present && drivenBy.length === 0 ? startHint(mux, targets.length > 0) : "",
    };
  });
  return { rows, unplaced };
}

/** The PRESENT cell. */
function presentCell(row: MuxRow): string {
  if (row.kind === "program") return PROGRAM_NOTE;
  if (!row.present) return "no";
  return row.answering === false ? "yes, not answering" : "yes";
}

/** The table, as lines. Columns are padded to their widest cell; the last one is not. */
export function renderMuxTable(report: MuxListReport): string[] {
  const body = report.rows.map((row) => [row.mux, presentCell(row), row.drivenByText === "" ? "-" : row.drivenByText, row.hint]);
  const table = [["MUX", "PRESENT", "DRIVEN BY", "HINT"], ...body];
  const widths = [0, 1, 2].map((col) => Math.max(...table.map((cells) => cells[col]?.length ?? 0)));
  const lines = table.map((cells) =>
    [...widths.map((width, col) => (cells[col] ?? "").padEnd(width)), cells[3] ?? ""].join("  ").trimEnd(),
  );
  const details = report.rows.filter((row) => row.kind === "terminal" && row.where !== "").map((row) => {
    const version = row.version === null ? "" : `, ${row.version}`;
    return `  ${row.mux}: ${row.where}${version}`;
  });
  const extra: string[] = [];
  if (details.length > 0) extra.push("", "Where:", ...details);
  if (report.unplaced.length > 0) {
    extra.push(
      "",
      "Also running, on no multiplexer this list knows (an older build does not say which):",
      ...report.unplaced.map((driver) => `  ${driverText(driver)}, pid ${String(driver.pid)}${driver.mux === null ? "" : `, mux ${driver.mux}`}`),
    );
  }
  if (report.rows.some((row) => row.hint.includes("<name>"))) {
    extra.push("", "A second instance needs its own config first: see \"Multiple Collie instances on one host\" in the deployment guide.");
  }
  return [...lines, ...extra];
}

/** `collie mux list [--json]`. */
export async function cmdMuxList(deps: MuxListDeps, args: readonly string[] = []): Promise<number> {
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown !== undefined) {
    deps.io.err(`error: unknown option \`${unknown}\``);
    deps.io.err("usage: collie mux list [--json]");
    return EXIT.USAGE;
  }
  const report = await muxListReport(deps);
  if (args.includes("--json")) {
    deps.io.out(JSON.stringify(report));
    return EXIT.OK;
  }
  for (const line of renderMuxTable(report)) deps.io.out(line);
  return EXIT.OK;
}

/** The sub-verbs of `mux`, in the order `collie help` names them. */
export const MUX_SUBCOMMANDS = ["list"] as const;

/** A bare `mux` prints the same list: the verb has one sub-verb, and the list is what was asked. A misspelt sub-verb is a usage error. */
export function cmdMux(deps: MuxListDeps, args: readonly string[]): Promise<number> | number {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--json") return cmdMuxList(deps, args);
  if (sub === "list") return cmdMuxList(deps, rest);
  deps.io.err(`error: unknown mux subcommand \`${sub}\``);
  deps.io.err("usage: collie mux [list] [--json]");
  deps.io.err("  list   every multiplexer this build knows, which are here, who drives each, and how to start one");
  return EXIT.USAGE;
}
