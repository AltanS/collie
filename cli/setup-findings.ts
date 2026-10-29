import { join } from "node:path";

import { binaryName, type Host } from "../bridge/host.ts";
import { DURABLE_MUX } from "../bridge/mux/durable/adapter.ts";
import { HERDR_CORE_MUX } from "../bridge/mux/herdr-core/adapter.ts";
import { buildMuxRegistry, DEFAULT_MUX, factoryFor, muxEndpointVar, muxNames } from "../bridge/mux/registry.ts";
import { TMUX_MUX, TMUX_VERSION_ARGS } from "../bridge/mux/tmux/adapter.ts";
import { resolveTmuxBinary, TMUX_BINARY_CANDIDATES, tmuxServerArgs, tmuxServerLabel } from "../bridge/mux/tmux/exec.ts";
import { ZELLIJ_MUX } from "../bridge/mux/zellij/adapter.ts";
import { resolveZellijBinary, zellijBinaryCandidates } from "../bridge/mux/zellij/exec.ts";
import { chooseSession, parseSessionList, ZELLIJ_LIST_SESSIONS_ARGS } from "../bridge/mux/zellij/protocol.ts";
import { envGet } from "../bridge/tools.ts";
import type { CliContext } from "./context.ts";
import { bad, ok, skipped, warn, type Finding } from "./finding.ts";
import { publishedBinary } from "./install-kind.ts";
import { classifyLink, linkDir, linkPath, type LinkReader } from "./link.ts";
import { explicitMux, probeMuxes, refusedMux, type MuxSighting } from "./mux.ts";
import { crewModeOnDisk } from "./serve.ts";
import type { Exec, Files } from "./sys.ts";
import {
  certDomains,
  HTTPS_DISABLED_HINT,
  NO_CERTIFICATES_HTTP_HINT,
  readTailscale,
  selfDnsName,
  TAILSCALE_PROBE_MS,
  type TailscaleState,
} from "./tailnet.ts";

// The setup check: what a machine needs before `collie start` can put Collie on a phone, in words an
// operator who never read the docs understands. `collie start` prints the rows that are not fine,
// and `collie doctor` prints all of them among its own (2026-10-28).
//
// FIVE QUESTIONS. Is Tailscale installed and signed in; does the tailnet give this machine a name
// and HTTPS certificates; may this user change the serve config (Linux); which multiplexer; and can
// the shell find `collie`. The last two are doctor's own `mux` and `path-link` checks, which live
// here now so that `start` and `doctor` run one function each, never two copies.
//
// READ-ONLY, BOUNDED, NEVER A PROMPT. Every `tailscale` call is a `capture` with a wall-clock bound
// ({@link TAILSCALE_PROBE_MS}), so a wedged tailscaled costs three seconds and not a hung `start`.
// The bound is the `Exec` seam's own, not `timeout(1)`: Windows has a `timeout.exe` that waits
// instead of bounding. Nothing here runs a tool on the operator's terminal, so nothing can ask.
//
// THE TAILSCALE ROWS ARE WARNINGS, NEVER ERRORS. `collie update --check` reads doctor's local errors
// as its red, and a red preflight turns the phone's Update button off (`cli/update-check.ts`,
// `doctorCheck`). A Tailscale that is down for a minute, or a tailnet without certificates, must not
// stop this machine from taking a release, so `tailscale`, `tailnet-https` and `tailscale-operator`
// say what is missing at `warn` at most. The `mux` row keeps its errors: without a multiplexer the
// bridge itself refuses to start, and that was doctor's verdict before this module existed.
//
// THE TAILSCALE ROWS FOLLOW THE PUBLISH DECISION. `cmdServe` publishes nothing under
// `COLLIE_SKIP_SERVE=1` (the operator owns the ingress) or on a crew peer (ADR 0013), so there these
// rows are `skipped` with that reason: a machine that never uses Tailscale has nothing to fix in it.

/** Where the setup check reaches the world. `DoctorDeps` and `LifecycleDeps` both fit it. */
export interface SetupDeps {
  readonly ctx: CliContext;
  readonly exec: Exec;
  readonly files: Files;
  /** The platform the remedies are written for (`bridge/host.ts`). */
  readonly host: Host;
  /** Reading the published PATH name. Absent means no `path-link` row. */
  readonly link?: LinkReader;
}

/** What the multiplexer check reads. */
export type MuxDeps = Pick<SetupDeps, "ctx" | "exec" | "files">;

// Defined in `./tailnet.ts` (the doctor and `url` paths bound their calls with it too).
export { TAILSCALE_PROBE_MS };

/**
 * Every setup row, in the order `start` prints them: the three Tailscale rows (two off Linux), then
 * `mux`, then `path-link` when a link reader is given.
 */
export function setupFindings(deps: SetupDeps): Finding[] {
  const rows = [...tailscaleFindings(deps), muxFinding(deps)];
  return deps.link === undefined ? rows : [...rows, pathLinkFinding({ ...deps, link: deps.link })];
}

/**
 * One row as `collie start` prints it, in two or more lines and with no arrow glyph (a legacy
 * Windows console prints `→` as garbage): `setup: <detail>`, then `  fix: <remedy>`. A command to
 * copy stands at the END of its line. A remedy with several actions puts each on its own indented
 * line: it splits at `; `, and a part with two commands splits again at `, then `. Doctor renders a
 * row its own way and does not use this.
 */
export function setupLines(f: Finding): string[] {
  const parts = (f.remedy ?? "")
    .split("; ")
    .flatMap((part) => ((part.match(/`/g) ?? []).length >= 4 ? part.split(/, (?=then )/) : [part]));
  const [first = "", ...rest] = parts;
  return [`setup: ${f.detail}`, `  fix: ${first}`, ...rest.map((part) => `       ${part}`)];
}

/**
 * The sentence `collie start` prints on stderr AFTER the status banner when a Tailscale row is open
 * ({@link phoneBlocked}). Before the banner it read as "stopped"; after it, the bridge is plainly up
 * and the phone is not. A `path-link` or `mux` row alone does not earn it: those print, and the phone
 * still reaches the door.
 */
export const SETUP_CLOSING =
  "Running, but your phone cannot reach it yet. Fix the setup lines above, then run collie start again. collie doctor repeats this check.";

// ── Tailscale ────────────────────────────────────────────────────────────────

/** The user name a remedy can name, or the shell's `$USER` when the environment does not say. */
function userName(deps: Pick<SetupDeps, "ctx">): string | null {
  const name = (deps.ctx.env.USER ?? deps.ctx.env.LOGNAME ?? "").trim();
  return name === "" ? null : name;
}

const isLinux = (host: Host): boolean => host.platform === "linux";

/** Appended to every "no tailscale" remedy: the way out for a machine that never uses Tailscale. */
const SKIP_SERVE_OUT = "; if you do not use Tailscale, set COLLIE_SKIP_SERVE=1 (docs/deployment.md Variant E)";

function installRemedy(deps: SetupDeps): string {
  const host = deps.host.platform;
  if (host === "darwin") {
    // The App Store build keeps its command line tool inside the app bundle until the app's setting
    // links it, so "no `tailscale` on PATH" can also mean "installed, command not turned on".
    return `install Tailscale from tailscale.com/download, then turn on the \`tailscale\` command in the app's settings${SKIP_SERVE_OUT}`;
  }
  if (!isLinux(deps.host)) return `install Tailscale from tailscale.com/download and sign in${SKIP_SERVE_OUT}`;
  return (
    "install it with `curl -fsSL https://tailscale.com/install.sh | sh`, then sign in with" +
    ` \`sudo tailscale up --operator=${userName(deps) ?? "$USER"}\`${SKIP_SERVE_OUT}`
  );
}

function upRemedy(deps: SetupDeps): string {
  if (!isLinux(deps.host)) return "open the Tailscale app and sign in, or run `tailscale up`";
  return `sign in with \`sudo tailscale up --operator=${userName(deps) ?? "$USER"}\``;
}

/** Why the Tailscale rows have nothing to say on this machine, or null when they do. */
function tailscaleNotUsed(deps: SetupDeps): { detail: string; remedy: string } | null {
  if (deps.ctx.env.COLLIE_SKIP_SERVE === "1") {
    return {
      detail: "COLLIE_SKIP_SERVE=1, so you run your own front door and Collie does not use Tailscale",
      remedy: "nothing to do; unset COLLIE_SKIP_SERVE to let `collie start` publish with Tailscale",
    };
  }
  if (crewModeOnDisk(deps) === "peer") {
    return {
      detail: "this collie is a crew peer, and a peer publishes no front door",
      remedy: "nothing to do; the lead's front door serves the crew (`collie crew status` names the lead)",
    };
  }
  return null;
}

/** A row after `tailscale` while Tailscale itself is not running: it cannot be asked yet. */
const notYet = (check: string): Finding =>
  skipped(check, "Tailscale is not running here, so this cannot be checked yet", "fix the tailscale line first, then run `collie doctor` again");

/**
 * The check names of the Tailscale rows, in print order: `tailscale`, `tailnet-https`, and on Linux
 * `tailscale-operator`. These are the rows that decide whether a phone can reach the front door.
 */
export function reachabilityChecks(host: Host): readonly string[] {
  return isLinux(host) ? ["tailscale", "tailnet-https", "tailscale-operator"] : ["tailscale", "tailnet-https"];
}

/**
 * Does an open Tailscale row stand between the phone and the front door? `mux` and `path-link` are
 * setup rows too, but neither one is about the phone: a missing PATH link leaves a door that works.
 */
export function phoneBlocked(findings: readonly Finding[], host: Host): boolean {
  const checks = reachabilityChecks(host);
  return findings.some((f) => checks.includes(f.check) && (f.status === "warn" || f.status === "error"));
}

/** The `tailscale`, `tailnet-https` and (Linux only) `tailscale-operator` rows. */
export function tailscaleFindings(deps: SetupDeps): Finding[] {
  const checks = reachabilityChecks(deps.host);
  const unused = tailscaleNotUsed(deps);
  if (unused !== null) return checks.map((check) => skipped(check, unused.detail, unused.remedy));

  const state = readTailscale(deps.exec);
  const first = tailscaleRow(deps, state);
  if (state.kind !== "running") return [first, ...checks.slice(1).map(notYet)];
  const rows = [first, httpsRow(deps, state.json)];
  return isLinux(deps.host) ? [...rows, operatorRow(deps)] : rows;
}

function tailscaleRow(deps: SetupDeps, state: TailscaleState): Finding {
  switch (state.kind) {
    case "absent":
      return warn("tailscale", "no `tailscale` command was found on PATH", installRemedy(deps));
    case "down": {
      const said = state.state === null ? "" : ` (it reports ${state.state})`;
      return warn("tailscale", `Tailscale is installed but not signed in or not running${said}`, upRemedy(deps));
    }
    case "slow":
      return warn(
        "tailscale",
        `Tailscale did not answer within ${TAILSCALE_PROBE_MS / 1000} seconds`,
        "run `tailscale status` by hand; when it answers, run `collie start` again",
      );
    case "unreadable":
      return skipped(
        "tailscale",
        "`tailscale status --json` answered with something this build cannot read",
        "run `tailscale status` and check that it says you are signed in",
      );
    case "running": {
      const name = selfDnsName(state.json);
      return ok("tailscale", name === null ? "running and signed in" : `running and signed in, this machine is ${name}`);
    }
  }
}

/**
 * MagicDNS, then the certificates. A missing `Self.DNSName` is the old signal for MagicDNS off;
 * `CurrentTailnet.MagicDNSEnabled: false` is the explicit one newer builds write, and its absence
 * changes nothing.
 */
function httpsRow(deps: SetupDeps, json: string): Finding {
  const name = selfDnsName(json);
  if (name === null || magicDnsDisabled(json)) {
    return warn(
      "tailnet-https",
      "MagicDNS is off, so this machine has no tailnet name",
      "turn on MagicDNS in the Tailscale admin console, DNS page (https://login.tailscale.com/admin/dns), then run `collie start` again",
    );
  }
  // An operator who chose http needs no certificate, and is told once here rather than on every
  // `start`: a skipped row does not print there.
  if (deps.ctx.serveMode === "http") {
    return skipped(
      "tailnet-https",
      "http mode chosen, so no certificate is needed; the phone cannot install Collie to the home screen over http",
      "nothing to do; unset COLLIE_SERVE_MODE once your tailnet has HTTPS certificates, then run `collie start`",
    );
  }
  const domains = certDomains(json);
  if (domains === null) {
    return skipped("tailnet-https", "could not read the certificate setting", "run `tailscale status --json` and look for CertDomains");
  }
  if (domains.length === 0) {
    return warn("tailnet-https", "HTTPS certificates are off for your tailnet", `${HTTPS_DISABLED_HINT}; ${NO_CERTIFICATES_HTTP_HINT}`);
  }
  return ok("tailnet-https", `MagicDNS name ${name}, HTTPS certificates on`);
}

function magicDnsDisabled(json: string): boolean {
  try {
    // SAFETY: only an explicit boolean `false` is read; any other shape is "not disabled".
    const data = JSON.parse(json) as { CurrentTailnet?: { MagicDNSEnabled?: unknown } | null };
    return data.CurrentTailnet?.MagicDNSEnabled === false;
  } catch {
    return false;
  }
}

/**
 * Linux only: may this user change the serve config? On Linux tailscaled lets root and the one
 * `--operator` user write it, and refuses everyone else with "Access denied". Reading the config is
 * allowed to every user, so a `serve status` that answers proves little; the operator named in
 * `tailscale debug prefs` is the stronger hint, and a mismatch there is a warning, never an error,
 * because a tailscaled the user runs as themselves lets them write without the setting.
 */
function operatorRow(deps: SetupDeps): Finding {
  const user = userName(deps);
  const fix = `\`sudo tailscale set --operator=${user ?? "$USER"}\``;
  if (user === "root") return ok("tailscale-operator", "running as root, which may change the serve config");
  const r = deps.exec.capture("tailscale", ["serve", "status"], TAILSCALE_PROBE_MS);
  if (r.code !== 0) {
    const said = `${r.stdout}\n${r.stderr}`;
    if (/access denied|operator/i.test(said)) {
      return warn("tailscale-operator", "your user may not run tailscale serve", fix);
    }
    return skipped(
      "tailscale-operator",
      `\`tailscale serve status\` failed: ${firstLine(said)}`,
      "run `tailscale serve status` by hand and fix what it says",
    );
  }
  const operator = prefsOperator(deps.exec);
  if (user !== null && operator !== null && operator !== user) {
    return warn(
      "tailscale-operator",
      operator === ""
        ? `no Tailscale operator is set, so tailscale serve may refuse ${user}`
        : `the Tailscale operator is ${operator}, not ${user}, so tailscale serve may refuse ${user}`,
      fix,
    );
  }
  return ok(
    "tailscale-operator",
    operator !== null && operator === user ? `${user} is the Tailscale operator` : "tailscale serve answers this user",
  );
}

/** `OperatorUser` from `tailscale debug prefs`, `""` when unset, or null when it cannot be read. */
function prefsOperator(exec: Exec): string | null {
  const r = exec.capture("tailscale", ["debug", "prefs"], TAILSCALE_PROBE_MS);
  if (!r.found || r.code !== 0) return null;
  try {
    // SAFETY: the field is only stringified and compared with a user name, never trusted further;
    // a document that is not an object throws inside this `try` and reads as "cannot tell".
    const value = (JSON.parse(r.stdout) as { OperatorUser?: unknown }).OperatorUser;
    if (value === undefined || value === null) return "";
    return String(value).trim();
  } catch {
    return null;
  }
}

// ── The name on PATH ─────────────────────────────────────────────────────────

/** The profile line `scripts/install.sh` prints when `~/.local/bin` is not on PATH. One copy. */
export const PATH_PROFILE_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

const POSIX_PATH_REMEDY = `add this line to ~/.zshrc or ~/.bashrc, then open a new terminal: ${PATH_PROFILE_LINE}`;

/** Whether any PATH entry holds a `collie` (`collie.exe` on Windows). Split and looked up, never searched further. */
function collieOnPath(deps: Pick<SetupDeps, "ctx" | "files" | "host">): boolean {
  const { path } = deps.host;
  const raw = envGet(deps.ctx.env, "PATH", deps.host) ?? "";
  return raw
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir !== "" && path.isAbsolute(dir))
    .some((dir) => deps.files.exists(path.join(dir, binaryName(deps.host))));
}

/** A PATH entry as compared: no surrounding space, no trailing separator. */
const pathEntry = (d: string): string => d.trim().replace(/[/\\]+$/, "");

/** Whether `dir` is a PATH entry, compared with this host's separator and no trailing slash. */
function dirOnPath(deps: Pick<SetupDeps, "ctx" | "host">, dir: string): boolean {
  const raw = envGet(deps.ctx.env, "PATH", deps.host) ?? "";
  return raw.split(deps.host.path.delimiter).some((entry) => entry.trim() !== "" && pathEntry(entry) === pathEntry(dir));
}

/**
 * The name on PATH (`collie link`, ADR 0021). Not being linked is a good state when a `collie` on
 * PATH runs anyway (a package's own name, the Windows installer's PATH entry), so that reads `ok`
 * and merely names what would publish it. A fresh install where no `collie` is on PATH at all warns,
 * with the one line to add. What else is worth a warning is a name that exists and does NOT reach
 * this checkout: another instance's link, or something Collie never published. The verdict comes
 * from `classifyLink`, the same pure function `link` decides on, so `doctor` cannot disagree with
 * the verb about what it is looking at.
 */
export function pathLinkFinding(deps: Pick<SetupDeps, "ctx" | "files" | "host"> & { readonly link: LinkReader }): Finding {
  const at = linkPath(deps.ctx.home);
  const own = publishedBinary(deps.ctx.root, deps.link, deps.host);
  const verdict = classifyLink(deps.link.probe(at), own);
  switch (verdict.action) {
    case "create": {
      if (collieOnPath(deps)) return ok("path-link", `not linked — \`collie link\` would publish ${at} → ${own}`);
      if (deps.host.platform === "win32") {
        const dir = deps.host.path.dirname(own);
        return warn(
          "path-link",
          "no `collie` is on PATH, so typing `collie` in a new terminal does not run it",
          `add ${dir} to your user PATH (Settings, "Edit environment variables for your account"), then open a new terminal and run \`collie doctor\``,
        );
      }
      const dir = linkDir(deps.ctx.home);
      return warn(
        "path-link",
        "no `collie` is on PATH, so typing `collie` in a new terminal does not run it",
        dirOnPath(deps, dir) ? "run `collie link`" : `run \`collie link\`, then ${POSIX_PATH_REMEDY}`,
      );
    }
    case "keep": {
      const dir = linkDir(deps.ctx.home);
      if (!dirOnPath(deps, dir)) {
        return warn(
          "path-link",
          `${at} → ${own} (this checkout), but ${dir} is not on PATH — the name is published and the shell cannot find it`,
          POSIX_PATH_REMEDY,
        );
      }
      return ok("path-link", `${at} → ${own} (this checkout)`);
    }
    case "replace":
      return warn(
        "path-link",
        `${at} → ${verdict.previous} — a DIFFERENT checkout owns the name, so a bare \`collie\` runs that one`,
        "`collie link` here to take it over, or leave it to that instance",
      );
    case "refuse":
      return warn(
        "path-link",
        `${at} is ${verdict.reason} — Collie will not touch it`,
        `move it aside yourself, then \`collie link\``,
      );
  }
}

// ── Which multiplexer this collie drives, and whether it is answering ────────
//
// THE PROBE IS A READ AND STAYS ONE. `tmux list-sessions` and `zellij list-sessions` are the two
// cheapest questions each multiplexer answers, and neither of them starts a server, attaches a
// client or creates a session — `doctor` never brings a multiplexer up, because a server this verb
// started is evidence it manufactured.
//
// EVERY NAME COMES FROM THE REGISTRY. The valid mux names, the endpoint variable and the per-adapter
// binary resolution are all imported from `bridge/mux/` rather than restated here, so a fourth
// multiplexer cannot leave this file quietly reporting a stale set. What is written out per mux —
// the argv of the liveness probe — is exactly what cannot be shared: each one has its own CLI.
//
// Moved here from `cli/doctor.ts` on 2026-10-28, unchanged, so `collie start` runs the same check.

/**
 * What decided the multiplexer this collie drives — the other half of the `mux` line since M14/03.
 *
 * `undecided` is a real state and not an error state to hide: with no `COLLIE_MUX` and no single
 * multiplexer running, `collie start` REFUSES, and a doctor that reported a cheerful "herdr" for that
 * host would be reporting a bridge that is never going to come up.
 */
type MuxOrigin =
  | { readonly kind: "explicit" }
  | { readonly kind: "auto"; readonly evidence: string }
  | { readonly kind: "undecided"; readonly found: readonly MuxSighting[] };

/** The mux settings, read from the CLI's merged env exactly as `bridge/config.ts` reads them. */
export interface MuxSettings {
  readonly name: string;
  readonly endpoint: string;
  readonly tmuxBin: string;
  readonly zellijBin: string;
  readonly ternBin: string;
  readonly origin: MuxOrigin;
}

/**
 * `COLLIE_MUX` and the endpoint it addresses, resolved as `collie start` resolves them.
 *
 * Herdr's endpoint IS the Herdr socket path (`bridge/config.ts`), so it comes from the context that
 * already resolved `HERDR_SOCKET_PATH` — the same value `herdr-socket` probes, which is why the
 * `mux` line defers to that check instead of stating a path twice.
 *
 * With nothing configured this asks `cli/mux.ts`'s probe rather than falling to `DEFAULT_MUX`, so
 * `doctor` names the multiplexer the next `start` would actually pick, and the evidence for it. The
 * probe is a read (see that module's header); running it costs one listing per installed adapter.
 */
export function muxSettings(deps: MuxDeps): MuxSettings {
  const env = deps.ctx.env;
  const tmuxBin = (env.COLLIE_TMUX_BIN ?? "").trim();
  const zellijBin = (env.COLLIE_ZELLIJ_BIN ?? "").trim();
  const ternBin = (env.COLLIE_TERN_BIN ?? "").trim();
  const named = explicitMux(env);
  if (named !== null) {
    return {
      name: named,
      endpoint: named === DEFAULT_MUX ? deps.ctx.socket : (env[muxEndpointVar(named)] ?? "").trim(),
      tmuxBin,
      zellijBin,
      ternBin,
      origin: { kind: "explicit" },
    };
  }
  const found = probeMuxes(deps);
  const only = found.length === 1 ? found[0] : undefined;
  if (only === undefined) {
    return { name: DEFAULT_MUX, endpoint: "", tmuxBin, zellijBin, ternBin, origin: { kind: "undecided", found } };
  }
  return {
    name: only.mux,
    endpoint: only.mux === DEFAULT_MUX ? deps.ctx.socket : only.endpoint,
    tmuxBin,
    zellijBin,
    ternBin,
    origin: { kind: "auto", evidence: only.evidence },
  };
}

/** How the name was arrived at, appended to whatever the per-mux branch found. */
function originSuffix(origin: MuxOrigin): string {
  if (origin.kind === "explicit") return " · set by COLLIE_MUX";
  if (origin.kind === "auto") return ` · no COLLIE_MUX, so \`start\` picks it: ${origin.evidence}`;
  return "";
}

/**
 * `mux` — which multiplexer this collie drives, where it would look for it, and whether anything
 * answered there.
 *
 * An unreachable multiplexer is an `error` and not a warning: it is not a degraded Collie, it is a
 * Collie with no panes at all, and the symptom an operator sees first is an empty home screen or the
 * disconnected banner — neither of which names the socket, the session or the binary.
 */
export function muxFinding(deps: MuxDeps): Finding {
  const settings = muxSettings(deps);
  const registry = buildMuxRegistry();
  if (settings.origin.kind === "undecided") {
    const { detail, remedy } = refusedMux(settings.origin.found, deps.ctx.configDir, deps.ctx.env);
    return bad("mux", `${detail}, so \`collie start\` refuses`, remedy);
  }
  if (factoryFor(registry, settings.name) === undefined) {
    return bad(
      "mux",
      `COLLIE_MUX="${settings.name}" is not a multiplexer this build drives, so the bridge refuses to start`,
      `set COLLIE_MUX to one of ${muxNames(registry).join(", ")} in ${join(deps.ctx.configDir, ".env")},` +
        " then `collie restart`",
    );
  }
  if (settings.name === DEFAULT_MUX) {
    return ok("mux", `${DEFAULT_MUX} — see herdr-socket${originSuffix(settings.origin)}`);
  }
  if (settings.name === TMUX_MUX) return tmuxMux(deps, settings);
  if (settings.name === ZELLIJ_MUX) return zellijMux(deps, settings);
  // A durable program is asked by the six `durable-*` rows (and `durable-lead` in a crew), so this
  // line defers to them as the Herdr line defers to `herdr-socket`.
  if (settings.name === DURABLE_MUX) return ok("mux", `${DURABLE_MUX}, see the durable-* lines${originSuffix(settings.origin)}`);
  // herdr-core is asked by its own two rows, `hc-socket` and `hc-version` (cli/herdr-core-findings.ts).
  if (settings.name === HERDR_CORE_MUX) return ok("mux", `${HERDR_CORE_MUX}, see hc-socket${originSuffix(settings.origin)}`);
  // Registered, and this verb has no probe for it. `skipped` rather than a pass, for the reason
  // `acl` gives: a check that could not run must never render as one that did.
  return skipped(
    "mux",
    `${settings.name} — registered, but \`collie doctor\` has no liveness probe for it`,
    `ask that multiplexer whether it is running, by hand; \`collie doctor\` reports ${TMUX_MUX} and ${ZELLIJ_MUX}`,
  );
}

/** The first non-empty line of a tool's complaint — a doctor line is one line. */
function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "it said nothing";
}

/**
 * tmux, in ONE invocation: the version and the session list, `;`-joined the way the adapter joins
 * its own listing (`bridge/mux/tmux/protocol.ts` § LISTING_ARGS). Neither command starts a server.
 */
function tmuxMux(deps: MuxDeps, settings: MuxSettings): Finding {
  const where = tmuxServerLabel(settings.endpoint);
  const dotenv = join(deps.ctx.configDir, ".env");
  const binary = resolveTmuxBinary(settings.tmuxBin, (p) => deps.files.exists(p));
  if (binary === null) {
    const why =
      settings.tmuxBin === ""
        ? `nothing executable at ${TMUX_BINARY_CANDIDATES.join(", ")}`
        : `COLLIE_TMUX_BIN="${settings.tmuxBin}" is not an absolute path to a file that is there`;
    return bad(
      "mux",
      `tmux — ${where}, and there is no tmux binary to run: ${why} (a Herdr plugin action gets no` +
        " login shell, so PATH is never consulted)",
      `install tmux, or set COLLIE_TMUX_BIN to its absolute path in ${dotenv}, then \`collie restart\``,
    );
  }
  const serverArgs = tmuxServerArgs(settings.endpoint);
  const asked = deps.exec.capture(binary, [
    ...serverArgs,
    ...TMUX_VERSION_ARGS,
    ";",
    "list-sessions",
    "-F",
    "#{session_name}",
  ]);
  if (!asked.found || asked.code !== 0) {
    const detail = asked.found ? firstLine(asked.stderr || asked.stdout) : `${binary} could not be run`;
    return bad(
      "mux",
      `tmux — ${binary} is there, but no server answered on ${where}: ${detail}`,
      `start one (\`tmux ${[...serverArgs, "new", "-d"].join(" ")}\`), or point ` +
        `${muxEndpointVar(TMUX_MUX)} at the server you already run, in ${dotenv}, then \`collie restart\``,
    );
  }
  // The version is the first line the joined invocation printed; every line after it is a session.
  const lines = asked.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const version = lines[0] ?? "?";
  const sessions = lines.length === 0 ? 0 : lines.length - 1;
  return ok(
    "mux",
    `tmux ${version} · ${where} · ${String(sessions)} session${sessions === 1 ? "" : "s"}` +
      originSuffix(settings.origin),
  );
}

/**
 * zellij: one `list-sessions`, read by the SAME two pure functions the adapter's session binding
 * reads it with (`parseSessionList` + `chooseSession`), so `doctor` and the bridge cannot disagree
 * about which session this collie drives — or about why there is none.
 */
function zellijMux(deps: MuxDeps, settings: MuxSettings): Finding {
  const dotenv = join(deps.ctx.configDir, ".env");
  const candidates = zellijBinaryCandidates(deps.ctx.home);
  const binary = resolveZellijBinary(settings.zellijBin, (p) => deps.files.exists(p), candidates);
  if (binary === null) {
    const why =
      settings.zellijBin === ""
        ? `nothing executable at ${candidates.join(", ")}`
        : `COLLIE_ZELLIJ_BIN="${settings.zellijBin}" is not an absolute path to a file that is there`;
    return bad(
      "mux",
      `zellij — there is no zellij binary to run: ${why} (a Herdr plugin action gets no login shell,` +
        " so PATH is never consulted)",
      `install zellij, or set COLLIE_ZELLIJ_BIN to its absolute path in ${dotenv}, then \`collie restart\``,
    );
  }
  const asked = deps.exec.capture(binary, [...ZELLIJ_LIST_SESSIONS_ARGS]);
  if (!asked.found) {
    return bad(
      "mux",
      `zellij — ${binary} could not be run`,
      `set COLLIE_ZELLIJ_BIN to a zellij that runs, in ${dotenv}, then \`collie restart\``,
    );
  }
  // A box with no sessions exits non-zero and says so on stderr; the chooser turns that, the
  // ambiguity and the exited session into one sentence — the same one the adapter would print.
  const sessions = parseSessionList(asked.code === 0 ? asked.stdout : "");
  const choice = chooseSession(sessions, settings.endpoint);
  const running = sessions.filter((session) => session.running).length;
  if (!choice.ok) {
    const named = settings.endpoint.trim();
    return bad(
      "mux",
      `zellij — ${binary} answered, and ${choice.detail}`,
      named === ""
        ? `start one (\`zellij -s <name>\`) and name it in ${muxEndpointVar(ZELLIJ_MUX)} in ${dotenv}, then \`collie restart\``
        : `start it (\`zellij -s ${named}\`) or attach once to resurrect it — Collie never creates or` +
          ` resurrects a session; then \`collie restart\``,
    );
  }
  return ok(
    "mux",
    `zellij · session ${choice.session} · ${String(running)} running of ${String(sessions.length)} listed` +
      originSuffix(settings.origin),
  );
}

