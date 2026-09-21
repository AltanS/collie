import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_PORT } from "../bridge/config.ts";
import type { HostProbe } from "../bridge/mux/host-candidates.ts";
import { buildMuxRegistry, muxHostCandidates, muxNames } from "../bridge/mux/registry.ts";
import { commitCrewChange, mintInvite } from "../bridge/crew/enrollment.ts";
import type { OpsRecord } from "../bridge/crew/ops-store.ts";
import { TrustStore, type TrustedMember, type TrustStoreData } from "../bridge/crew/trust-store.ts";
import { parseUpdateRun, type UpdateRun } from "../bridge/update-run.ts";
import { parsePrereleaseTag } from "../bridge/update.ts";
import {
  CANDIDATE_QUESTION,
  markCandidates,
  mergeCandidates,
  offeredCandidates,
  pickCandidate,
  renderCandidateList,
  resolvedSshTarget,
  SSH_CONFIG_SOURCE,
  type RosterEntry,
  type SourcedCandidates,
} from "./candidates.ts";
import { collieVersion, collieVersionBare, INSTANCE_PATTERN, PLUGIN_ID } from "./context.ts";
import { detectInstall, updateRepoOf, type InstallKind } from "./install-kind.ts";
import { INSTALLER_SH } from "./installer-embed.ts";
import { EXIT, type Io } from "./io.ts";
import { realLinkFs } from "./link.ts";
import { ensureStore, parseCrewArgs, probeMembers, resolveSelfAddress, type CrewDeps } from "./crew.ts";
import { explicitMux } from "./mux.ts";
import { parseMuxProbe, type MuxProbeReport, type MuxProbeSighting } from "./mux-probe.ts";
import { plainAdd, type AddEvent } from "./render.ts";
import { sshConfigCandidates } from "./ssh-config.ts";
import { withoutGitRelocators } from "./sys.ts";
import { findTool } from "./tools.ts";
import { unitName } from "./unit.ts";

// `collie crew add <ssh-host>` — probe, install, configure, enroll a peer over ONE multiplexed SSH
// connection (M7/01, ADR 0015).
//
// ── COURIER AND INSTALLER, NOTHING ELSE ──────────────────────────────────────
// Every step here is a step the operator could have typed, in the same order, with the same verbs:
// the invite comes from the same `mintInvite` path `crew invite` uses, and the far machine runs the
// same `collie join <lead-address> -`. `crew add` adds NO route, no header and no protocol
// vocabulary (ADR 0015 (d)) — an installer that needed the protocol's help would be a second
// admission path into the crew, and the crew has exactly one (CREW_PROTOCOL.md §8.2).
//
// ── THIS IS THE ONLY MODULE THAT SPAWNS `ssh` ────────────────────────────────
// {@link RemoteRunner} is the seam, injected exactly as `CrewDeps` injects `fetch`, `exec` and
// `files`, so no test in this suite ever reaches a real host. The ssh options are **add-only**: the
// operator's `~/.ssh/config` and `known_hosts` are ridden rather than reimplemented, and no
// host-key-checking option is ever set, in either direction (ADR 0015's consequences).
//
// ── EVERYTHING GOES OVER STDIN ───────────────────────────────────────────────
// Each leg is a `/bin/sh -s` script written to ssh's stdin — no `curl | sh`, no login shell, no
// assumption that anything is on `PATH` (tools are resolved the way `scripts/collie-ctl.sh` resolves
// Bun, and each script reports rather than fixes). The bundle and the enrollment token ride the SAME
// stream, spliced into a quoted heredoc at {@link STDIN_MARKER}, which is what keeps the token out
// of argv, out of the environment and out of every golden file (§8.3).

// ── The transport ────────────────────────────────────────────────────────────

export interface RemoteResult {
  /** The remote command's exit status, or ssh's own (255) when the connection failed. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * False when **ssh never started** — no binary, or it could not be spawned. That is a different
   * failure family from "the remote exited nonzero" and gets a different message (ADR 0015).
   */
  readonly spawned: boolean;
}

export interface RemoteRunner {
  /** Run `script` under `/bin/sh -s`, splicing `stdin` in at {@link STDIN_MARKER}. */
  run(script: string, stdin?: string): Promise<RemoteResult>;
  /** Tear down the multiplexed control socket and its private directory. Idempotent. */
  close(): void;
}

/**
 * The line a leg script carries where its payload goes.
 *
 * `run` replaces this **one line** with the caller's `stdin`, which every script consumes through a
 * quoted heredoc. The shell's own lexer reads the body, so nothing depends on how much a child
 * process reads ahead from a pipe — the failure mode that makes "script and payload on one stdin"
 * unreliable when a command is left to read the remainder itself.
 */
export const STDIN_MARKER = "#__COLLIE_STDIN__";

/** The heredoc delimiter every leg closes its payload with. Never valid inside base64 or a token. */
const PAYLOAD_EOF = "__COLLIE_PAYLOAD__";

/**
 * The ssh options `crew add` adds, and the complete list of them.
 *
 * One control socket for the whole run, so the operator authenticates once; `BatchMode=yes` so a
 * host that would prompt fails legibly instead of hanging behind a captured stdin; `ServerAlive*` so
 * a build that outlives a NAT idle timer is not silently truncated. Nothing here overrides a
 * host-key policy — that decision stays entirely the operator's `~/.ssh` (ADR 0015).
 */
export function sshOptions(controlPath: string): readonly string[] {
  return [
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlPath}`,
    "-o",
    "ControlPersist=60",
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
  ];
}

/** Splice a payload into a leg script. Exported for the golden tests; used by every runner. */
export function composeStdin(script: string, stdin: string | undefined): string {
  const occurrences = script.split(STDIN_MARKER).length - 1;
  if (stdin === undefined) {
    if (occurrences !== 0) throw new Error("a leg script with a payload marker was run without a payload");
    return script;
  }
  if (occurrences !== 1) {
    throw new Error(`a payload needs exactly one ${STDIN_MARKER} line; this script has ${occurrences}`);
  }
  // A payload that could close the heredoc early would let its own bytes be executed as shell.
  // Base64 and an enrollment token cannot contain this line; refuse rather than trust that.
  if (stdin.split("\n").some((l) => l.trim() === PAYLOAD_EOF)) {
    throw new Error("the payload contains the heredoc delimiter");
  }
  // A string replacement reads `$'` in the payload as "the text after the match", and the
  // installer's own regex ends in `$'`; a function replacement inserts the payload byte for byte.
  return script.replace(STDIN_MARKER, () => stdin);
}

/** The real transport: one `ssh` per leg, all sharing one control socket under a 0700 directory. */
export function sshRunner(
  host: string,
  env: Record<string, string | undefined>,
  home: string,
): RemoteRunner {
  const dir = mkdtempSync(join(tmpdir(), "collie-add-"), { encoding: "utf8" });
  // 0700 from creation (`mkdtemp` is 0700) — the control socket is a live authenticated channel to
  // another machine, so anything that can open it can run commands there as the operator.
  const controlPath = join(dir, "s");
  const bin = findTool("ssh", env, home);
  let closed = false;
  return {
    async run(script, stdin) {
      if (bin === null) {
        return { code: 127, stdout: "", stderr: "no `ssh` on this machine", spawned: false };
      }
      const proc = Bun.spawn([bin, ...sshOptions(controlPath), host, "/bin/sh", "-s"], {
        stdin: new TextEncoder().encode(composeStdin(script, stdin)),
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr, spawned: true };
    },
    close() {
      if (closed) return;
      closed = true;
      if (bin !== null) {
        try {
          Bun.spawnSync([bin, "-o", `ControlPath=${controlPath}`, "-O", "exit", host], {
            stdout: "ignore",
            stderr: "ignore",
            env,
          });
        } catch {
          // The master may already be gone; the directory removal below is what actually matters.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── Shell quoting ────────────────────────────────────────────────────────────

/**
 * Single-quote a value for `/bin/sh`. **The only way a local value enters a generated script** — a
 * leg script is a program that runs on someone else's machine, so nothing is ever interpolated raw.
 */
export function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A remote PATH expression for `/bin/sh` — {@link shq}, except a leading `~` is expanded against the
 * REMOTE `$HOME`, never against this machine's. `shq` alone defeats tilde expansion (single quotes
 * turn off every shell substitution), so an operator's `--path '~/apps/collie-stable'` would reach
 * the far shell as the seven-byte literal `~/apps/collie-stable` — a directory named `~` that does
 * not exist — rather than the path they meant. And the two accounts are not guaranteed to share a
 * `$HOME`, so this side must never resolve the tilde itself and ship the resolved string instead.
 */
export function shqPath(path: string): string {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME"/${shq(path.slice(2))}`;
  return shq(path);
}

/**
 * Resolve a tool the way `scripts/collie-ctl.sh` resolves Bun: `PATH` first, then the fixed install
 * locations — because `ssh host '/bin/sh -s'` is byte-for-byte the no-login-shell, no-`PATH`
 * environment that shim was written for. `command -v` reports a shell function as a bare word, so
 * only an absolute answer is taken (the same guard, for the same reason).
 *
 * The candidate list is the canonical one `cli/sys.ts` defines (`toolCandidates`), spelled in shell
 * because it runs on the far machine. `cli/sys.test.ts` parses this constant and the shim and fails
 * when any of the three disagree — add a candidate in all three or in none.
 */
const TOOL_LOOKUP = [
  "collie_tool() {",
  "  _n=$1",
  '  if _p=$(command -v "$_n" 2>/dev/null); then',
  "    case $_p in",
  `      /*) printf '%s' "$_p"; return 0 ;;`,
  "    esac",
  "  fi",
  '  for _c in "${BUN_INSTALL:-$HOME/.bun}/bin/$_n" "$HOME/.bun/bin/$_n" "$HOME/.local/bin/$_n" \\',
  '    "/usr/local/bin/$_n" "/opt/homebrew/bin/$_n" "/usr/bin/$_n" "/bin/$_n" "/usr/sbin/$_n" "/sbin/$_n"; do',
  '    if [ -x "$_c" ]; then printf \'%s\' "$_c"; return 0; fi',
  "  done",
  "  return 1",
  "}",
].join("\n");

// ── Leg 1 — probe ────────────────────────────────────────────────────────────

/**
 * Everything leg 1 reads off the remote. Every field is a **fact observed there**, and an absent one
 * is `""` — never a value this side computed. The whole verb's idempotency is decided from these.
 */
export interface Probe {
  readonly home: string;
  readonly git: string;
  readonly bun: string;
  readonly herdr: string;
  /** `herdr plugin config-dir herdr.collie`, asked on the remote. `""` when it did not answer. */
  readonly configdir: string;
  readonly envhost: string;
  readonly envport: string;
  /**
   * `COLLIE_MUX` as the member's own `$CFG/.env` carries it. `""` when nobody has chosen there.
   *
   * Read for one reason: a member that has ALREADY named a multiplexer is left alone — no probe of
   * its machine, no question, nothing written. Everything else about the mux decision hangs off
   * this field being empty (leg 3, {@link muxChoice}).
   */
  readonly envmux: string;
  readonly checkout: string;
  /**
   * `yes` when the checkout carries a `.git`, `no` when it does not, `""` when there is no checkout.
   *
   * WHAT THE MEMBER TAKES, asked of the member. A `crew add` from a checkout lead pushes a commit and
   * a `crew add` from a binary lead pushes a release tag, and only one of those two lands on a given
   * member (#248). Before this the probe could not tell the two apart, so a bundle push against an
   * install.sh member cloned a SECOND Collie into `~/.collie` and left the first one running.
   */
  readonly checkoutgit: string;
  /** The `<dir>` of a `<dir>/current` + `<dir>/versions` install.sh layout. `""` when it is not one. */
  readonly installroot: string;
  readonly commit: string;
  readonly branch: string;
  readonly dirty: string;
  readonly dirtyfiles: string;
  readonly version: string;
  readonly address: string;
  /** `free` · `busy` · `unknown` (no `ss`/`netstat` there). */
  readonly port: string;
  /** The three tools `scripts/install.sh` needs. `""` for one the member does not have. */
  readonly curl: string;
  readonly tar: string;
  /** `sha256sum`, else `shasum`, else `""` — the installer takes either. */
  readonly sha256: string;
}

const PROBE_PREFIX = "collie-probe:";

/**
 * Parse leg 1's output. `null` is the third error family — "the remote answered something this
 * build cannot read" — and is deliberately distinguished from a probe that ran and said no.
 */
export function parseProbe(stdout: string): Probe | null {
  const raw = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(PROBE_PREFIX)) continue;
    const rest = line.slice(PROBE_PREFIX.length);
    const eq = rest.indexOf("=");
    if (eq <= 0) continue;
    raw.set(rest.slice(0, eq), rest.slice(eq + 1).trim());
  }
  // The sentinel is written last, so its presence proves the script ran to the end rather than
  // dying halfway with a plausible-looking half-answer.
  if (raw.get("probe") !== "ok") return null;
  // Field by field rather than a loop-and-assert: a field the remote did not print reads as "",
  // exactly as before, and the compiler — not a cast — is what says the result is a whole Probe.
  const said = (field: string): string => raw.get(field) ?? "";
  return {
    home: said("home"),
    git: said("git"),
    bun: said("bun"),
    herdr: said("herdr"),
    configdir: said("configdir"),
    envhost: said("envhost"),
    envport: said("envport"),
    envmux: said("envmux"),
    checkout: said("checkout"),
    checkoutgit: said("checkoutgit"),
    installroot: said("installroot"),
    commit: said("commit"),
    branch: said("branch"),
    dirty: said("dirty"),
    dirtyfiles: said("dirtyfiles"),
    version: said("version"),
    address: said("address"),
    port: said("port"),
    curl: said("curl"),
    tar: said("tar"),
    sha256: said("sha256"),
  };
}

/**
 * Leg 1 as a **step**: run the probe and parse it, wording nothing.
 *
 * The step functions in this module (this, {@link runInstall}, {@link restartScript}) are the seam
 * `collie crew update` reuses — it drives the same scripts against the same transport, but it is a
 * different verb with a different voice, so every sentence stays with its caller. What is shared is
 * what runs on the far machine; what is not shared is what an operator reads.
 */
export async function runProbe(
  runner: RemoteRunner,
  opts: { readonly path: string | null; readonly port: number },
): Promise<{ readonly result: RemoteResult; readonly probe: Probe | null }> {
  const result = await runner.run(probeScript(opts));
  return { result, probe: parseProbe(result.stdout) };
}

/**
 * The read-only leg. It **writes nothing on either machine** and never prompts: every later leg's
 * decision — skip, prompt, refuse — is made from what this one reports.
 *
 * The remote's config root is READ here (`herdr plugin config-dir`, the same question
 * `cli/context.ts` asks locally) rather than computed from a path we guessed: `crew add` must not
 * assume a path it did not observe.
 */
export function probeScript(opts: { readonly path: string | null; readonly port: number }): string {
  // `<dir>/current` is in BOTH lists because an install.sh member keeps its Collie behind that
  // symlink, never at the directory the operator names — so a probe that looked only at `<path>`
  // reported "no Collie here" about a machine that has one (#248).
  const named = opts.path === null ? null : opts.path.replace(/\/+$/, "");
  const candidates =
    named === null
      ? `"$HOME/.collie" "$HOME/collie" "$HOME/.local/share/collie/current" "$HOME"/.config/herdr/plugins/github/*/ "$HOME"/.config/herdr/plugins/local/*/`
      : `${shqPath(named)} ${shqPath(`${named}/current`)}`;
  return [
    "set -u",
    "umask 077",
    TOOL_LOOKUP,
    `say() { printf '${PROBE_PREFIX}%s=%s\\n' "$1" "$2"; }`,
    'GIT=$(collie_tool git) || GIT=""',
    'BUN=$(collie_tool bun) || BUN=""',
    'HERDR=$(collie_tool herdr) || HERDR=""',
    'TS=$(collie_tool tailscale) || TS=""',
    // The release route's three tools, resolved the same way. A member installed from a release
    // needs `curl`, `tar` and a sha256 tool and needs neither `git` nor `bun` — so both sets are
    // read here and the route decides which of them is a prerequisite (#248).
    'CURL=$(collie_tool curl) || CURL=""',
    'TAR=$(collie_tool tar) || TAR=""',
    'SHA=$(collie_tool sha256sum) || SHA=$(collie_tool shasum) || SHA=""',
    'say home "$HOME"',
    'say git "$GIT"',
    'say bun "$BUN"',
    'say herdr "$HERDR"',
    'say curl "$CURL"',
    'say tar "$TAR"',
    'say sha256 "$SHA"',
    // The config root, asked for rather than assumed. An empty answer is reported as empty and the
    // verb stops legibly — it never falls back to a conventional path this side made up.
    'CFG=""',
    `if [ -n "$HERDR" ]; then CFG=$("$HERDR" plugin config-dir ${shq(PLUGIN_ID)} 2>/dev/null | head -n 1 | tr -d '\\r') || CFG=""; fi`,
    'say configdir "$CFG"',
    // `COLLIE_MUX` is read exactly as the bind is, and from the same file: it is the value a
    // SUPERVISED bridge there reads (`EnvironmentFile=`), so a member that already names one is one
    // this verb has nothing to decide about.
    'ENVHOST=""; ENVPORT=""; ENVMUX=""',
    'if [ -n "$CFG" ] && [ -f "$CFG/.env" ]; then',
    '  ENVHOST=$(sed -n "s/^[[:space:]]*\\(export[[:space:]][[:space:]]*\\)\\{0,1\\}COLLIE_HOST=//p" "$CFG/.env" | tail -n 1 | tr -d "\\"\'\\r")',
    '  ENVPORT=$(sed -n "s/^[[:space:]]*\\(export[[:space:]][[:space:]]*\\)\\{0,1\\}COLLIE_PORT=//p" "$CFG/.env" | tail -n 1 | tr -d "\\"\'\\r")',
    '  ENVMUX=$(sed -n "s/^[[:space:]]*\\(export[[:space:]][[:space:]]*\\)\\{0,1\\}COLLIE_MUX=//p" "$CFG/.env" | tail -n 1 | tr -d "\\"\'\\r")',
    "fi",
    'say envhost "$ENVHOST"',
    'say envport "$ENVPORT"',
    'say envmux "$ENVMUX"',
    // An existing checkout, by the only marker that proves it is one of ours.
    'CHECKOUT=""',
    `for _d in ${candidates}; do`,
    '  _d=${_d%/}',
    '  [ -f "$_d/herdr-plugin.toml" ] || continue',
    '  grep -q "herdr\\.collie" "$_d/herdr-plugin.toml" 2>/dev/null || continue',
    '  CHECKOUT="$_d"',
    "  break",
    "done",
    'say checkout "$CHECKOUT"',
    // WHICH KIND of Collie that is, as two shapes on disk rather than one opinion: a `.git` beside
    // it, and the `<dir>/current` + `<dir>/versions` layout `scripts/install.sh` lays down. The two
    // take different code — a commit and a release tag — and a member that takes neither is told so
    // rather than written over.
    'CHECKOUTGIT=""; INSTALLROOT=""',
    'if [ -n "$CHECKOUT" ]; then',
    '  if [ -e "$CHECKOUT/.git" ]; then CHECKOUTGIT=yes; else CHECKOUTGIT=no; fi',
    '  case "$CHECKOUT" in',
    '    */current)',
    '      _r=${CHECKOUT%/current}',
    '      if [ -d "$_r/versions" ]; then INSTALLROOT="$_r"; fi',
    "      ;;",
    "  esac",
    "fi",
    'say checkoutgit "$CHECKOUTGIT"',
    'say installroot "$INSTALLROOT"',
    'COMMIT=""; DIRTY=""; DIRTYFILES=""; BRANCH=""; VERSION=""',
    'if [ -n "$CHECKOUT" ] && [ -n "$GIT" ]; then',
    '  COMMIT=$("$GIT" -C "$CHECKOUT" rev-parse HEAD 2>/dev/null) || COMMIT=""',
    '  BRANCH=$("$GIT" -C "$CHECKOUT" symbolic-ref -q --short HEAD 2>/dev/null) || BRANCH=""',
    '  if [ -n "$COMMIT" ]; then',
    '    DIRTYFILES=$("$GIT" -C "$CHECKOUT" status --porcelain 2>/dev/null | head -n 5 | tr "\\n" " ")',
    '    if [ -n "$DIRTYFILES" ]; then DIRTY=yes; else DIRTY=no; fi',
    "  fi",
    "fi",
    'if [ -n "$CHECKOUT" ] && [ -x "$CHECKOUT/bin/collie" ]; then',
    '  VERSION=$("$CHECKOUT/bin/collie" version 2>/dev/null | head -n 1) || VERSION=""',
    "fi",
    'say commit "$COMMIT"',
    'say branch "$BRANCH"',
    'say dirty "$DIRTY"',
    'say dirtyfiles "$DIRTYFILES"',
    'say version "$VERSION"',
    // The address the LEAD will dial. Read off the remote; asked of the operator only when the
    // remote cannot answer. This is the single value that closes the provisional-member trap.
    'ADDR=""',
    'if [ -n "$TS" ]; then ADDR=$("$TS" ip -4 2>/dev/null | head -n 1) || ADDR=""; fi',
    'say address "$ADDR"',
    // The port, probed BEFORE anything is installed rather than discovered at first start.
    //
    // ── WHAT THIS ANSWER IS, AND WHAT IT IS NOT (Q2) ─────────────────────────
    // One `ss -ltn` at one instant. `busy` is therefore a fact — something WAS listening — and the
    // negative is only "nothing was listening just now", which is why the operator is told it in
    // those words rather than as `free`.
    //
    // The case that exposed the gap: a Collie whose unit crash-loops on a five-second timer is
    // absent from `ss` for most of every cycle, so the honest instantaneous answer is "nothing
    // listening" and the durable answer is "occupied by a service that keeps coming back".
    //
    // **Collie cannot close that gap from here, and does not pretend to.** "Refused now but a unit
    // is active" is not a remote observation: it needs the far machine's supervisor, and which
    // supervisor that is (systemd user, launchd, unsupervised) is exactly what `crew add` has not
    // yet decided at probe time — it is decided by the install leg, after this. Sampling the port
    // repeatedly would only lengthen the coin flip. So the limitation is stated, not papered over;
    // a genuine collision still surfaces at first start, which is where the supervisor is known.
    "PORTSTATE=unknown",
    'SS=$(collie_tool ss) || SS=""',
    'NETSTAT=$(collie_tool netstat) || NETSTAT=""',
    'LISTEN=""',
    'if [ -n "$SS" ]; then LISTEN=$("$SS" -ltn 2>/dev/null) || LISTEN=""',
    'elif [ -n "$NETSTAT" ]; then LISTEN=$("$NETSTAT" -ltn 2>/dev/null) || LISTEN=""; fi',
    'if [ -n "$LISTEN" ]; then',
    `  if printf '%s\\n' "$LISTEN" | grep -q "[:.]${opts.port}[[:space:]]"; then PORTSTATE=busy; else PORTSTATE=free; fi`,
    "fi",
    'say port "$PORTSTATE"',
    "say probe ok",
    "",
  ].join("\n");
}

// ── Leg 2 — install ──────────────────────────────────────────────────────────

const INSTALL_PREFIX = "collie-install:";

/**
 * Unbundle the lead's own commit and build it with the shim's own bootstrap.
 *
 * The bundle **is** the commit (ADR 0015 (b)), so version pinning is structural: there is no ref to
 * resolve and no window in which a branch moved. The build is `bun run cli/main.ts build` — the same
 * mechanism `scripts/collie-ctl.sh` runs on a checkout with no binary, never a second build path —
 * and the post-install version is re-read and required to match, or this leg fails hard and leaves
 * the checkout exactly where it is.
 */
export function installScript(opts: {
  readonly root: string;
  readonly commit: string;
  readonly version: string;
}): string {
  return [
    "set -eu",
    "umask 077",
    TOOL_LOOKUP,
    'GIT=$(collie_tool git) || { echo "error: no git on this machine" >&2; exit 20; }',
    'BUN=$(collie_tool bun) || { echo "error: no bun on this machine" >&2; exit 21; }',
    `ROOT=${shqPath(opts.root)}`,
    `COMMIT=${shq(opts.commit)}`,
    `EXPECT=${shq(opts.version)}`,
    'WORK=$(mktemp -d "${TMPDIR:-/tmp}/collie-add.XXXXXX")',
    `trap 'rm -rf "$WORK"' EXIT INT TERM`,
    // BSD and GNU `base64` disagree on the decode flag; ask rather than guess.
    `if printf '' | base64 -d >/dev/null 2>&1; then B64D="base64 -d"; else B64D="base64 -D"; fi`,
    // tmp → verify → rename, for every file this leg lands.
    `$B64D > "$WORK/bundle.part" <<'${PAYLOAD_EOF}'`,
    STDIN_MARKER,
    PAYLOAD_EOF,
    // `git bundle verify` refuses to run outside a repository, and cwd here is the remote user's
    // $HOME over `ssh host /bin/sh -s` — generally not one. A scratch repo gives it *a* repository;
    // an empty one suffices only because the pushed bundle is complete (a bundle of HEAD, no prereqs).
    '"$GIT" init -q "$WORK/verify"',
    'VMSG=$("$GIT" -C "$WORK/verify" bundle verify "$WORK/bundle.part" 2>&1 >/dev/null) || { echo "error: the pushed bundle did not verify: $VMSG" >&2; exit 22; }',
    'mv "$WORK/bundle.part" "$WORK/bundle"',
    'if [ -d "$ROOT/.git" ]; then',
    '  "$GIT" -C "$ROOT" fetch --no-tags --update-shallow "$WORK/bundle" HEAD',
    '  "$GIT" -C "$ROOT" checkout --detach "$COMMIT"',
    // Never `mv` a fresh clone onto an existing non-checkout: `mv a b` when `b` is a directory puts
    // `a` INSIDE it, which would leave a working Collie at a path nothing else knows about.
    'elif [ -e "$ROOT" ]; then',
    '  echo "error: $ROOT exists and is not a git checkout — move it aside or pass --path" >&2',
    "  exit 27",
    "else",
    '  mkdir -p "$(dirname "$ROOT")"',
    '  rm -rf "$ROOT.part"',
    '  "$GIT" clone -q "$WORK/bundle" "$ROOT.part"',
    '  "$GIT" -C "$ROOT.part" checkout --detach "$COMMIT"',
    '  mv "$ROOT.part" "$ROOT"',
    "fi",
    'GOT=$("$GIT" -C "$ROOT" rev-parse HEAD)',
    '[ "$GOT" = "$COMMIT" ] || { echo "error: checkout is at $GOT, expected $COMMIT" >&2; exit 23; }',
    // The shim's bootstrap, verbatim in mechanism: prepend Bun's own directory and build from source.
    'BUNDIR=$(dirname "$BUN")',
    '( cd "$ROOT" && PATH="$BUNDIR:$PATH" "$BUN" run cli/main.ts build ) || { echo "error: the build failed on this machine" >&2; exit 24; }',
    '[ -x "$ROOT/bin/collie" ] || { echo "error: the build left no binary at $ROOT/bin/collie" >&2; exit 25; }',
    'VERSION=$("$ROOT/bin/collie" version | head -n 1)',
    // Prefix rather than equality: `collie version` appends the build stamp's sha, which the lead's
    // own string carries too only when the lead is built from the very commit it is pushing.
    'case "$VERSION" in',
    '  "$EXPECT"*) ;;',
    '  *) echo "error: installed $VERSION, expected $EXPECT" >&2; exit 26 ;;',
    "esac",
    `printf '${INSTALL_PREFIX}root=%s\\n${INSTALL_PREFIX}version=%s\\n' "$ROOT" "$VERSION"`,
    "",
  ].join("\n");
}

/**
 * Leg 2 as a **step**: push the bundle and build it, wording nothing.
 *
 * `version` is what the far machine reported after building — `null` when it answered something this
 * build cannot read, which is a different failure from a build that exited nonzero and is left for
 * the caller to say so in its own words.
 */
export async function runInstall(
  runner: RemoteRunner,
  opts: { readonly root: string; readonly commit: string; readonly version: string },
  bundle: string,
): Promise<{ readonly result: RemoteResult; readonly version: string | null }> {
  const result = await runner.run(installScript(opts), bundle);
  const built = /^collie-install:version=(.+)$/m.exec(result.stdout);
  return { result, version: built === null ? null : built[1]!.trim() };
}

/**
 * Lay the release the LEAD runs down on the member, with Collie's own installer.
 *
 * THE SECOND ROUTE INTO A MEMBER, and the one a lead with no commit takes (#248). ADR 0015 (b)
 * refused a release fetch for the bundle route on two counts, and both are answered here rather than
 * argued away: a binary lead's members already fetch GitHub to level themselves (ADR 0016 addendum),
 * and a release TAG pins exactly — the installer verifies the payload's sha256 against the release's
 * own manifest, and this leg re-reads `collie version` afterwards and requires it to match.
 *
 * **The installer is a payload, not a fetch.** It rides the same quoted heredoc the bundle and the
 * enrollment token ride, out of the lead's own binary (`cli/installer-embed.ts`), so the far machine
 * runs the script this build shipped and never `curl … | sh`. `COLLIE_TAG` is set, which is the one
 * way past the installer's api.github.com call — so no GitHub token matters here, and no tag is
 * resolved on the far side.
 *
 * Its own output goes to stderr: this leg's stdout carries the two marker lines and nothing else,
 * and the installer's `die` text lands where the caller quotes from.
 */
export function installReleaseScript(opts: {
  readonly installRoot: string;
  readonly tag: string;
  readonly repo: string;
  readonly version: string;
}): string {
  return [
    "set -eu",
    "umask 077",
    TOOL_LOOKUP,
    // The installer looks its three tools up on `PATH`, and `ssh host /bin/sh -s` has the bare
    // system one — which is the environment `collie_tool` exists for. Resolve them here, where a
    // missing one is a legible exit code, and put their directories in front of PATH for the child.
    'CURL=$(collie_tool curl) || { echo "error: no curl on this machine" >&2; exit 20; }',
    'TAR=$(collie_tool tar) || { echo "error: no tar on this machine" >&2; exit 21; }',
    'SHA=$(collie_tool sha256sum) || SHA=$(collie_tool shasum) || { echo "error: no sha256 tool on this machine" >&2; exit 22; }',
    'PATH="$(dirname "$CURL"):$(dirname "$TAR"):$(dirname "$SHA"):$PATH"',
    "export PATH",
    `DIR=${shqPath(opts.installRoot)}`,
    `EXPECT=${shq(opts.version)}`,
    'WORK=$(mktemp -d "${TMPDIR:-/tmp}/collie-add.XXXXXX")',
    `trap 'rm -rf "$WORK"' EXIT INT TERM`,
    // Raw text, not base64: `composeStdin` refuses a payload that could close this heredoc, so the
    // bytes below are the script this build embeds and nothing else.
    `cat > "$WORK/install.sh" <<'${PAYLOAD_EOF}'`,
    STDIN_MARKER,
    PAYLOAD_EOF,
    // `/bin/sh` absolute, which is the very shell this leg is already running under.
    `COLLIE_DIR="$DIR" COLLIE_UPDATE_REPO=${shq(opts.repo)} COLLIE_TAG=${shq(opts.tag)} /bin/sh "$WORK/install.sh" 1>&2`,
    'ROOT="$DIR/current"',
    '[ -x "$ROOT/bin/collie" ] || { echo "error: the install left no binary at $ROOT/bin/collie" >&2; exit 25; }',
    'VERSION=$("$ROOT/bin/collie" version | head -n 1)',
    // Prefix rather than equality, for the same reason the bundle leg uses one: `collie version`
    // appends the build stamp's sha.
    'case "$VERSION" in',
    '  "$EXPECT"*) ;;',
    '  *) echo "error: installed $VERSION, expected $EXPECT" >&2; exit 26 ;;',
    "esac",
    `printf '${INSTALL_PREFIX}root=%s\\n${INSTALL_PREFIX}version=%s\\n' "$ROOT" "$VERSION"`,
    "",
  ].join("\n");
}

/**
 * Leg 2 on the release route as a **step**: send the installer, run it pinned to the tag, wording
 * nothing. The same `{ result, version }` shape {@link runInstall} returns, so the caller's success
 * and failure handling is one piece of code for both routes.
 */
export async function runInstallRelease(
  runner: RemoteRunner,
  opts: {
    readonly installRoot: string;
    readonly tag: string;
    readonly repo: string;
    readonly version: string;
  },
  installer: string,
): Promise<{ readonly result: RemoteResult; readonly version: string | null }> {
  const result = await runner.run(installReleaseScript(opts), installer);
  const built = /^collie-install:version=(.+)$/m.exec(result.stdout);
  return { result, version: built === null ? null : built[1]!.trim() };
}

/**
 * `collie restart` on the far machine — the step `crew update` needs and `crew add` does not.
 *
 * A fresh peer is restarted by its own `collie join` (every membership verb restarts on the machine
 * it ran on); an ALREADY-enrolled peer that was just rebuilt has a running bridge holding the old
 * code, and only its own service manager can move it. So this is the far side's own verb, run there,
 * exactly as an operator sitting at that machine would run it — never `systemctl` spelled out here,
 * which would guess a unit name this side has no business knowing (CLAUDE.md).
 */
export function restartScript(root: string): string {
  return [
    "set -eu",
    `ROOT=${shqPath(root)}`,
    'exec "$ROOT/bin/collie" restart',
    "",
  ].join("\n");
}

// ── The far side's own update record ─────────────────────────────────────────

/**
 * `collie update --status --json` on the far machine — how the health gate of a crew update finds
 * out WHY a member did not come back (M15/06).
 *
 * **No `curl`, and no port dialled from here.** The member's `/api/health` is answered by the member
 * itself, so the honest way to ask across a machine boundary is the member's own binary, run over
 * the ssh the operator already authenticated (ADR 0016). A staged install keeps the live binary
 * under `current/`; a Herdr-managed checkout advances in place and has only `bin/collie`. Both are
 * tried, in that order, because the first one that exists is the one that is running.
 *
 * Exit 66 = no Collie binary at that path, which is the same code {@link remoteCheckScript} uses for
 * the same fact.
 */
export function updateStatusScript(root: string): string {
  return [
    "set -u",
    `ROOT=${shqPath(root)}`,
    'for _c in "$ROOT/current/bin/collie" "$ROOT/bin/collie"; do',
    '  if [ -x "$_c" ]; then exec "$_c" update --status --json; fi',
    "done",
    "exit 66",
    "",
  ].join("\n");
}

/**
 * The run record inside whatever the far side printed, or null.
 *
 * Null covers three cases that are one answer to the caller: no binary there, a Collie old enough
 * not to know `--status`, and a machine that has never run an update (`--status --json` prints
 * `null`). None of them is evidence about the update that just ran, so none of them may be read as
 * a diagnosis.
 */
export function parseRemoteRun(stdout: string): UpdateRun | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return parseUpdateRun(stdout.slice(start, end + 1));
}

/** {@link updateStatusScript} as a step: run it, and read what came back. */
export async function runUpdateStatus(
  runner: RemoteRunner,
  root: string,
): Promise<{ readonly result: RemoteResult; readonly run: UpdateRun | null }> {
  const result = await runner.run(updateStatusScript(root));
  return { result, run: parseRemoteRun(result.stdout) };
}

// ── Leg 3 — configure ────────────────────────────────────────────────────────

/**
 * Write the peer's `.env` atomically, preserving every value Collie did not set.
 *
 * **No front door is created here, ever** (ADR 0013, §3): no `tailscale serve` mapping and no
 * ownership record. A peer publishes nothing, and `join` on the far side tears down any mapping it
 * can prove is its own.
 */
export function configureScript(opts: {
  readonly configDir: string;
  readonly host: string;
  readonly port: number;
  /**
   * The multiplexer the LEAD decided this member should drive, or null to write none.
   *
   * Null is the ordinary case and the script is then byte-identical to the one before this option
   * existed: a member that already names one, or that runs exactly one and will pick it itself at
   * first start, has nothing to be written here (leg 3, {@link muxChoice}).
   */
  readonly mux: string | null;
  readonly instance: string | null;
}): string {
  const keys = [
    "COLLIE_HOST",
    "COLLIE_PORT",
    ...(opts.mux === null ? [] : ["COLLIE_MUX"]),
    ...(opts.instance === null ? [] : ["COLLIE_INSTANCE"]),
  ];
  return [
    "set -eu",
    "umask 077",
    `CFG=${shq(opts.configDir)}`,
    'mkdir -p "$CFG"',
    'ENVFILE="$CFG/.env"',
    'TMP="$ENVFILE.collie-add.$$"',
    `trap 'rm -f "$TMP"' EXIT INT TERM`,
    ': > "$TMP"',
    'chmod 600 "$TMP"',
    `KEYS='${keys.join("|")}'`,
    'if [ -f "$ENVFILE" ]; then',
    '  grep -v -E "^[[:space:]]*(export[[:space:]]+)?($KEYS)=" "$ENVFILE" >> "$TMP" || true',
    "fi",
    `printf 'COLLIE_HOST=%s\\n' ${shq(opts.host)} >> "$TMP"`,
    `printf 'COLLIE_PORT=%s\\n' ${shq(String(opts.port))} >> "$TMP"`,
    ...(opts.mux === null ? [] : [`printf 'COLLIE_MUX=%s\\n' ${shq(opts.mux)} >> "$TMP"`]),
    ...(opts.instance === null
      ? []
      : [`printf 'COLLIE_INSTANCE=%s\\n' ${shq(opts.instance)} >> "$TMP"`]),
    // Verify before the rename: an empty file here would be a peer with no bind at all.
    '[ -s "$TMP" ] || { echo "error: refusing to write an empty .env" >&2; exit 30; }',
    'mv "$TMP" "$ENVFILE"',
    `printf 'collie-configure:env=%s\\n' "$ENVFILE"`,
    "",
  ].join("\n");
}

/**
 * Ask the member which multiplexers are running on it — with the member's OWN binary.
 *
 * The same shape {@link membershipScript} has, and for the same reason: leg 2 has just installed
 * this very build there, so the far side knows the verb and answers in a format this build wrote.
 * A POSIX copy of the probe would be a second answer to the question `cli/mux.ts` already owns, and
 * it would go stale the first time a fourth multiplexer is registered (`cli/mux-probe.ts`).
 *
 * Read-only on the far machine: `_mux-probe` starts nothing and writes nothing.
 */
export function muxProbeScript(root: string): string {
  return [
    "set -eu",
    `ROOT=${shqPath(root)}`,
    '"$ROOT/bin/collie" _mux-probe',
    "",
  ].join("\n");
}

// ── Leg 4 — enroll ───────────────────────────────────────────────────────────

/** Read the remote's own crew view, so an already-enrolled machine is never re-enrolled. */
export function membershipScript(root: string): string {
  return [
    "set -eu",
    `ROOT=${shqPath(root)}`,
    '"$ROOT/bin/collie" crew status --no-probe',
    "",
  ].join("\n");
}

/** What `crew status --no-probe` says about the far machine, as this build reads it. */
export interface RemoteMembership {
  /** The crew id it belongs to, or null when it is solo. */
  readonly packId: string | null;
  readonly crewName: string | null;
  readonly memberId: string | null;
}

/**
 * Parse the far side's `crew status`. It is the SAME build — leg 2 just installed this very commit
 * there — so the format is known rather than guessed; a shape this build cannot read is still the
 * third error family and fails rather than assuming solo.
 */
export function parseMembership(stdout: string): RemoteMembership | null {
  if (/^mode: solo\b/m.test(stdout)) return { packId: null, crewName: null, memberId: null };
  // BOTH labels. This build prints `crew   <name>  (<id>)`; a 1.6.0 machine prints `crew   …` and is
  // exactly the machine this verb meets during a staged rollout (M24). One regex reads either.
  const crew = /^(?:crew|crew) {3}(.+?) {2}\((.+?)\)\s*$/m.exec(stdout);
  const self = /^self {3}(\S+)/m.exec(stdout);
  if (crew === null) return null;
  return { packId: crew[2]!.trim(), crewName: crew[1]!.trim(), memberId: self?.[1] ?? null };
}

/**
 * `collie join <lead-address> -` on the far machine, with the token on stdin.
 *
 * The token never reaches argv, an environment variable or a file this verb writes (§8.3) — it is
 * spliced into a quoted heredoc, so it exists only in the ssh stream and in the shell's heredoc
 * buffer. `--insecure` is never passed on the operator's behalf: the far side refuses `http://`
 * exactly as it would for a hand-typed join — and since F9 this verb no longer LETS that refusal be
 * the one the operator meets, because it arrived after the far machine had already been rebuilt.
 * {@link leadAddressRefusal} takes the same decision from the lead's own argv, before leg 1.
 */
export function enrollScript(opts: {
  readonly root: string;
  readonly leadAddress: string;
  readonly peerAddress: string;
  readonly label: string | null;
}): string {
  const args = [
    "join",
    opts.leadAddress,
    "-",
    "--address",
    opts.peerAddress,
    ...(opts.label === null ? [] : ["--label", opts.label]),
  ];
  return [
    "set -eu",
    `ROOT=${shqPath(opts.root)}`,
    `exec "$ROOT/bin/collie" ${args.map(shq).join(" ")} <<'${PAYLOAD_EOF}'`,
    STDIN_MARKER,
    PAYLOAD_EOF,
    "",
  ].join("\n");
}

// ── The verb ─────────────────────────────────────────────────────────────────

/** `crew add`'s seams: the crew verbs' set, plus a transport, two prompts and the bundle. */
export interface CrewAddDeps extends CrewDeps {
  /** The ONE thing in `cli/` that spawns ssh, injected so no test ever does. */
  remote(host: string): RemoteRunner;
  /**
   * The `[y/N]`, behind a seam. `null` means "nobody is there to ask".
   *
   * A promise is allowed because the rich path answers it INSIDE the ink app — a keypress, not a
   * blocking read — while the plain path is still Bun's synchronous `confirm()`. Both spellings are
   * assignable, so a test can keep handing over a plain boolean.
   */
  confirm(question: string): boolean | null | Promise<boolean | null>;
  /** The free-text ask, behind the same seam and for the same reason. */
  prompt(question: string): string | null | Promise<string | null>;
  /**
   * `git bundle create - <commit>`, base64-encoded. `null` when git refused.
   *
   * It is handed the `Io` to complain through rather than closing over one: on the rich path the
   * verb's writer is the surface, and a seam that had captured the process's own `Io` would print
   * git's stderr straight through the middle of a frame.
   */
  gitBundle(commit: string, io: Io): Promise<string | null>;
  /**
   * Re-read the trust store from disk. The lead's enrollment is written by its RUNNING BRIDGE, in
   * another process, so this process's cached copy cannot see it (`TrustStore.load` reads once).
   */
  reload(): Promise<TrustStoreData | null>;
  /**
   * Where every line this verb says goes as STRUCTURE (`cli/render.ts`). Absent ⇒ the plain replay,
   * which is what every existing caller and every golden gets.
   */
  emit?(event: AddEvent): void;
  /**
   * THIS lead's own install kind, the same `classifyInstall` answer `crew update` reads. Absent ⇒
   * detected from the filesystem. Read for one question: does this lead have a commit to push.
   */
  installKind?(): InstallKind;
}

/** `CrewAddDeps` after {@link cmdCrewAdd} has resolved the sink — the shape every step below takes. */
type Wired = CrewAddDeps & { emit(event: AddEvent): void };

const USAGE = [
  "usage: collie crew add <ssh-host> [--path <remote-checkout-or-install-root>] [--port <n>]",
  // `<bare-host>`, not `<addr>`: the value becomes the member's COLLIE_HOST, and the usage line was
  // the first of the five places that said "address" while meaning "host" (F8).
  "                      [--peer-address <bare-host>] [--address <lead-address>]",
  "                      [--label <name>] [--name <crew>] [--instance <name>]",
  "                      [--mux <name>]",
];

/** Prompt copy shared by the abort path, so the non-interactive message names the real question. */
async function ask(deps: Wired, question: string): Promise<boolean | "aborted"> {
  const answer = await deps.confirm(question);
  if (answer === null) {
    deps.io.err(`error: this run is not interactive, and it would have asked: ${question}`);
    deps.io.err("       Nothing was changed. Re-run from a terminal, or resolve it on that machine first.");
    return "aborted";
  }
  return answer;
}

/**
 * `collie crew add <ssh-host>` — four legs over one connection (M7/01).
 *
 * Exit codes reuse `EXIT`'s existing meanings rather than adding a seventh: `UNREACHABLE` when ssh
 * never started or could not authenticate, `STATE` when the operator said no or remote state blocks,
 * `REFUSED` when the lead refused the token, `FAIL` for a missing prerequisite, a failed build, an
 * unreadable answer, or a member that is still provisional at the final check.
 */
export async function cmdCrewAdd(deps: CrewAddDeps, args: readonly string[]): Promise<number> {
  const surface = deps.ui?.crewAdd?.() ?? null;
  if (surface === null) {
    // The plain path is unchanged in every byte: the events are replayed as the lines they always
    // were, in the order they were emitted, through the same `Io`.
    return await crewAddRun({ ...deps, emit: deps.emit ?? ((event) => plainAdd(deps.io, event)) }, args);
  }
  // The rich path. `io`, `confirm` and `prompt` are ALL replaced for the length of the run — that is
  // the whole of the "one writer" rule (`cli/render.ts`), and it is why nothing below needs to know
  // which renderer it is talking to.
  const wired: Wired = {
    ...deps,
    io: surface.io,
    emit: surface.emit,
    confirm: surface.confirm,
    prompt: surface.prompt,
  };
  let code: number = EXIT.FAIL;
  try {
    code = await crewAddRun(wired, args);
    return code;
  } finally {
    // The last frame, always: a red verdict is the failure's headline, and the `error:` lines that
    // explain it are already on screen under the leg that failed.
    if (code !== EXIT.OK) {
      wired.emit({ kind: "verdict", ok: false, text: `crew add did not finish (exit ${code})` });
    }
    await surface.close();
  }
}

// ── The candidate picker ─────────────────────────────────────────────────────
// `collie crew add` with no target used to be a usage error. It now offers the machines this box
// already knows about and lets the operator pick one (M22/07). With a target NOTHING below runs, and
// the verb takes the same path it always did, byte for byte.
//
// NOTHING IS EVER ADDED WITHOUT THE OPERATOR PICKING IT. A candidate is a suggestion; the pick
// chooses a host, and the four-leg run — including its confirm — is unchanged from that point on.
// The merge, the mark and the rendering live in `./candidates.ts`; the two sources in
// `./ssh-config.ts` and behind `MuxAdapterFactory.hostCandidates` (ADR 0036 (c)).

/** The picker's answer: the host to add, or the exit code this run ends with. */
type Chosen = { readonly host: string } | { readonly code: number };

/**
 * The candidate providers' world, over seams this suite already fakes.
 *
 * `Exec` and not {@link RemoteRunner}: every call the picker makes runs on THIS machine — `ssh -G`
 * resolves a local config file without connecting, and a multiplexer's machine list is local
 * client-side state. `RemoteRunner` is the far side, and there is no far side yet.
 */
function candidateProbe(deps: Wired): HostProbe {
  return {
    run: (tool, args, timeoutMs) => deps.exec.capture(tool, args, timeoutMs),
    warn: (line) => deps.io.err(line),
  };
}

/**
 * This lead's own roster, as a join the candidate list can mark against.
 *
 * The enrolled peers come from the trust store and how each was reached comes from the ops store
 * (`bridge/crew/ops-store.ts`, ADR 0016) — `crew add` has WRITTEN `sshHost` since M7/01 and this is
 * the first read of it here. Empty on a peer and on a solo collie: neither has members to mark.
 */
async function leadRoster(deps: Wired, probe: HostProbe): Promise<readonly RosterEntry[]> {
  const trust = await deps.store.load();
  if (trust === null || trust.lead !== null) return [];
  const { data } = await deps.ops.load();
  if (data === null) return [];
  const roster: RosterEntry[] = [];
  for (const peer of trust.peers) {
    const record = data.members[peer.memberId];
    if (record === undefined) continue;
    const sshHost = record.sshHost;
    roster.push({ memberId: peer.memberId, sshHost, key: resolvedSshTarget(sshHost, probe) ?? sshHost });
  }
  return roster;
}

/** Every provider's candidates, `ssh config` first and the multiplexers after it, in registry order. */
function candidateSources(deps: Wired, probe: HostProbe): readonly SourcedCandidates[] {
  const sources: SourcedCandidates[] = [
    { source: SSH_CONFIG_SOURCE, candidates: sshConfigCandidates(deps.files, deps.ctx.home) },
  ];
  for (const answer of muxHostCandidates(probe)) {
    sources.push({ source: answer.mux, candidates: answer.candidates });
  }
  return sources.filter((source) => source.candidates.length > 0);
}

/** List the candidates and take the operator's pick. */
async function chooseCandidateHost(deps: Wired): Promise<Chosen> {
  const probe = candidateProbe(deps);
  const rows = markCandidates(
    mergeCandidates(candidateSources(deps, probe), (target) => resolvedSshTarget(target, probe)),
    await leadRoster(deps, probe),
  );
  // No candidates at all is TODAY'S ANSWER, unchanged: there is nothing to offer and the operator
  // has to name a host, which is what the usage line says.
  if (rows.length === 0) {
    for (const line of USAGE) deps.io.err(line);
    return { code: EXIT.USAGE };
  }
  for (const line of renderCandidateList(rows)) deps.io.out(line);
  if (offeredCandidates(rows).length === 0) {
    deps.io.err("error: every candidate above is already a member of this crew.");
    for (const line of USAGE) deps.io.err(line);
    return { code: EXIT.USAGE };
  }
  const answer = await deps.prompt(CANDIDATE_QUESTION);
  if (answer === null) {
    deps.io.err("error: this run is not interactive, and it would have asked which host to add.");
    deps.io.err("       Name one instead: `collie crew add <ssh-host>`.");
    return { code: EXIT.USAGE };
  }
  if (answer.trim() === "") {
    deps.io.out("Nothing was added.");
    return { code: EXIT.STATE };
  }
  const picked = pickCandidate(rows, answer);
  if (picked === null) {
    deps.io.err(`error: "${answer.trim()}" is not one of the candidates above.`);
    deps.io.err("       Pick a number, or run `collie crew add <ssh-host>` with the name.");
    return { code: EXIT.USAGE };
  }
  return { host: picked };
}

async function crewAddRun(deps: Wired, args: readonly string[]): Promise<number> {
  const { positional, flags } = parseCrewArgs(args);
  const named = positional[0];
  // No target is no longer a refusal — it is the candidate list ({@link chooseCandidateHost}).
  const chosen: Chosen = named === undefined || named === "" ? await chooseCandidateHost(deps) : { host: named };
  if ("code" in chosen) return chosen.code;
  const host = chosen.host;
  deps.emit({ kind: "title", host });
  const port = parsePort(flags.port);
  if (port === null) {
    deps.io.err(`error: --port ${flags.port} is not a port number.`);
    return EXIT.USAGE;
  }
  const instance = flags.instance ?? null;
  if (instance !== null && !INSTANCE_PATTERN.test(instance)) {
    deps.io.err(`error: --instance ${instance} is not a usable instance name — 1-16 characters of [a-z0-9-].`);
    return EXIT.USAGE;
  }
  // ── EVERY CHEAP REFUSAL SITS ABOVE THE FIRST SSH BYTE ───────────────────────
  // The flags below are refused HERE, beside `--port` and `--instance`, and not where they are first
  // used. Both were found the same way (F8, F9): a value this build can prove wrong on its own was
  // checked after an 8 MB bundle push, a remote build, an `.env` write and two lead restarts, so a
  // typo cost a rebuilt member and left it half-configured. Nothing below this block is cheap; a
  // check that CAN be made from the lead's own argv belongs above it.
  // A multiplexer name this build cannot drive is refused from the lead's own argv: the member
  // would take it, write it, and then refuse to start with "unknown multiplexer" — after the
  // install, the `.env` write and the join.
  const mux = flags.mux ?? null;
  const known = muxNames(buildMuxRegistry());
  if (mux !== null && !known.includes(mux)) {
    deps.io.err(`error: --mux ${mux === "" ? "(empty)" : mux} is not a multiplexer this build drives.`);
    deps.io.err(`       Name one of: ${known.join(", ")}.`);
    return EXIT.USAGE;
  }
  const peerAddress = flags["peer-address"];
  if (peerAddress !== undefined) {
    const refusal = peerHostRefusal(peerAddress);
    if (refusal !== null) {
      for (const line of peerHostRefusalLines(peerAddress, refusal)) deps.io.err(line);
      return EXIT.USAGE;
    }
  }
  const leadAddress = leadAddressRefusal(flags.address, deps.ctx.env.COLLIE_PUBLIC_URL);
  if (leadAddress !== null) {
    for (const line of leadAddress) deps.io.err(line);
    return EXIT.USAGE;
  }

  const existing = await deps.store.load();
  if (existing !== null && existing.lead !== null) {
    deps.io.err(`error: this collie is a peer of "${existing.lead.memberId}" — peers are added from the lead.`);
    return EXIT.STATE;
  }

  // ── WHICH ROUTE THIS LEAD INSTALLS A MEMBER BY ─────────────────────────────
  // Decided ONCE, here, from this lead's own install kind, and carried down: a checkout lead pushes
  // its commit as a `git bundle` (ADR 0015), and a lead with no commit — install.sh or a package —
  // installs the member from the release it runs itself (#248). Every later difference between the
  // two, the prerequisites and the refusals included, reads this one value.
  const kind = deps.installKind?.() ?? detectInstall({ ...deps, link: realLinkFs });
  const route = routeOf(kind);
  const leadVersion = releaseOf(collieVersionBare(deps.ctx.root, (p) => deps.files.read(p)));
  // A version this build cannot read leaves no tag to pin the member to, and that is refused before
  // the first ssh byte rather than discovered after the probe — the same rule every cheap refusal
  // above follows.
  if (route === "release" && parsePrereleaseTag(`v${leadVersion}`) === null) {
    deps.io.err(`error: cannot read this lead's version, so there is no release to pin ${host} to.`);
    deps.io.err(`       ${deps.ctx.root} is a ${kind.kind} install, so \`crew add\` installs the member from`);
    deps.io.err("       the release this lead runs. `collie version` here is the value it needs.");
    return EXIT.FAIL;
  }

  const runner = deps.remote(host);
  // `crew add` prints its progress as plain lines and nothing else — it streams for the length of a
  // four-leg SSH pipeline and asks two questions on stdin in the middle of it, which is the shape
  // ink cannot share a terminal with (`cli/render.ts`).
  try {
    return await addOverSsh(deps, runner, {
      host,
      port,
      instance,
      mux,
      flags,
      route,
      leadVersion,
      repo: updateRepoOf(deps.ctx.env),
    });
  } finally {
    // Every exit path, including a throw: the control socket is a live authenticated channel.
    runner.close();
  }
}

/** Which of the two ways a member gets its code — the lead's own install kind decides it. */
export type Route = "bundle" | "release";

/**
 * The route a lead of this kind installs and levels a member by.
 *
 * ONE FUNCTION FOR TWO VERBS. `crew add` and the terminal `crew update` put code on a member the
 * same way, so they must never disagree about which way that is: a lead that added a member by
 * release and then tried to level it by bundle would push a commit into a layout that has no git
 * checkout at all. A `binary` install (install.sh) and a `packaged` one (ADR 0035) have no commit,
 * and every other kind — both checkout shapes and `unknown` — has or should have one (#248).
 */
export function routeOf(kind: InstallKind): Route {
  return kind.kind === "binary" || kind.kind === "packaged" ? "release" : "bundle";
}

interface AddOptions {
  readonly host: string;
  readonly port: number;
  readonly instance: string | null;
  /** `--mux <name>`, already checked against this build's registry. Null when it was not given. */
  readonly mux: string | null;
  readonly flags: Readonly<Record<string, string>>;
  readonly route: Route;
  /** The release this lead runs, bare (`1.11.1`). Read by the release route; `v`-prefixed it is the tag. */
  readonly leadVersion: string;
  /** The `owner/repo` the member is told to install from — this lead's own (`updateRepoOf`). */
  readonly repo: string;
}

/**
 * What Collie the MEMBER already has, from the two shapes leg 1 reports.
 *
 * `other` is a real answer and not a fallback: a directory that carries Collie's Herdr manifest but
 * is neither a git checkout nor an install.sh layout is one this verb has no safe way to advance,
 * and it is told so rather than written over.
 */
export type MemberKind = "none" | "git" | "binary" | "other";

export function memberInstallKind(probe: Probe): MemberKind {
  if (probe.checkout === "") return "none";
  if (probe.checkoutgit === "yes") return "git";
  if (probe.installroot !== "") return "binary";
  return "other";
}

/**
 * A version string reduced to the RELEASE it names — no `+build` metadata, no parenthetical.
 *
 * Both sides need it and they are spelled differently: this lead reads `collieVersionBare`, which
 * carries `+<sha>` on a built tree, and a member answers `collie version`, which may add
 * "(manifest; web not built)". The tag is neither of those, so both are cut back to it.
 */
export function releaseOf(version: string): string {
  return version.trim().split(/\s+/)[0]?.split("+")[0] ?? "";
}

async function addOverSsh(deps: Wired, runner: RemoteRunner, opts: AddOptions): Promise<number> {
  const { host, port, flags } = opts;

  // ── Leg 1 — probe ──────────────────────────────────────────────────────────
  deps.emit({ kind: "leg-start", leg: "probe", text: `probing ${host}…` });
  const probed = await runner.run(probeScript({ path: flags.path ?? null, port }));
  const transport = transportFailure(deps.io, host, probed);
  if (transport !== null) return transport;
  const probe = parseProbe(probed.stdout);
  if (probe === null) {
    deps.io.err(`error: ${host} answered the probe with something this build cannot read.`);
    deps.io.err(probed.stderr.trim() === "" ? "       (it printed nothing on stderr)" : `       ${firstLine(probed.stderr)}`);
    return EXIT.FAIL;
  }
  if (probed.code !== 0) {
    deps.io.err(`error: the probe exited ${probed.code} on ${host} — ${firstLine(probed.stderr)}`);
    return EXIT.FAIL;
  }

  // WHAT THE MEMBER NEEDS DEPENDS ON THE ROUTE, and on nothing else. A bundle member builds from
  // source, so it needs git and Bun; a release member downloads a payload and verifies it, so it
  // needs curl, tar and a sha256 tool and needs neither of the other two. Herdr is required on both.
  const required =
    opts.route === "bundle"
      ? ([
          ["git", probe.git, "install git there (the lead pushes its own commit as a `git bundle`)"],
          ["bun", probe.bun, "install Bun there: https://bun.sh (Collie is source-distributed and builds natively)"],
        ] as const)
      : ([
          ["curl", probe.curl, "install curl there (the member downloads the release itself)"],
          ["tar", probe.tar, "install tar there (the release ships as a tarball)"],
          ["sha256", probe.sha256, "install sha256sum or shasum there (the download is verified before it is unpacked)"],
        ] as const);
  for (const [tool, path, hint] of required) {
    if (path === "") {
      deps.io.err(`error: no \`${tool}\` on ${host} — ${hint}`);
      return EXIT.FAIL;
    }
    deps.emit({ kind: "fact", name: tool, value: path });
  }
  if (probe.herdr === "") {
    // Not a bug and not an unimplemented feature: Collie is a Herdr plugin, and a Collie with no
    // herd has nothing to show. The standalone future is discussion #67 — named as `not yet`.
    deps.io.err(`error: no \`herdr\` on ${host} — Collie is a Herdr plugin, and a Collie with no herd`);
    deps.io.err("       has nothing to show. Install Herdr there first.");
    deps.io.err("       (A standalone Collie is discussion #67 — not yet, and not a bug.)");
    return EXIT.FAIL;
  }
  deps.emit({ kind: "fact", name: "herdr", value: probe.herdr });

  const configDir = probe.configdir;
  if (configDir === "") {
    deps.io.err(`error: Herdr is installed on ${host}, but it did not answer with a config directory.`);
    deps.io.err(`       asked:  ${probe.herdr} plugin config-dir ${PLUGIN_ID}`);
    deps.io.err("       got:    (nothing)");
    deps.io.err("       Run that by hand there. `crew add` never invents a path it did not observe.");
    return EXIT.FAIL;
  }
  deps.emit({ kind: "fact", name: "config", value: configDir });

  // The address the lead will dial. Read off the remote; asked only when it cannot answer.
  const peerHost = await resolvePeerHost(deps, probe, flags["peer-address"]);
  if (peerHost === null) return EXIT.FAIL;
  const peerAddress = `${peerHost}:${port}`;
  deps.emit({ kind: "fact", name: "address", value: `${peerAddress} (what this lead will dial)` });

  // The install target: the Collie leg 1 FOUND, else the path this route would create one at — the
  // bundle route clones into `.collie`, and the release route lets install.sh use its own default.
  // Even the green-field path is anchored to the `$HOME` the remote reported rather than a guess.
  const memberKind = memberInstallKind(probe);
  const collieDir =
    probe.installroot !== "" ? probe.installroot : (flags.path ?? `${probe.home}/.local/share/collie`);
  const fresh = opts.route === "release" ? `${collieDir}/current` : `${probe.home}/.collie`;
  const root = probe.checkout === "" ? fresh : probe.checkout;
  // A busy port is a collision ONLY when it is not this collie's own listener. Re-running `crew add`
  // against a host it already installed must find that port taken and say so as a `✓`.
  const alreadyOnPort = probe.checkout !== "" && configuredPort(probe) === port;
  if (probe.port === "busy" && !alreadyOnPort) {
    deps.io.err(`error: something is already listening on port ${port} at ${host}, and it is not a Collie`);
    deps.io.err("       this host has configured. Choose another with `--port <n>`.");
    return EXIT.FAIL;
  }
  if (probe.port === "unknown") {
    deps.emit({
      kind: "line",
      // On stdout, not stderr, and it always has been: it is a caveat on a step that SUCCEEDED.
      stream: "out",
      tone: "warn",
      text: `warn: could not probe port ${port} on ${host} (no \`ss\`/\`netstat\` there) — a collision would surface at first start`,
    });
  } else {
    deps.emit({
      kind: "fact",
      name: "port",
      // "nothing was listening just now", not "free" (Q2). See {@link probeScript}: this is one
      // `ss -ltn` at one instant, and `free` claims a durable property the probe cannot observe.
      value: `${port} ${probe.port === "busy" ? "already carries this collie" : "nothing was listening just now"}`,
    });
  }
  deps.emit({ kind: "leg-done", leg: "probe", ok: true, detail: `${host} is ready` });

  // ── Leg 2 — install ────────────────────────────────────────────────────────
  // `replaced` is what leg 4 reads: an already-enrolled peer is restarted only when there is
  // something new for it to run. Both routes answer it, in their own terms.
  const rebound = !bindIsCurrent(probe, peerHost, port);
  const installed =
    opts.route === "release"
      ? await releaseLeg(deps, runner, {
          host,
          collieDir,
          version: opts.leadVersion,
          repo: opts.repo,
          probe,
          memberKind,
        })
      : await bundleLeg(deps, runner, { host, root, probe, memberKind });
  if ("code" in installed) return installed.code;
  const replaced = installed.replaced;

  // ── Leg 3 — configure ──────────────────────────────────────────────────────
  deps.emit({ kind: "leg-start", leg: "configure", text: "" });
  const configured = await configureLeg(deps, runner, {
    host,
    root,
    configDir,
    peerHost,
    port,
    instance: opts.instance,
    mux: opts.mux,
    probe,
  });
  if (configured !== null) return configured;

  // ── Leg 4 — enroll ─────────────────────────────────────────────────────────
  deps.emit({ kind: "leg-start", leg: "enroll", text: "" });
  return await enrollLeg(deps, runner, { host, root, port, peerAddress, flags, changed: replaced || rebound });
}

/**
 * What leg 2 tells the rest of the run, whichever route it took: the code this run ends with, or
 * whether it put new code on the far machine (leg 4 restarts an enrolled peer on that).
 *
 * The same shape {@link Chosen} uses, and for the same reason: two outcomes that are not each
 * other's failure, told apart by a field rather than by what a number looks like.
 */
type Installed = { readonly code: number } | { readonly replaced: boolean };

/**
 * Leg 2 on the BUNDLE route — this lead's own commit, pushed as a `git bundle` (ADR 0015).
 *
 * Unchanged in every byte an operator reads, with one refusal added: a member that takes RELEASES
 * is no longer written over. Before this, the probe could not see such a member at all, so a bundle
 * push cloned a second Collie into `~/.collie` and left the install.sh one running beside it.
 */
async function bundleLeg(
  deps: Wired,
  runner: RemoteRunner,
  o: { host: string; root: string; probe: Probe; memberKind: MemberKind },
): Promise<Installed> {
  const { probe } = o;
  if (o.memberKind === "binary") {
    deps.io.err(`error: ${o.host} has a binary install at ${probe.installroot}, which takes releases, and this`);
    deps.io.err("       lead pushes its own git commit. Move that install aside there, or add");
    deps.io.err(`       ${o.host} from a lead that runs a release.`);
    return { code: EXIT.STATE };
  }
  const commit = gitOut(deps, ["rev-parse", "HEAD"]);
  if (commit === null) {
    deps.io.err(`error: cannot read this checkout's commit — ${deps.ctx.root} is not a git checkout.`);
    return { code: EXIT.FAIL };
  }
  const version = manifestVersionAt(deps, commit);
  if (version === null) {
    deps.io.err(`error: cannot read herdr-plugin.toml at ${commit.slice(0, 12)} — nothing to pin the install to.`);
    return { code: EXIT.FAIL };
  }
  if (gitOut(deps, ["status", "--porcelain"]) !== "") {
    deps.io.err("warn: this checkout has uncommitted changes — the bundle carries the COMMIT, so they are");
    deps.io.err(`      not shipped. ${o.host} will run ${version} at ${commit.slice(0, 12)}.`);
  }

  deps.emit({ kind: "leg-start", leg: "install", text: "" });
  if (probe.commit === commit) {
    deps.emit({
      kind: "leg-done",
      leg: "install",
      ok: true,
      detail: `already at ${probe.version || version} (${commit.slice(0, 12)}) — nothing sent`,
    });
    return { replaced: false };
  }
  const blocked = await installLeg(deps, runner, { host: o.host, root: o.root, commit, version, probe });
  if (blocked !== null) return { code: blocked };
  return { replaced: true };
}

/**
 * Leg 2 on the RELEASE route — the release THIS LEAD RUNS, laid down by Collie's own installer (#248).
 *
 * The member decides what happens, from what leg 1 saw there. A machine with no Collie gets one; a
 * machine with an install.sh layout is asked before it is moved; a machine running a git checkout is
 * REFUSED rather than converted, because a checkout is somebody's working tree and the remedy for it
 * is one command typed there; a Collie that is neither is left alone and added by hand.
 *
 * The version the member reports is cut back to its release before it is compared ({@link releaseOf}):
 * a built Collie answers `1.11.1+ab12cd3`, and the tag is `v1.11.1`.
 */
async function releaseLeg(
  deps: Wired,
  runner: RemoteRunner,
  o: {
    host: string;
    collieDir: string;
    version: string;
    repo: string;
    probe: Probe;
    memberKind: MemberKind;
  },
): Promise<Installed> {
  const { probe } = o;
  const tag = `v${o.version}`;
  const sameRelease = probe.version !== "" && releaseOf(probe.version) === o.version;
  const nothingSent = (): Installed => {
    deps.emit({ kind: "leg-start", leg: "install", text: "" });
    deps.emit({
      kind: "leg-done",
      leg: "install",
      ok: true,
      detail: `already at ${probe.version} — nothing sent`,
    });
    return { replaced: false };
  };
  if (o.memberKind === "git") {
    // Not a refusal about this lead: the member's own `update` takes a tag, and running it there is
    // one command. Converting a checkout into a release layout from here would move a working tree.
    if (sameRelease) return nothingSent();
    deps.io.err(`error: ${o.host} runs Collie from a git checkout at ${probe.checkout}, and this lead has no`);
    deps.io.err(`       commit to push. On ${o.host}, run \`collie update --to-tag ${tag}\` (or check that tag`);
    deps.io.err("       out), then re-run. Nothing was installed, configured or enrolled.");
    return { code: EXIT.STATE };
  }
  if (o.memberKind === "other") {
    deps.io.err(`error: the Collie at ${probe.checkout} on ${o.host} is neither a git checkout nor an`);
    deps.io.err("       install.sh layout, so this lead has no safe way to advance it. Add it by hand:");
    deps.io.err(`       run \`collie crew invite\` here, and the \`collie join\` line it prints on ${o.host}.`);
    return { code: EXIT.STATE };
  }
  if (o.memberKind === "binary") {
    if (sameRelease) return nothingSent();
    const answer = await ask(
      deps,
      `${o.host} has Collie ${probe.version || "(unreadable)"} at ${probe.installroot}; replace it with ${o.version}?`,
    );
    if (answer === "aborted") return { code: EXIT.FAIL };
    if (!answer) {
      deps.io.err("error: left alone — nothing was installed, configured or enrolled.");
      return { code: EXIT.STATE };
    }
  }

  deps.emit({ kind: "leg-start", leg: "install", text: "" });
  deps.emit({
    kind: "line",
    stream: "out",
    tone: "info",
    text: `  installing ${tag} from ${o.repo} at ${o.collieDir} on ${o.host}…`,
  });
  const { result: laid, version: built } = await runInstallRelease(
    runner,
    { installRoot: o.collieDir, tag, repo: o.repo, version: o.version },
    INSTALLER_SH,
  );
  const transport = transportFailure(deps.io, o.host, laid);
  if (transport !== null) return { code: transport };
  if (laid.code !== 0) {
    deps.io.err(`error: the install failed on ${o.host} — ${installerErrorLine(laid.stderr)}`);
    deps.io.err(`       Nothing was configured or enrolled. ${o.host} runs what it ran before.`);
    return { code: EXIT.FAIL };
  }
  if (built === null) {
    deps.io.err(`error: the install on ${o.host} reported nothing this build can read.`);
    return { code: EXIT.FAIL };
  }
  deps.emit({ kind: "leg-done", leg: "install", ok: true, detail: `${built} at ${o.collieDir}/current` });
  if (probe.checkout === "") {
    for (const text of [
      `  This checkout is not registered with Herdr there. To get its plugin actions:`,
      `    herdr plugin link "${o.collieDir}/current"   # on ${o.host}`,
    ]) {
      deps.emit({ kind: "line", stream: "out", tone: "info", text });
    }
  }
  return { replaced: true };
}

/**
 * The line to quote from the release leg's stderr.
 *
 * {@link errorLine} reads the `error:` verdict every leg script writes, and this leg has a second
 * voice on that stream: `scripts/install.sh` says `collie install: …` and its ordinary progress
 * lines are there too (leg stdout carries the markers alone). The installer's own diagnosis is the
 * last of the two prefixes, so it is the one the operator is shown.
 *
 * Exported because `crew update` runs the same leg (#248), and two verbs quoting different lines out
 * of one failure is two bug reports about one bug.
 */
export const installerErrorLine = (text: string): string => {
  const own = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("error:") || l.startsWith("collie install:"));
  return own.length === 0 ? errorLine(text) : own[own.length - 1]!;
};

/** Leg 2, as its own step: the prompts, the bundle push and the post-install version check. */
async function installLeg(
  deps: Wired,
  runner: RemoteRunner,
  o: {
    host: string;
    root: string;
    commit: string;
    version: string;
    probe: Probe;
  },
): Promise<number | null> {
  const { probe } = o;
  if (probe.checkout !== "") {
    // A dirty checkout is REFUSED rather than prompted. A y/N in front of a `git checkout` that
    // would discard someone's work on their own dev machine is consent theatre: the remedy is one
    // command on that machine, and it is theirs to choose.
    if (probe.dirty === "yes") {
      deps.io.err(`error: the Collie checkout at ${probe.checkout} has uncommitted changes:`);
      deps.io.err(`       ${probe.dirtyfiles}`);
      deps.io.err(`       \`git stash\` or commit them on ${o.host}, then re-run. \`crew add\` will not`);
      deps.io.err("       discard work it did not create.");
      return EXIT.STATE;
    }
    const answer = await ask(
      deps,
      `${o.host} has Collie ${probe.version || "(unbuilt)"} at ${probe.commit.slice(0, 12) || "?"}; replace it with ${o.version} (${o.commit.slice(0, 12)})?`,
    );
    if (answer === "aborted") return EXIT.FAIL;
    if (!answer) {
      deps.io.err("error: left alone — nothing was installed, configured or enrolled.");
      return EXIT.STATE;
    }
    if (probe.branch !== "") {
      deps.io.err(`warn: ${probe.checkout} is on branch "${probe.branch}" and will be left DETACHED at the`);
      deps.io.err("      pushed commit — which is the shape `herdr plugin install` leaves, and the shape");
      deps.io.err("      `collie update` there will then advance (ADR 0006).");
    }
  }

  const bundle = await deps.gitBundle(o.commit, deps.io);
  if (bundle === null) {
    deps.io.err(`error: could not bundle ${o.commit.slice(0, 12)} from ${deps.ctx.root}.`);
    return EXIT.FAIL;
  }
  deps.emit({
    kind: "line",
    stream: "out",
    tone: "info",
    text: `  pushing ${o.commit.slice(0, 12)} (${Math.round(bundle.length / 1024)} KiB base64) to ${o.root}…`,
  });
  const { result: installed, version: built } = await runInstall(
    runner,
    { root: o.root, commit: o.commit, version: o.version },
    bundle,
  );
  const transport = transportFailure(deps.io, o.host, installed);
  if (transport !== null) return transport;
  if (installed.code !== 0) {
    deps.io.err(`error: the install failed on ${o.host} — ${errorLine(installed.stderr)}`);
    deps.io.err(`       The checkout at ${o.root} was left in place; nothing was configured or enrolled.`);
    return EXIT.FAIL;
  }
  if (built === null) {
    deps.io.err(`error: the install on ${o.host} reported nothing this build can read.`);
    return EXIT.FAIL;
  }
  deps.emit({ kind: "leg-done", leg: "install", ok: true, detail: `${built} at ${o.root}` });
  if (probe.checkout === "") {
    for (const text of [
      `  This checkout is not registered with Herdr there. To get its plugin actions:`,
      `    herdr plugin link "${o.root}"   # on ${o.host}`,
    ]) {
      deps.emit({ kind: "line", stream: "out", tone: "info", text });
    }
  }
  return null;
}

/**
 * Is the far machine already bound where this run would bind it? Read by leg 3 (to skip) and by the
 * caller (to know whether this run CHANGED anything there) — one predicate, so the two can never
 * disagree about whether a write happened.
 */
function bindIsCurrent(probe: Probe, peerHost: string, port: number): boolean {
  return probe.envhost === peerHost && configuredPort(probe) === port;
}

/**
 * Which multiplexer the MEMBER should drive, and how that was settled.
 *
 * ── WHY THE LEAD DECIDES THIS AT ALL ────────────────────────────────────────
 * Leg 4 ends in `collie join` on the member, and every membership verb restarts the machine it ran
 * on. That restart runs `chooseMux` (`cli/mux.ts`) with nobody at a terminal, so a member running
 * two multiplexers refused to start: the trust store was updated, the old bridge kept running, and
 * the operator had to set `COLLIE_MUX` there by hand (#248). The operator at a terminal is the
 * LEAD'S operator, so the lead asks the question while they are still standing there.
 *
 * ── THE ORDER, AND WHY EACH STEP IS WHERE IT IS ─────────────────────────────
 *  • `--mux` wins outright. It is the operator's own sentence, typed on this command line, and it
 *    is written even over a name the member already carries — that is the whole point of a flag
 *    that exists to correct one.
 *  • A member that already names one is LEFT ALONE, and its machine is not even read. `.env` is
 *    what a supervised bridge there reads, so a name in it is already the answer.
 *  • Otherwise the member's own binary is asked, and the answer decides: one sighting needs no
 *    write at all (the member's first `start` records it itself), none is a warning and not a stop,
 *    and several is the standoff — which only a person can end.
 *
 * `answer` is null until that question has been asked, which is what `unread` reports: nothing on
 * the lead settles it, so the member has to be read. Pure, and the only decision site — the leg
 * below words it and writes it, and decides nothing.
 */
export type MuxChoice =
  | { readonly kind: "flag"; readonly mux: string }
  | { readonly kind: "kept"; readonly mux: string }
  | { readonly kind: "auto"; readonly mux: string }
  | { readonly kind: "picked"; readonly mux: string }
  | { readonly kind: "none" }
  | {
      readonly kind: "ask";
      readonly found: readonly MuxProbeSighting[];
      /** The lead's own multiplexer, when it is one of `found` — said out loud before the question. */
      readonly leadDrives: string | null;
    }
  | { readonly kind: "unread" };

export function muxChoice(opts: {
  readonly flag: string | null;
  readonly envmux: string;
  readonly answer: MuxProbeReport | null;
  readonly leadMux: string | null;
}): MuxChoice {
  if (opts.flag !== null) return { kind: "flag", mux: opts.flag };
  if (opts.envmux !== "") return { kind: "kept", mux: opts.envmux };
  if (opts.answer === null) return { kind: "unread" };
  const found = opts.answer.found;
  if (found.length === 0) return { kind: "none" };
  const only = found.length === 1 ? found[0] : undefined;
  if (only !== undefined) return { kind: "auto", mux: only.mux };
  const leadDrives = found.some((sighting) => sighting.mux === opts.leadMux) ? opts.leadMux : null;
  return { kind: "ask", found, leadDrives };
}

/**
 * How a `--mux` write reads, given what the member's own `.env` already said.
 *
 * A flag that REPLACES a name somebody put there is the one case an operator has to see, so the
 * row says which name went away. A flag that merely restates the file's own value is not a change
 * and does not pretend to be one.
 */
function flagHow(mux: string, envmux: string): string {
  if (envmux === "") return "named with --mux";
  return envmux === mux
    ? "named with --mux, already set there"
    : `named with --mux, replaces ${envmux} already set there`;
}

/** How many typos the member's picker forgives, matching `cli/mux.ts`'s own bound. */
const MUX_PICKER_ATTEMPTS = 3;

/** A row number, or the multiplexer's own name — both are on the screen, as in `cli/mux.ts`. */
function matchMuxAnswer(
  found: readonly MuxProbeSighting[],
  answer: string,
): MuxProbeSighting | undefined {
  if (/^\d+$/.test(answer)) return found[Number(answer) - 1];
  return found.find((sighting) => sighting.mux === answer.toLowerCase());
}

/**
 * The bind this run would OVERWRITE, when overwriting it is a decision the operator has to take —
 * `null` when it is not, and the write may just happen.
 *
 * The confirmation exists for one case: the far machine already carries a bind somebody chose, and
 * this run is about to replace it with a different one. That case is untouched here, wide binds
 * included — a non-loopback COLLIE_HOST somebody set is exactly the value that must not vanish under
 * a re-run without a yes.
 *
 * **An UNSET COLLIE_HOST is not that case.** It is the state a solo collie is in by default, and the
 * state `collie leave` deliberately restores (F12: the crew's wide bind is admitted by the crew's two
 * factors and lapses with them). There is nothing there to preserve, so there is nothing to confirm —
 * and asking anyway made `crew add` non-idempotent in the one direction that matters: the first add
 * of a fresh machine asked nothing, while the re-add of a machine torn down properly always asked,
 * and hard-stopped every non-interactive run on `configured to bind (unset):8787` (F23). `ssh -tt`
 * did not get past it, because a piped `y` is not a terminal either.
 *
 * The port half keeps its own guard for the same reason the host half does: a COLLIE_PORT the far
 * machine already carries was chosen there, and moving a listener is a decision too.
 */
export function bindOverwriteConfirmation(probe: Probe, peerHost: string, port: number): string | null {
  const hostDisagrees = probe.envhost !== "" && probe.envhost !== peerHost;
  const portDisagrees = probe.envport !== "" && configuredPort(probe) !== port;
  if (!hostDisagrees && !portDisagrees) return null;
  // No `(unset)` placeholder: every value named here is one the far machine really carries. When only
  // the port disagrees the host is the one this run is about to write, and the line reads as such.
  return `${probe.envhost === "" ? peerHost : probe.envhost}:${probe.envport === "" ? port : probe.envport}`;
}

/**
 * The mux half of leg 3: decide, say so, and hand back the name to write (null writes none).
 *
 * It runs BEFORE the bind confirmation because it is the half that can stop the run, and a run that
 * is going to stop must not first ask about the bind. `{ code }` is that stop.
 */
async function decideMux(
  deps: Wired,
  runner: RemoteRunner,
  o: { host: string; root: string; mux: string | null; probe: Probe },
): Promise<{ readonly code: number } | { readonly write: string | null }> {
  const leadMux = explicitMux(deps.ctx.env);
  const asked = { flag: o.mux, envmux: o.probe.envmux, leadMux };
  const known = muxChoice({ ...asked, answer: null });
  let decision = known;
  if (known.kind === "unread") {
    const answered = await runner.run(muxProbeScript(o.root));
    const transport = transportFailure(deps.io, o.host, answered);
    if (transport !== null) return { code: transport };
    const report = answered.code === 0 ? parseMuxProbe(answered.stdout) : null;
    if (report === null) {
      // The third error family. A member whose multiplexers cannot be read is one nobody may pick
      // for, so this refuses rather than writing a guess into its `.env`.
      deps.io.err(`error: could not read which multiplexers run on ${o.host}.`);
      deps.io.err(`       asked:  ${o.root}/bin/collie _mux-probe`);
      deps.io.err(
        answered.stderr.trim() === "" ? "       got:    (nothing)" : `       got:    ${firstLine(answered.stderr)}`,
      );
      deps.io.err(`       Name it instead: \`collie crew add ${o.host} --mux <name>\`.`);
      return { code: EXIT.FAIL };
    }
    decision = muxChoice({ ...asked, answer: report });
  }
  const say = (mux: string, how: string): void => {
    deps.emit({ kind: "fact", name: "mux", value: `${mux} (${how})` });
  };
  switch (decision.kind) {
    case "flag":
      say(decision.mux, flagHow(decision.mux, o.probe.envmux));
      return { write: decision.mux };
    case "kept":
      say(decision.mux, "already set there");
      return { write: null };
    case "auto":
      // Nothing is written: `start` on the member records the one it found itself, endpoint and all
      // (`muxVars`), which is a stronger write than a bare name from here.
      say(decision.mux, "the only one running there");
      return { write: null };
    case "none":
      deps.emit({
        kind: "line",
        // On stdout and as a caveat, exactly as the unprobeable port above it: the member is
        // installed and will be enrolled, and this is a thing to fix there, not a failure here.
        stream: "out",
        tone: "warn",
        text:
          `warn: no multiplexer is running on ${o.host}. The restart that ends this run will refuse` +
          " there until one runs, or until `--mux <name>` names one; the member is enrolled either way.",
      });
      return { write: null };
    case "ask":
      return await pickMux(deps, o.host, decision.found, decision.leadDrives, say);
    default:
      // `picked` is this leg's own answer to `ask`, and `unread` was resolved above. Neither is
      // reachable, and neither may quietly become "write nothing".
      throw new Error(`unreachable mux decision: ${decision.kind}`);
  }
}

/** The standoff, ended by the operator at the lead's terminal — or refused when nobody is there. */
async function pickMux(
  deps: Wired,
  host: string,
  found: readonly MuxProbeSighting[],
  leadDrives: string | null,
  say: (mux: string, how: string) => void,
): Promise<{ readonly code: number } | { readonly write: string | null }> {
  const names = found.map((sighting) => sighting.mux).join(", ");
  deps.io.out(`${host} runs ${String(found.length)} multiplexers:`);
  deps.io.out("");
  for (const [index, sighting] of found.entries()) {
    deps.io.out(`  ${String(index + 1)}) ${sighting.mux.padEnd(7)} ${sighting.evidence}`);
  }
  deps.io.out("");
  // A fact, not a default: the operator still types. A lead and a member that drive the same
  // multiplexer is the ordinary case, and it is the one thing the lead knows that they may not.
  if (leadDrives !== null) deps.io.out(`This lead drives ${leadDrives}. The member does not have to match.`);
  for (let attempt = 1; attempt <= MUX_PICKER_ATTEMPTS; attempt++) {
    const answer = await deps.prompt(`which one should Collie drive on ${host}? [1-${String(found.length)}] `);
    if (answer === null) {
      deps.io.err(
        `error: ${host} runs ${String(found.length)} multiplexers (${names}), and this run is not` +
          " interactive, so nobody can pick one.",
      );
      deps.io.err(
        `       Re-run from a terminal, or name it: \`collie crew add ${host} --mux <name>\`.` +
          " The member is installed and unchanged otherwise.",
      );
      return { code: EXIT.STATE };
    }
    const chosen = matchMuxAnswer(found, answer.trim());
    if (chosen !== undefined) {
      say(chosen.mux, "you picked it");
      return { write: chosen.mux };
    }
    if (attempt < MUX_PICKER_ATTEMPTS) deps.io.err(`"${answer.trim()}" is not one of them.`);
  }
  deps.io.err(`error: no multiplexer was picked for ${host}, so its .env was not written.`);
  deps.io.err(`       Re-run, or name it: \`collie crew add ${host} --mux <name>\`.`);
  return { code: EXIT.STATE };
}

/** Leg 3, as its own step: decide the multiplexer, then skip, prompt, or write the peer's `.env`. */
async function configureLeg(
  deps: Wired,
  runner: RemoteRunner,
  o: {
    host: string;
    root: string;
    configDir: string;
    peerHost: string;
    port: number;
    instance: string | null;
    mux: string | null;
    probe: Probe;
  },
): Promise<number | null> {
  const { probe } = o;
  // The mux decision FIRST: it is the half that can stop the run.
  const decided = await decideMux(deps, runner, { host: o.host, root: o.root, mux: o.mux, probe });
  if ("code" in decided) return decided.code;
  const writeMux = decided.write;
  const bindCurrent = bindIsCurrent(probe, o.peerHost, o.port);
  // The leg writes when EITHER half has something to write. A bind that is already right used to
  // skip the whole leg, which would now skip a `COLLIE_MUX` the operator has just chosen.
  if (bindCurrent && writeMux === null) {
    deps.emit({ kind: "leg-done", leg: "configure", ok: true, detail: `already ${o.peerHost}:${o.port}` });
    return null;
  }
  const current = bindOverwriteConfirmation(probe, o.peerHost, o.port);
  if (current !== null) {
    const answer = await ask(deps, `${o.host} is configured to bind ${current}; change it to ${o.peerHost}:${o.port}?`);
    if (answer === "aborted") return EXIT.FAIL;
    if (!answer) {
      deps.io.err("error: left alone — the bind was not changed, and nothing was enrolled.");
      deps.io.err("       A peer the lead cannot dial stays provisional forever (`collie doctor` there).");
      return EXIT.STATE;
    }
  } else if (probe.envhost === "") {
    // Said out loud, because a step that stopped asking is otherwise a step that silently changed.
    deps.emit({
      kind: "line",
      stream: "out",
      tone: "info",
      text:
        `  ${o.host} has no COLLIE_HOST — the default state of a solo collie, and the one` +
        " `collie leave` restores. Nothing to preserve there, so nothing to confirm.",
    });
  }
  const written = await runner.run(
    configureScript({
      configDir: o.configDir,
      host: o.peerHost,
      port: o.port,
      mux: writeMux,
      instance: o.instance,
    }),
  );
  const transport = transportFailure(deps.io, o.host, written);
  if (transport !== null) return transport;
  if (written.code !== 0) {
    deps.io.err(`error: could not write the peer's .env — ${firstLine(written.stderr)}`);
    return EXIT.FAIL;
  }
  // What was WRITTEN, named: the leg now has two halves, and a re-run that only moved the
  // multiplexer must not report a bind it left alone.
  const wrote = [
    ...(bindCurrent ? [] : [`${o.peerHost}:${o.port}`]),
    ...(writeMux === null ? [] : [`COLLIE_MUX=${writeMux}`]),
  ];
  deps.emit({
    kind: "leg-done",
    leg: "configure",
    ok: true,
    detail: `${wrote.join(" and ")} written to ${o.configDir}/.env`,
  });
  // ADR 0013: a peer publishes nothing. Said out loud, because the absence of a step is invisible.
  deps.emit({
    kind: "line",
    stream: "out",
    tone: "info",
    text: "  No front door was published there — a peer publishes none (ADR 0013).",
  });
  return null;
}

/** Leg 4, as its own step: the membership pre-check, the invite, the join, and the final verdict. */
async function enrollLeg(
  deps: Wired,
  runner: RemoteRunner,
  o: {
    host: string;
    root: string;
    port: number;
    peerAddress: string;
    flags: Readonly<Record<string, string>>;
    /** Did this run replace the far machine's build or rewrite its bind? */
    changed: boolean;
  },
): Promise<number> {
  // How this run reached the far machine, banked for `crew update` the moment the run proves it
  // works. Operator-local convenience, never a wire field (ADR 0016) — and written only on a leg
  // that SUCCEEDED, so a host that never answered is never remembered as one that does.
  const remember = async (memberId: string): Promise<void> => {
    const record: OpsRecord = {
      sshHost: o.host,
      path: o.root,
      port: o.port,
      recordedAt: deps.now(),
    };
    if (!(await deps.ops.record(memberId, record))) {
      deps.io.err(`warn: could not record how ${o.host} was reached — the ops file is not one this build`);
      deps.io.err("      can read, and was left untouched. `collie crew update` will ask for --host there.");
    }
  };
  const status = await runner.run(membershipScript(o.root));
  const transport = transportFailure(deps.io, o.host, status);
  if (transport !== null) return transport;
  if (status.code !== 0) {
    deps.io.err(`error: \`collie crew status\` exited ${status.code} on ${o.host} — ${firstLine(status.stderr)}`);
    return EXIT.FAIL;
  }
  const membership = parseMembership(status.stdout);
  if (membership === null) {
    deps.io.err(`error: ${o.host} answered \`crew status\` with something this build cannot read.`);
    return EXIT.FAIL;
  }

  const data = await ensureStore(deps, o.flags.as);
  if (data === null) return EXIT.FAIL;
  if (membership.packId !== null) {
    if (data.crew !== null && membership.packId === data.crew.crewId) {
      if (membership.memberId !== null) await remember(membership.memberId);
      // ── THE ALREADY-A-MEMBER PATH RESTARTS THE FAR MACHINE ──────────────────
      // No `collie join` runs here, and a join is the ONLY thing that restarts a peer from this verb
      // (every membership verb restarts on the machine it ran on, `cli/crew.ts`). So a re-run against
      // an enrolled peer used to leave the new build on disk with the OLD process still answering —
      // the operator had just consented to "replace it with <version>", and this line then said the
      // replacement had happened while `crew status` kept reporting the old version. Restart only
      // when something actually changed there: an unchanged re-run must stay the no-op it is.
      if (o.changed) {
        const failed = await restartRemote(deps, runner, o.host, o.root);
        if (failed !== null) return failed;
      }
      deps.emit({
        kind: "verdict",
        ok: true,
        text:
          `already a member of "${membership.crewName}" as "${membership.memberId}"` +
          (o.changed ? await reportedNow(deps, data, membership.memberId) : ""),
      });
      return EXIT.OK;
    }
    deps.io.err(`error: ${o.host} is already a member of crew "${membership.crewName}" (${membership.packId}).`);
    deps.io.err(`       Run \`collie leave\` THERE first — never run for you: leaving a crew is a decision`);
    deps.io.err("       taken on the machine that is leaving (§8.4).");
    return EXIT.STATE;
  }

  // What the far side will `collie join` — this lead's front door, the same string `crew invite` prints.
  const lead = resolveSelfAddress(deps, o.flags.address, "front-door");
  if (lead === null) {
    deps.io.err("error: cannot work out an address this lead can be dialled at.");
    deps.io.err("       Pass one: `collie crew add <host> --address <this-lead-address>`.");
    return EXIT.FAIL;
  }
  const leadAddress = lead.address;
  // Named once, because it is the string the peer will dial forever and the operator did not type it
  // on this command line — a config value silently steering an enrollment is exactly what the
  // `--address`-only era made hard to see.
  if (lead.source === "public-url") {
    deps.emit({
      kind: "line",
      stream: "out",
      tone: "info",
      text: `  lead address ${leadAddress} (from COLLIE_PUBLIC_URL)`,
    });
  }

  const before = new Set(data.peers.map((p) => p.memberId));
  const minted = await commitCrewChange(deps.store, deps.audit, (current) =>
    current === null
      ? null
      : mintInvite(current, {
          now: deps.now(),
          label: o.flags.label ?? null,
          crewName: o.flags.name,
          random: deps.random,
        }),
  );
  if (minted === null) return EXIT.FAIL;
  deps.emit({
    kind: "line",
    stream: "out",
    tone: "info",
    text: "  minted a single-use, ten-minute invite; restarting the bridge so it can answer it…",
  });
  if ((await restartBridge(deps)) !== EXIT.OK) {
    deps.io.err("warn: the restart failed — the invite IS minted, but the running bridge still holds the");
    deps.io.err("      previous store and will refuse it. Run `collie restart` here, then re-run.");
  }

  // `<token>.<lead-fingerprint>` (§8.2), exactly the string `crew invite` prints — and it goes only
  // onto the ssh stream. It is never echoed, never an argument and never in an environment variable.
  const enrolled = await runner.run(
    enrollScript({
      root: o.root,
      leadAddress,
      peerAddress: o.peerAddress,
      label: o.flags.label ?? null,
    }),
    `${minted.token}.${data.self.fingerprint}`,
  );
  const enrollTransport = transportFailure(deps.io, o.host, enrolled);
  if (enrollTransport !== null) return enrollTransport;
  if (enrolled.code !== EXIT.OK) {
    for (const line of enrolled.stderr.split("\n")) if (line.trim() !== "") deps.io.err(line);
    // `collie join`'s own codes, passed through: they already distinguish refused from unreachable
    // from local state, and re-deciding them here would make one verb disagree with the other.
    if (enrolled.code === EXIT.REFUSED) return EXIT.REFUSED;
    if (enrolled.code === EXIT.UNREACHABLE) {
      deps.io.err(`       ${o.host} could not reach ${leadAddress}. That is the lead's ingress, not the peer's.`);
      deps.io.err(
        "       If that address is not dialable from there (reverse proxy, tailnet ACL), re-run with " +
          "--address <an-address-the-peer-CAN-dial>.",
      );
      return EXIT.UNREACHABLE;
    }
    if (enrolled.code === EXIT.STATE) return EXIT.STATE;
    return EXIT.FAIL;
  }
  deps.emit({ kind: "leg-done", leg: "enroll", ok: true, detail: `${o.host} answered the invite` });

  deps.emit({
    kind: "line",
    stream: "out",
    tone: "info",
    text: "  restarting the bridge so the new member takes effect…",
  });
  await restartBridge(deps);
  return verdict(deps, before, o.host, remember);
}

/**
 * `collie restart` on the far machine, said out loud. `null` when it came back.
 *
 * The far machine's own verb, run there — never a unit name guessed from here, which this side has no
 * business knowing (CLAUDE.md).
 */
async function restartRemote(
  deps: Wired,
  runner: RemoteRunner,
  host: string,
  root: string,
): Promise<number | null> {
  deps.emit({
    kind: "line",
    stream: "out",
    tone: "info",
    text: `  restarting Collie on ${host} so the build it just took is the one it runs…`,
  });
  const restarted = await runner.run(restartScript(root));
  const transport = transportFailure(deps.io, host, restarted);
  if (transport !== null) return transport;
  if (restarted.code !== 0) {
    deps.io.err(`error: \`collie restart\` exited ${restarted.code} on ${host} — ${errorLine(restarted.stderr)}`);
    deps.io.err(`       The new build is on disk there and the old one is still running. Run`);
    deps.io.err(`       \`collie restart\` on ${host}, or its Herdr restart action.`);
    return EXIT.FAIL;
  }
  return null;
}

/**
 * What the member reports over the crew link NOW — the lead's own view, which is the only thing that
 * proves the restart took. Never fails the verb: an already-enrolled member this lead cannot reach is
 * a pre-existing condition `crew status` reports, not something this run broke.
 */
async function reportedNow(deps: Wired, data: TrustStoreData, memberId: string | null): Promise<string> {
  const member = data.peers.find((p) => p.memberId === memberId);
  if (member === undefined) return " — replaced its build and restarted it";
  const outcome = (await probeMembers(deps, data, [member])).get(member.memberId);
  if (outcome?.ok !== true) {
    deps.io.err(`warn: it was restarted, but this lead cannot reach it at ${member.address} to confirm.`);
    deps.io.err(`      Run \`collie doctor\` there; \`collie crew status\` here shows the same.`);
    return " — replaced its build and restarted it";
  }
  return ` — now running ${outcome.value.version ?? "a version it does not report"}`;
}

/**
 * The last line, and the one a script should branch on: **is the member non-provisional after first
 * contact?** — the lead's own `crew status` view, not the join's exit code, decides it.
 *
 * A `hello` that lands is exactly what `crew status` treats as clearing the provisional marker: the
 * member was enrolled AND has been reached at the address it named. A join that returned 0 into a
 * peer the lead cannot dial is the trap this whole verb exists to close, so it fails here.
 */
async function verdict(
  deps: Wired,
  before: ReadonlySet<string>,
  host: string,
  remember: (memberId: string) => Promise<void>,
): Promise<number> {
  const fresh = await deps.reload();
  const added: TrustedMember | undefined = fresh?.peers.find((p) => !before.has(p.memberId));
  if (fresh === null || fresh.crew === null || added === undefined) {
    deps.io.err(`error: ${host} reported a successful join, but this lead's roster does not name a new member.`);
    deps.io.err("       Check `collie crew status` here and `collie doctor` there.");
    return EXIT.FAIL;
  }
  const probes = await probeMembers(deps, fresh, [added]);
  const outcome = probes.get(added.memberId);
  if (outcome?.ok === true) {
    await remember(added.memberId);
    deps.emit({
      kind: "verdict",
      ok: true,
      text: `"${added.memberId}" is a member of "${fresh.crew.name}" and answered at ${added.address}`,
    });
    return EXIT.OK;
  }
  deps.io.err(`error: "${added.memberId}" enrolled, but this lead cannot reach it at ${added.address} — the`);
  deps.io.err("       member is still PROVISIONAL, which is what a half-finished join looks like (§8.2).");
  deps.io.err(`       Run \`collie doctor\` on ${host}: it names the bind, the ACL and the clock, one per line.`);
  return EXIT.FAIL;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * The first of the three error families: **ssh never started, or could not authenticate.** Keyed off
 * `spawned` and ssh's own 255 — and the agent hint comes from ssh's ACTUAL stderr, never guessed
 * from an exit code, because 255 has a dozen causes and only one of them is a key.
 */
export function transportFailure(io: Io, host: string, r: RemoteResult): number | null {
  if (!r.spawned) {
    io.err(`error: could not start ssh — ${r.stderr.trim() || "it did not run"}.`);
    io.err("       `crew add` rides your own ssh: install it, or run the four steps by hand.");
    return EXIT.UNREACHABLE;
  }
  if (r.code !== 255) return null;
  io.err(`error: ssh could not reach ${host} — ${firstLine(r.stderr)}`);
  if (/Permission denied \(publickey/.test(r.stderr)) {
    io.err("       That is a key problem, not a Collie one: `ssh-add` your key (or name it in");
    io.err(`       ~/.ssh/config for ${host}) and re-run. Collie never touches your ssh configuration.`);
  }
  return EXIT.UNREACHABLE;
}

/**
 * A nested `collie restart`, bracketed.
 *
 * The restart is a whole verb with its own output — two lifecycle lines, the serve config, and the
 * boxed "Collie is running" banner, printed TWICE in one `crew add`. It writes through `deps.io`,
 * which on the rich path is the surface, so the bytes are already contained; the brackets are what
 * let the view collapse the block to one row, and keep it when the restart FAILED.
 */
async function restartBridge(deps: Wired): Promise<number> {
  const unit = unitName(deps.ctx.instance);
  const version = collieVersion(deps.ctx.root, (p) => deps.files.read(p));
  deps.emit({ kind: "restart-begin", label: `bridge restarted (${unit}) · ${version}` });
  const code = await deps.restart(deps.io);
  deps.emit({ kind: "restart-end", ok: code === EXIT.OK });
  return code;
}

export const firstLine = (text: string): string =>
  text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "(it said nothing)";

/**
 * The line to quote from a leg script's stderr: its OWN verdict.
 *
 * Every leg script ends its failing branch with an `error: …` line and a distinct exit code, so that
 * line is the diagnosis — and it is the LAST such line, because a step that fails may print one on
 * the way out of a nested command too. Taking the first non-empty line instead quotes whatever the
 * remote's tools said first, which is not the same thing and in the field was actively misleading:
 * a `crew add` install died with git's harmless `warning: option "updateshallow" is ignored…` in
 * front of it, hiding the build failure the script had already named.
 *
 * Falls back to {@link firstLine} when nothing on stderr is one of ours — a script that died before
 * reaching its own verdict (a shell syntax error, an OOM kill) still gets quoted rather than
 * swallowed.
 */
export const errorLine = (text: string): string => {
  const own = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("error:"));
  return own.length === 0 ? firstLine(text) : own[own.length - 1]!;
};

/** The address the lead will dial, read off the remote — or asked for, never guessed. */
async function resolvePeerHost(
  deps: Wired,
  probe: Probe,
  override: string | undefined,
): Promise<string | null> {
  // The flag was already refused at parse time, before any ssh ran (`crewAddRun`). Anything reaching
  // here is either the address the far machine reported for itself or a value typed at the prompt.
  if (override !== undefined && override !== "") return override;
  if (probe.address !== "") return probe.address;
  const answered = await deps.prompt(
    `This host has no tailnet address. What bare host should this lead dial it at (port ${PEER_HOST_PORT_HINT})?`,
  );
  if (answered === null) {
    deps.io.err("error: this host reported no tailnet address, and this run is not interactive.");
    deps.io.err("       Pass it: `collie crew add <host> --peer-address <bare-host-the-lead-can-dial>`.");
    return null;
  }
  const trimmed = answered.trim();
  if (trimmed === "") {
    deps.io.err("error: no address given — a peer the lead cannot dial stays provisional forever.");
    return null;
  }
  const refusal = peerHostRefusal(trimmed);
  if (refusal !== null) {
    for (const line of peerHostRefusalLines(trimmed, refusal)) deps.io.err(line);
    return null;
  }
  return trimmed;
}

/** Named once so the prompt and the flag's refusal cannot describe different things. */
const PEER_HOST_PORT_HINT = "--port";

/**
 * The refusal for a lead address a peer must not be told to enroll over, or `null` when it may stand.
 *
 * **Two things were wrong, and they compounded (F9).** The `http://` refusal is `collie join`'s, on
 * the far machine — so it ran at the END of leg 4, after the bundle push, the remote build, the
 * `.env` write and two full lead restarts, and it ended by naming `--insecure`: a flag `join` has and
 * `crew add` does not. Re-running with it produced the identical refusal. A closed loop with no exit,
 * paid for with a rebuilt member.
 *
 * So the check moves here, to parse time on the lead, and the remedy it names is one that exists.
 * **`crew add` will not grow `--insecure`**: this verb mints the token and pushes it down an ssh pipe
 * on the operator's behalf, and a flag that made it ship that token over plaintext would be Collie
 * accepting the risk for a machine it is not standing at. The consent belongs where the token is
 * spent — `collie join … --insecure`, typed on the peer, which is exactly what `cli/crew.ts` already
 * implements and what `cli/remote.ts`'s enroll leg says it never passes on the operator's behalf.
 *
 * Both sources of the address are checked, and neither costs anything: the flag, and
 * `COLLIE_PUBLIC_URL` (which `resolveSelfAddress` would otherwise pick up silently later). A derived
 * tailnet address carries no scheme and is dialled `https://`, so there is no third plaintext path.
 */
export function leadAddressRefusal(
  flag: string | undefined,
  publicUrl: string | undefined,
): string[] | null {
  const [address, source] =
    flag !== undefined && flag !== ""
      ? ([flag, "--address"] as const)
      : ([publicUrl?.trim() ?? "", "COLLIE_PUBLIC_URL"] as const);
  if (address === "") return null;
  if (!/^http:\/\//i.test(address)) return null;
  return [
    `error: refusing to enroll a peer over ${source}=${address} — the invite token and the crew`,
    "       secret would cross the wire in the clear. An on-path attacker who reads the token can",
    "       enroll THEIR OWN certificate as a member before your peer does (the lead admits on the",
    "       token alone), then holds the crew secret and a pinned link.",
    "       Give an encrypted address: https:// via `tailscale serve`, or your own TLS front door",
    "       (docs/deployment.md Variant C).",
    "       `crew add` has no --insecure and will not get one — it would ship the token over",
    "       plaintext on behalf of a machine you are not standing at. If this hop really is trusted,",
    "       own it where the token is spent: install Collie on that machine, run `collie crew invite`",
    "       here, and run `collie join <lead-address> <token> --insecure` THERE.",
    "       Nothing was pushed, built or restarted.",
  ];
}

/**
 * Why this `--peer-address` cannot be a member's bind, or `null` when it may stand.
 *
 * **The flag says *address*; the value is a bare HOST, and nothing checked which.** Leg 3 writes it
 * verbatim into the member's `COLLIE_HOST`, and this lead dials `` `${peerHost}:${port}` `` — so
 * `--peer-address 192.168.77.2:8787` printed `192.168.77.2:8787:8787` twice and wrote
 * `COLLIE_HOST=192.168.77.2:8787`, which `Bun.serve` can never bind. The member was left
 * half-enrolled with a dead service and nothing on screen naming the cause (F8).
 *
 * **Splitting `host:port` here instead was considered and refused.** `--port` already exists, and it
 * is not only the dial port: leg 1 probes it for a collision, leg 3 writes it as `COLLIE_PORT` and
 * leg 4 banks it in `crew-ops.json`. A second spelling that silently overrode the first is one more
 * way for those to disagree. One value, one flag — and this function is why the refusal can say so.
 *
 * Pure, and the whole check: it runs at parse time on the lead, before a single byte crosses ssh.
 */
export function peerHostRefusal(value: string): string | null {
  if (value.trim() !== value || value === "") return "it is empty or padded with whitespace";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return "it carries a scheme — a bind address is not a URL";
  if (value.includes("/")) return "it carries a path — a bind address is a host and nothing else";
  if (value.includes("@")) return "it carries a user — that is the ssh destination, not the bind";
  // Brackets are URL-authority syntax, and this value is a BIND: `resolveBridgeHost` hands
  // `COLLIE_HOST` to `Bun.serve` verbatim, which wants the literal bare. `[fd7a::1]:8787` is a port
  // and `[fd7a::1]` is a spelling this build will not vouch for — both are refused, by the same rule.
  if (value.includes("[") || value.includes("]")) {
    return "it is bracketed — COLLIE_HOST is a bind address, so write an IPv6 literal bare";
  }
  const colons = value.split(":").length - 1;
  // Exactly one colon is `host:port`. Two or more is a bare IPv6 literal, which cannot carry a port
  // without brackets — so it is a host, and the case above is the only one that can.
  if (colons === 1) return "it carries a port";
  return null;
}

/** The refusal as the operator reads it: what is wrong, then what a value that works looks like. */
export function peerHostRefusalLines(value: string, refusal: string): string[] {
  return [
    `error: --peer-address ${value} is not a bind address — ${refusal}.`,
    "       Give a BARE HOST — a hostname or an IP address and nothing else:",
    "         --peer-address collie-2.tail1234.ts.net    --peer-address 192.168.77.2",
    "       It is written verbatim into that machine's COLLIE_HOST, so it must be an address that",
    `       machine can BIND, and the port it is dialled on comes from \`${PEER_HOST_PORT_HINT}\`.`,
  ];
}

/**
 * The port the remote is ALREADY configured for. An absent `COLLIE_PORT` is the default, resolved
 * the same way `cli/context.ts` resolves it — not "unset", or a re-run would rewrite a `.env` that
 * already says the right thing.
 */
function configuredPort(probe: Probe): number {
  return /^\d+$/.test(probe.envport) ? Number(probe.envport) : DEFAULT_PORT;
}

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && n < 65536 ? n : null;
}

/**
 * `git -C <root> …`, trimmed. `null` when git is absent or said no.
 *
 * Narrowed to the two seams it uses (rather than the whole `Wired` set) so `crew update` can read
 * this checkout's commit through the very same function — the commit both verbs push is one fact.
 */
export function gitOut(deps: Pick<CrewDeps, "ctx" | "exec">, args: readonly string[]): string | null {
  const r = deps.exec.capture("git", ["-C", deps.ctx.root, ...args]);
  return r.found && r.code === 0 ? r.stdout.trim() : null;
}

/**
 * The version the pushed COMMIT carries, read out of that commit rather than the working tree: the
 * bundle ships the commit, so a dirty manifest would have the install verify against a version the
 * far machine was never given.
 */
export function manifestVersionAt(deps: Pick<CrewDeps, "ctx" | "exec">, commit: string): string | null {
  const manifest = gitOut(deps, ["show", `${commit}:herdr-plugin.toml`]);
  if (manifest === null) return null;
  return /^version[ \t]*=[ \t]*"([^"]*)"/m.exec(manifest)?.[1] ?? null;
}

// ── Production wiring ────────────────────────────────────────────────────────

/** The real seams for `crew add`, layered onto the crew verbs' own set. */
export function crewAddDeps(base: CrewDeps): CrewAddDeps {
  return {
    ...base,
    remote: (host) => sshRunner(host, base.ctx.env, base.ctx.home),
    // Bun's built-ins, guarded by a tty check: a prompt nobody can answer must abort legibly rather
    // than read EOF as "yes".
    confirm: (question) => (process.stdin.isTTY === true ? confirm(question) : null),
    prompt: (question) => (process.stdin.isTTY === true ? prompt(question) : null),
    gitBundle: async (commit, io) => {
      const git = base.exec.which("git");
      if (git === null) return null;
      const printErr = (stderr: string) => {
        const line = stderr.split("\n").find((l) => l.trim() !== "");
        if (line !== undefined) io.err(`       ${line.trim()}`);
      };
      // A bare commit sha is not a REF, and `git bundle create` refuses ("Refusing to create empty
      // bundle") unless it can record at least one — so bundle HEAD, not the sha. That's only safe
      // pinned to the exact commit if HEAD hasn't moved since the caller read it; the installer
      // (installScript, below) still pins exactly: it checks out `$COMMIT` and re-verifies
      // `rev-parse HEAD === $COMMIT` after the fact.
      const headResult = base.exec.capture("git", ["-C", base.ctx.root, "rev-parse", "HEAD"]);
      if (!headResult.found || headResult.code !== 0) {
        printErr(headResult.stderr);
        return null;
      }
      const head = headResult.stdout.trim();
      if (head !== commit) {
        io.err(`       HEAD moved to ${head.slice(0, 12)} since ${commit.slice(0, 12)} was read.`);
        return null;
      }
      // The ONE git child Collie starts outside `Exec`, so it applies the seam's rule by hand.
      // Without it an exported `GIT_DIR` would bundle a DIFFERENT repository and hand it to a peer,
      // and the `rev-parse HEAD` check above would pass while doing it, because that call reads the
      // same redirected repository. See `withoutGitRelocators` for why the environment can do this.
      const proc = Bun.spawn([git, "-C", base.ctx.root, "bundle", "create", "-", "HEAD"], {
        stdout: "pipe",
        stderr: "pipe",
        env: withoutGitRelocators(base.ctx.env),
      });
      const [bytes, stderr, code] = await Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0 || bytes.byteLength === 0) {
        printErr(stderr);
        return null;
      }
      return Buffer.from(bytes).toString("base64").replace(/(.{76})/g, "$1\n");
    },
    reload: () => new TrustStore(base.ctx.stateDir).load(),
  };
}
