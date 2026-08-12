import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_PORT } from "../bridge/config.ts";
import { commitPackChange, mintInvite } from "../bridge/pack/enrollment.ts";
import { TrustStore, type TrustedMember, type TrustStoreData } from "../bridge/pack/trust-store.ts";
import { INSTANCE_PATTERN, PLUGIN_ID } from "./context.ts";
import { EXIT } from "./io.ts";
import { ensureStore, parsePackArgs, probeMembers, selfAddress, type PackDeps } from "./pack.ts";
import { findTool } from "./tools.ts";

// `collie pack add <ssh-host>` — probe, install, configure, enroll a peer over ONE multiplexed SSH
// connection (M7/01, ADR 0015).
//
// ── COURIER AND INSTALLER, NOTHING ELSE ──────────────────────────────────────
// Every step here is a step the operator could have typed, in the same order, with the same verbs:
// the invite comes from the same `mintInvite` path `pack invite` uses, and the far machine runs the
// same `collie join <lead-address> -`. `pack add` adds NO route, no header and no protocol
// vocabulary (ADR 0015 (d)) — an installer that needed the protocol's help would be a second
// admission path into the pack, and the pack has exactly one (PACK_PROTOCOL.md §8.2).
//
// ── THIS IS THE ONLY MODULE THAT SPAWNS `ssh` ────────────────────────────────
// {@link RemoteRunner} is the seam, injected exactly as `PackDeps` injects `fetch`, `exec` and
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
 * The ssh options `pack add` adds, and the complete list of them.
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
  return script.replace(STDIN_MARKER, stdin);
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
        env: env as Record<string, string>,
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
            env: env as Record<string, string>,
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
 * Resolve a tool the way `scripts/collie-ctl.sh` resolves Bun: `PATH` first, then the fixed install
 * locations — because `ssh host '/bin/sh -s'` is byte-for-byte the no-login-shell, no-`PATH`
 * environment that shim was written for. `command -v` reports a shell function as a bare word, so
 * only an absolute answer is taken (the same guard, for the same reason).
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
  readonly checkout: string;
  readonly commit: string;
  readonly branch: string;
  readonly dirty: string;
  readonly dirtyfiles: string;
  readonly version: string;
  readonly address: string;
  /** `free` · `busy` · `unknown` (no `ss`/`netstat` there). */
  readonly port: string;
}

const PROBE_PREFIX = "collie-probe:";

const PROBE_FIELDS = [
  "home",
  "git",
  "bun",
  "herdr",
  "configdir",
  "envhost",
  "envport",
  "checkout",
  "commit",
  "branch",
  "dirty",
  "dirtyfiles",
  "version",
  "address",
  "port",
] as const;

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
  const out: Record<string, string> = {};
  for (const field of PROBE_FIELDS) out[field] = raw.get(field) ?? "";
  return out as unknown as Probe;
}

/**
 * The read-only leg. It **writes nothing on either machine** and never prompts: every later leg's
 * decision — skip, prompt, refuse — is made from what this one reports.
 *
 * The remote's config root is READ here (`herdr plugin config-dir`, the same question
 * `cli/context.ts` asks locally) rather than computed from a path we guessed: `pack add` must not
 * assume a path it did not observe.
 */
export function probeScript(opts: { readonly path: string | null; readonly port: number }): string {
  const candidates =
    opts.path === null
      ? `"$HOME/.collie" "$HOME/collie" "$HOME"/.config/herdr/plugins/github/*/ "$HOME"/.config/herdr/plugins/local/*/`
      : shq(opts.path);
  return [
    "set -u",
    "umask 077",
    TOOL_LOOKUP,
    `say() { printf '${PROBE_PREFIX}%s=%s\\n' "$1" "$2"; }`,
    'GIT=$(collie_tool git) || GIT=""',
    'BUN=$(collie_tool bun) || BUN=""',
    'HERDR=$(collie_tool herdr) || HERDR=""',
    'TS=$(collie_tool tailscale) || TS=""',
    'say home "$HOME"',
    'say git "$GIT"',
    'say bun "$BUN"',
    'say herdr "$HERDR"',
    // The config root, asked for rather than assumed. An empty answer is reported as empty and the
    // verb stops legibly — it never falls back to a conventional path this side made up.
    'CFG=""',
    `if [ -n "$HERDR" ]; then CFG=$("$HERDR" plugin config-dir ${shq(PLUGIN_ID)} 2>/dev/null | head -n 1 | tr -d '\\r') || CFG=""; fi`,
    'say configdir "$CFG"',
    'ENVHOST=""; ENVPORT=""',
    'if [ -n "$CFG" ] && [ -f "$CFG/.env" ]; then',
    '  ENVHOST=$(sed -n "s/^[[:space:]]*\\(export[[:space:]][[:space:]]*\\)\\{0,1\\}COLLIE_HOST=//p" "$CFG/.env" | tail -n 1 | tr -d "\\"\'\\r")',
    '  ENVPORT=$(sed -n "s/^[[:space:]]*\\(export[[:space:]][[:space:]]*\\)\\{0,1\\}COLLIE_PORT=//p" "$CFG/.env" | tail -n 1 | tr -d "\\"\'\\r")',
    "fi",
    'say envhost "$ENVHOST"',
    'say envport "$ENVPORT"',
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
    `ROOT=${shq(opts.root)}`,
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
    '"$GIT" bundle verify "$WORK/bundle.part" >/dev/null 2>&1 || { echo "error: the pushed bundle did not verify" >&2; exit 22; }',
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
  readonly instance: string | null;
}): string {
  const keys = ["COLLIE_HOST", "COLLIE_PORT", ...(opts.instance === null ? [] : ["COLLIE_INSTANCE"])];
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

// ── Leg 4 — enroll ───────────────────────────────────────────────────────────

/** Read the remote's own pack view, so an already-enrolled machine is never re-enrolled. */
export function membershipScript(root: string): string {
  return [
    "set -eu",
    `ROOT=${shq(root)}`,
    '"$ROOT/bin/collie" pack status --no-probe',
    "",
  ].join("\n");
}

/** What `pack status --no-probe` says about the far machine, as this build reads it. */
export interface RemoteMembership {
  /** The pack id it belongs to, or null when it is solo. */
  readonly packId: string | null;
  readonly packName: string | null;
  readonly memberId: string | null;
}

/**
 * Parse the far side's `pack status`. It is the SAME build — leg 2 just installed this very commit
 * there — so the format is known rather than guessed; a shape this build cannot read is still the
 * third error family and fails rather than assuming solo.
 */
export function parseMembership(stdout: string): RemoteMembership | null {
  if (/^mode: solo\b/m.test(stdout)) return { packId: null, packName: null, memberId: null };
  const pack = /^pack {3}(.+?) {2}\((.+?)\)\s*$/m.exec(stdout);
  const self = /^self {3}(\S+)/m.exec(stdout);
  if (pack === null) return null;
  return { packId: pack[2]!.trim(), packName: pack[1]!.trim(), memberId: self?.[1] ?? null };
}

/**
 * `collie join <lead-address> -` on the far machine, with the token on stdin.
 *
 * The token never reaches argv, an environment variable or a file this verb writes (§8.3) — it is
 * spliced into a quoted heredoc, so it exists only in the ssh stream and in the shell's heredoc
 * buffer. `--insecure` is never passed on the operator's behalf: the far side refuses `http://`
 * exactly as it would for a hand-typed join.
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
    `ROOT=${shq(opts.root)}`,
    `exec "$ROOT/bin/collie" ${args.map(shq).join(" ")} <<'${PAYLOAD_EOF}'`,
    STDIN_MARKER,
    PAYLOAD_EOF,
    "",
  ].join("\n");
}

// ── The verb ─────────────────────────────────────────────────────────────────

/** `pack add`'s seams: the pack verbs' set, plus a transport, two prompts and the bundle. */
export interface PackAddDeps extends PackDeps {
  /** The ONE thing in `cli/` that spawns ssh, injected so no test ever does. */
  remote(host: string): RemoteRunner;
  /** Bun's `confirm()`, behind a seam. `null` means "nobody is there to ask". */
  confirm(question: string): boolean | null;
  /** Bun's `prompt()`, behind a seam. `null` means "nobody is there to ask". */
  prompt(question: string): string | null;
  /** `git bundle create - <commit>`, base64-encoded. `null` when git refused. */
  gitBundle(commit: string): Promise<string | null>;
  /**
   * Re-read the trust store from disk. The lead's enrollment is written by its RUNNING BRIDGE, in
   * another process, so this process's cached copy cannot see it (`TrustStore.load` reads once).
   */
  reload(): Promise<TrustStoreData | null>;
}

const USAGE = [
  "usage: collie pack add <ssh-host> [--path <remote-checkout>] [--port <n>]",
  "                      [--peer-address <addr>] [--address <lead-address>]",
  "                      [--label <name>] [--name <pack>] [--instance <name>]",
];

/** Prompt copy shared by the abort path, so the non-interactive message names the real question. */
function ask(deps: PackAddDeps, question: string): boolean | "aborted" {
  const answer = deps.confirm(question);
  if (answer === null) {
    deps.io.err(`error: this run is not interactive, and it would have asked: ${question}`);
    deps.io.err("       Nothing was changed. Re-run from a terminal, or resolve it on that machine first.");
    return "aborted";
  }
  return answer;
}

/**
 * `collie pack add <ssh-host>` — four legs over one connection (M7/01).
 *
 * Exit codes reuse `EXIT`'s existing meanings rather than adding a seventh: `UNREACHABLE` when ssh
 * never started or could not authenticate, `STATE` when the operator said no or remote state blocks,
 * `REFUSED` when the lead refused the token, `FAIL` for a missing prerequisite, a failed build, an
 * unreadable answer, or a member that is still provisional at the final check.
 */
export async function cmdPackAdd(deps: PackAddDeps, args: readonly string[]): Promise<number> {
  const { positional, flags } = parsePackArgs(args);
  const host = positional[0];
  if (host === undefined || host === "") {
    for (const line of USAGE) deps.io.err(line);
    return EXIT.USAGE;
  }
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

  const existing = await deps.store.load();
  if (existing !== null && existing.lead !== null) {
    deps.io.err(`error: this collie is a peer of "${existing.lead.memberId}" — peers are added from the lead.`);
    return EXIT.STATE;
  }

  const runner = deps.remote(host);
  try {
    return await addOverSsh(deps, runner, { host, port, instance, flags });
  } finally {
    // Every exit path, including a throw: the control socket is a live authenticated channel.
    runner.close();
  }
}

interface AddOptions {
  readonly host: string;
  readonly port: number;
  readonly instance: string | null;
  readonly flags: Readonly<Record<string, string>>;
}

async function addOverSsh(deps: PackAddDeps, runner: RemoteRunner, opts: AddOptions): Promise<number> {
  const { host, port, flags } = opts;

  // ── Leg 1 — probe ──────────────────────────────────────────────────────────
  deps.io.out(`probing ${host}…`);
  const probed = await runner.run(probeScript({ path: flags.path ?? null, port }));
  const transport = transportFailure(deps, host, probed);
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

  for (const [tool, path, hint] of [
    ["git", probe.git, "install git there (the lead pushes its own commit as a `git bundle`)"],
    ["bun", probe.bun, "install Bun there: https://bun.sh (Collie is source-distributed and builds natively)"],
  ] as const) {
    if (path === "") {
      deps.io.err(`error: no \`${tool}\` on ${host} — ${hint}`);
      return EXIT.FAIL;
    }
    deps.io.out(`✓ ${tool}       ${path}`);
  }
  if (probe.herdr === "") {
    // Not a bug and not an unimplemented feature: Collie is a Herdr plugin, and a Collie with no
    // herd has nothing to show. The standalone future is discussion #67 — named as `not yet`.
    deps.io.err(`error: no \`herdr\` on ${host} — Collie is a Herdr plugin, and a Collie with no herd`);
    deps.io.err("       has nothing to show. Install Herdr there first.");
    deps.io.err("       (A standalone Collie is discussion #67 — not yet, and not a bug.)");
    return EXIT.FAIL;
  }
  deps.io.out(`✓ herdr      ${probe.herdr}`);

  const configDir = probe.configdir;
  if (configDir === "") {
    deps.io.err(`error: Herdr is installed on ${host}, but it did not answer with a config directory.`);
    deps.io.err(`       asked:  ${probe.herdr} plugin config-dir ${PLUGIN_ID}`);
    deps.io.err("       got:    (nothing)");
    deps.io.err("       Run that by hand there. `pack add` never invents a path it did not observe.");
    return EXIT.FAIL;
  }
  deps.io.out(`✓ config     ${configDir}`);

  // The address the lead will dial. Read off the remote; asked only when it cannot answer.
  const peerHost = resolvePeerHost(deps, probe, flags["peer-address"]);
  if (peerHost === null) return EXIT.FAIL;
  const peerAddress = `${peerHost}:${port}`;
  deps.io.out(`✓ address    ${peerAddress} (what this lead will dial)`);

  // The install target: the checkout leg 1 FOUND, else `.collie` under the `$HOME` it reported. Even
  // the green-field path is anchored to an observed value rather than a guessed one.
  const root = probe.checkout === "" ? `${probe.home}/.collie` : probe.checkout;
  // A busy port is a collision ONLY when it is not this collie's own listener. Re-running `pack add`
  // against a host it already installed must find that port taken and say so as a `✓`.
  const alreadyOnPort = probe.checkout !== "" && configuredPort(probe) === port;
  if (probe.port === "busy" && !alreadyOnPort) {
    deps.io.err(`error: something is already listening on port ${port} at ${host}, and it is not a Collie`);
    deps.io.err("       this host has configured. Choose another with `--port <n>`.");
    return EXIT.FAIL;
  }
  deps.io.out(
    probe.port === "unknown"
      ? `warn: could not probe port ${port} on ${host} (no \`ss\`/\`netstat\` there) — a collision would surface at first start`
      : `✓ port       ${port} ${probe.port === "busy" ? "already carries this collie" : "free"}`,
  );

  // ── Leg 2 — install ────────────────────────────────────────────────────────
  const commit = gitOut(deps, ["rev-parse", "HEAD"]);
  if (commit === null) {
    deps.io.err(`error: cannot read this checkout's commit — ${deps.ctx.root} is not a git checkout.`);
    return EXIT.FAIL;
  }
  const version = manifestVersionAt(deps, commit);
  if (version === null) {
    deps.io.err(`error: cannot read herdr-plugin.toml at ${commit.slice(0, 12)} — nothing to pin the install to.`);
    return EXIT.FAIL;
  }
  if (gitOut(deps, ["status", "--porcelain"]) !== "") {
    deps.io.err("warn: this checkout has uncommitted changes — the bundle carries the COMMIT, so they are");
    deps.io.err(`      not shipped. ${host} will run ${version} at ${commit.slice(0, 12)}.`);
  }

  if (probe.commit === commit) {
    deps.io.out(`✓ install    already at ${probe.version || version} (${commit.slice(0, 12)}) — nothing sent`);
  } else {
    const blocked = await installLeg(deps, runner, { host, root, commit, version, probe });
    if (blocked !== null) return blocked;
  }

  // ── Leg 3 — configure ──────────────────────────────────────────────────────
  const configured = await configureLeg(deps, runner, {
    host,
    configDir,
    peerHost,
    port,
    instance: opts.instance,
    probe,
  });
  if (configured !== null) return configured;

  // ── Leg 4 — enroll ─────────────────────────────────────────────────────────
  return enrollLeg(deps, runner, { host, root, peerAddress, flags });
}

/** Leg 2, as its own step: the prompts, the bundle push and the post-install version check. */
async function installLeg(
  deps: PackAddDeps,
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
      deps.io.err(`       \`git stash\` or commit them on ${o.host}, then re-run. \`pack add\` will not`);
      deps.io.err("       discard work it did not create.");
      return EXIT.STATE;
    }
    const answer = ask(
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

  const bundle = await deps.gitBundle(o.commit);
  if (bundle === null) {
    deps.io.err(`error: could not bundle ${o.commit.slice(0, 12)} from ${deps.ctx.root}.`);
    return EXIT.FAIL;
  }
  deps.io.out(`  pushing ${o.commit.slice(0, 12)} (${Math.round(bundle.length / 1024)} KiB base64) to ${o.root}…`);
  const installed = await runner.run(
    installScript({ root: o.root, commit: o.commit, version: o.version }),
    bundle,
  );
  const transport = transportFailure(deps, o.host, installed);
  if (transport !== null) return transport;
  if (installed.code !== 0) {
    deps.io.err(`error: the install failed on ${o.host} — ${firstLine(installed.stderr)}`);
    deps.io.err(`       The checkout at ${o.root} was left in place; nothing was configured or enrolled.`);
    return EXIT.FAIL;
  }
  const built = /^collie-install:version=(.+)$/m.exec(installed.stdout);
  if (built === null) {
    deps.io.err(`error: the install on ${o.host} reported nothing this build can read.`);
    return EXIT.FAIL;
  }
  deps.io.out(`✓ install    ${built[1]!.trim()} at ${o.root}`);
  if (probe.checkout === "") {
    deps.io.out(`  This checkout is not registered with Herdr there. To get its plugin actions:`);
    deps.io.out(`    herdr plugin link "${o.root}"   # on ${o.host}`);
  }
  return null;
}

/** Leg 3, as its own step: skip, prompt, or write the peer's `.env`. */
async function configureLeg(
  deps: PackAddDeps,
  runner: RemoteRunner,
  o: {
    host: string;
    configDir: string;
    peerHost: string;
    port: number;
    instance: string | null;
    probe: Probe;
  },
): Promise<number | null> {
  const { probe } = o;
  if (probe.envhost === o.peerHost && configuredPort(probe) === o.port) {
    deps.io.out(`✓ bind       already ${o.peerHost}:${o.port}`);
    return null;
  }
  if (probe.envhost !== "" || probe.envport !== "") {
    const current = `${probe.envhost || "(unset)"}:${probe.envport || "(unset)"}`;
    const answer = ask(deps, `${o.host} is configured to bind ${current}; change it to ${o.peerHost}:${o.port}?`);
    if (answer === "aborted") return EXIT.FAIL;
    if (!answer) {
      deps.io.err("error: left alone — the bind was not changed, and nothing was enrolled.");
      deps.io.err("       A peer the lead cannot dial stays provisional forever (`collie doctor` there).");
      return EXIT.STATE;
    }
  }
  const written = await runner.run(
    configureScript({ configDir: o.configDir, host: o.peerHost, port: o.port, instance: o.instance }),
  );
  const transport = transportFailure(deps, o.host, written);
  if (transport !== null) return transport;
  if (written.code !== 0) {
    deps.io.err(`error: could not write the peer's .env — ${firstLine(written.stderr)}`);
    return EXIT.FAIL;
  }
  deps.io.out(`✓ bind       ${o.peerHost}:${o.port} written to ${o.configDir}/.env`);
  // ADR 0013: a peer publishes nothing. Said out loud, because the absence of a step is invisible.
  deps.io.out("  No front door was published there — a peer publishes none (ADR 0013).");
  return null;
}

/** Leg 4, as its own step: the membership pre-check, the invite, the join, and the final verdict. */
async function enrollLeg(
  deps: PackAddDeps,
  runner: RemoteRunner,
  o: { host: string; root: string; peerAddress: string; flags: Readonly<Record<string, string>> },
): Promise<number> {
  const status = await runner.run(membershipScript(o.root));
  const transport = transportFailure(deps, o.host, status);
  if (transport !== null) return transport;
  if (status.code !== 0) {
    deps.io.err(`error: \`collie pack status\` exited ${status.code} on ${o.host} — ${firstLine(status.stderr)}`);
    return EXIT.FAIL;
  }
  const membership = parseMembership(status.stdout);
  if (membership === null) {
    deps.io.err(`error: ${o.host} answered \`pack status\` with something this build cannot read.`);
    return EXIT.FAIL;
  }

  const data = await ensureStore(deps, o.flags.as);
  if (data === null) return EXIT.FAIL;
  if (membership.packId !== null) {
    if (data.pack !== null && membership.packId === data.pack.packId) {
      deps.io.out(`✓ already a member of "${membership.packName}" as "${membership.memberId}"`);
      return EXIT.OK;
    }
    deps.io.err(`error: ${o.host} is already a member of pack "${membership.packName}" (${membership.packId}).`);
    deps.io.err(`       Run \`collie leave\` THERE first — never run for you: leaving a pack is a decision`);
    deps.io.err("       taken on the machine that is leaving (§8.4).");
    return EXIT.STATE;
  }

  const leadAddress = selfAddress(deps, o.flags.address);
  if (leadAddress === null) {
    deps.io.err("error: cannot work out an address this lead can be dialled at.");
    deps.io.err("       Pass one: `collie pack add <host> --address <this-lead-address>`.");
    return EXIT.FAIL;
  }

  const before = new Set(data.peers.map((p) => p.memberId));
  const minted = await commitPackChange(deps.store, deps.audit, (current) =>
    current === null
      ? null
      : mintInvite(current, {
          now: deps.now(),
          label: o.flags.label ?? null,
          packName: o.flags.name,
          random: deps.random,
        }),
  );
  if (minted === null) return EXIT.FAIL;
  deps.io.out("  minted a single-use, ten-minute invite; restarting the bridge so it can answer it…");
  if ((await deps.restart()) !== EXIT.OK) {
    deps.io.err("warn: the restart failed — the invite IS minted, but the running bridge still holds the");
    deps.io.err("      previous store and will refuse it. Run `collie restart` here, then re-run.");
  }

  // `<token>.<lead-fingerprint>` (§8.2), exactly the string `pack invite` prints — and it goes only
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
  const enrollTransport = transportFailure(deps, o.host, enrolled);
  if (enrollTransport !== null) return enrollTransport;
  if (enrolled.code !== EXIT.OK) {
    for (const line of enrolled.stderr.split("\n")) if (line.trim() !== "") deps.io.err(line);
    // `collie join`'s own codes, passed through: they already distinguish refused from unreachable
    // from local state, and re-deciding them here would make one verb disagree with the other.
    if (enrolled.code === EXIT.REFUSED) return EXIT.REFUSED;
    if (enrolled.code === EXIT.UNREACHABLE) {
      deps.io.err(`       ${o.host} could not reach ${leadAddress}. That is the lead's ingress, not the peer's.`);
      return EXIT.UNREACHABLE;
    }
    if (enrolled.code === EXIT.STATE) return EXIT.STATE;
    return EXIT.FAIL;
  }
  deps.io.out(`✓ enrolled   ${o.host} answered the invite`);

  deps.io.out("  restarting the bridge so the new member takes effect…");
  await deps.restart();
  return verdict(deps, before, o.host);
}

/**
 * The last line, and the one a script should branch on: **is the member non-provisional after first
 * contact?** — the lead's own `pack status` view, not the join's exit code, decides it.
 *
 * A `hello` that lands is exactly what `pack status` treats as clearing the provisional marker: the
 * member was enrolled AND has been reached at the address it named. A join that returned 0 into a
 * peer the lead cannot dial is the trap this whole verb exists to close, so it fails here.
 */
async function verdict(deps: PackAddDeps, before: ReadonlySet<string>, host: string): Promise<number> {
  const fresh = await deps.reload();
  const added: TrustedMember | undefined = fresh?.peers.find((p) => !before.has(p.memberId));
  if (fresh === null || fresh.pack === null || added === undefined) {
    deps.io.err(`error: ${host} reported a successful join, but this lead's roster does not name a new member.`);
    deps.io.err("       Check `collie pack status` here and `collie doctor` there.");
    return EXIT.FAIL;
  }
  const probes = await probeMembers(deps, fresh, [added]);
  const outcome = probes.get(added.memberId);
  if (outcome?.ok === true) {
    deps.io.out(`✓ "${added.memberId}" is a member of "${fresh.pack.name}" and answered at ${added.address}`);
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
function transportFailure(deps: PackAddDeps, host: string, r: RemoteResult): number | null {
  if (!r.spawned) {
    deps.io.err(`error: could not start ssh — ${r.stderr.trim() || "it did not run"}.`);
    deps.io.err("       `pack add` rides your own ssh: install it, or run the four steps by hand.");
    return EXIT.UNREACHABLE;
  }
  if (r.code !== 255) return null;
  deps.io.err(`error: ssh could not reach ${host} — ${firstLine(r.stderr)}`);
  if (/Permission denied \(publickey/.test(r.stderr)) {
    deps.io.err("       That is a key problem, not a Collie one: `ssh-add` your key (or name it in");
    deps.io.err(`       ~/.ssh/config for ${host}) and re-run. Collie never touches your ssh configuration.`);
  }
  return EXIT.UNREACHABLE;
}

const firstLine = (text: string): string =>
  text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "(it said nothing)";

/** The address the lead will dial, read off the remote — or asked for, never guessed. */
function resolvePeerHost(deps: PackAddDeps, probe: Probe, override: string | undefined): string | null {
  if (override !== undefined && override !== "") return override;
  if (probe.address !== "") return probe.address;
  const answered = deps.prompt(
    "This host has no tailnet address. What address should this lead dial it at?",
  );
  if (answered === null) {
    deps.io.err("error: this host reported no tailnet address, and this run is not interactive.");
    deps.io.err("       Pass it: `collie pack add <host> --peer-address <addr-the-lead-can-dial>`.");
    return null;
  }
  const trimmed = answered.trim();
  if (trimmed === "") {
    deps.io.err("error: no address given — a peer the lead cannot dial stays provisional forever.");
    return null;
  }
  return trimmed;
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

/** `git -C <root> …`, trimmed. `null` when git is absent or said no. */
function gitOut(deps: PackAddDeps, args: readonly string[]): string | null {
  const r = deps.exec.capture("git", ["-C", deps.ctx.root, ...args]);
  return r.found && r.code === 0 ? r.stdout.trim() : null;
}

/**
 * The version the pushed COMMIT carries, read out of that commit rather than the working tree: the
 * bundle ships the commit, so a dirty manifest would have the install verify against a version the
 * far machine was never given.
 */
function manifestVersionAt(deps: PackAddDeps, commit: string): string | null {
  const manifest = gitOut(deps, ["show", `${commit}:herdr-plugin.toml`]);
  if (manifest === null) return null;
  return /^version[ \t]*=[ \t]*"([^"]*)"/m.exec(manifest)?.[1] ?? null;
}

// ── Production wiring ────────────────────────────────────────────────────────

/** The real seams for `pack add`, layered onto the pack verbs' own set. */
export function packAddDeps(base: PackDeps): PackAddDeps {
  return {
    ...base,
    remote: (host) => sshRunner(host, base.ctx.env, base.ctx.home),
    // Bun's built-ins, guarded by a tty check: a prompt nobody can answer must abort legibly rather
    // than read EOF as "yes".
    confirm: (question) => (process.stdin.isTTY === true ? confirm(question) : null),
    prompt: (question) => (process.stdin.isTTY === true ? prompt(question) : null),
    gitBundle: async (commit) => {
      const git = base.exec.which("git");
      if (git === null) return null;
      const proc = Bun.spawn([git, "-C", base.ctx.root, "bundle", "create", "-", commit], {
        stdout: "pipe",
        stderr: "ignore",
        env: base.ctx.env as Record<string, string>,
      });
      const [bytes, code] = await Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        proc.exited,
      ]);
      if (code !== 0 || bytes.byteLength === 0) return null;
      return Buffer.from(bytes).toString("base64").replace(/(.{76})/g, "$1\n");
    },
    reload: () => new TrustStore(base.ctx.stateDir).load(),
  };
}
