import { dirname, isAbsolute, join } from "node:path";

// The extension text, embedded at build time. `collie inbox install pi` writes THESE bytes, so the
// published binary needs no checkout (the reason `cli/docs-embed.ts` embeds the docs), and
// `cli/inbox.test.ts` fails when the embed and the file on disk differ.
import extensionText from "../pi-extension/collie-inbox.ts" with { type: "text" };
import type { CliContext } from "./context.ts";
import { realpathVia } from "./hooks.ts";
import { EXIT, type Io } from "./io.ts";
import type { LinkReader } from "./link.ts";
import type { Files } from "./sys.ts";

// `collie inbox install|uninstall|status pi` — putting Collie's pi inbox extension (ADR 0141) into pi's
// own global extensions folder, and taking it back out. It is the person's opt-in verb: no other verb
// (bridge start, `doctor`, `update`) ever writes it, because it makes pi open a socket that types
// messages into the session.
//
// It copies the shape of `cli/hooks.ts`, and the same three guards:
//
//  1. OWNERSHIP BY A VERSION-PREFIXED MARKER. The extension's first line is `// collie-inbox v1`. A file
//     at the target without that prefix is someone else's: install refuses, uninstall leaves it, and
//     neither touches a byte. A file with our prefix at ANY version, or with other bytes, is replaced in
//     place (the self-heal); the same bytes write nothing. "Current" is decided by comparing bytes, never
//     by finding the marker and stopping.
//  2. A SYMLINKED FILE IS REFUSED, A SYMLINKED DIRECTORY IS RESOLVED. A rename onto a symlinked file
//     replaces the link, which is not what the person meant; a symlinked folder (stow, chezmoi) lands the
//     write in the real folder anyway, so `realpathVia` resolves it.
//  3. THE WRITE IS ATOMIC: temp file in the same folder, then rename.
//
// WHERE pi looks: `$PI_CODING_AGENT_DIR` (a leading `~` expanded) or `~/.pi/agent`, and `extensions/`
// directly under it. Read from pi's `dist/config.js` (`getAgentDir`, `ENV_AGENT_DIR`) and
// `core/package-manager.js` (`userDirs.extensions = join(globalBaseDir, "extensions")`) in
// `@mariozechner/pi-coding-agent`. Only pi has an inbox today; Oh My Pi's `~/.omp/agent` is not covered.

/** The harnesses that have an inbox extension. */
export const INBOX_HARNESSES = ["pi"] as const;

/** The `inbox` sub-verbs, in the order the usage block prints them. */
export const INBOX_SUBCOMMANDS = ["install", "uninstall", "status"] as const;

/** What makes a file ours, at any version. The extension carries it as its own first line. */
export const INBOX_MARKER_PREFIX = "// collie-inbox v";

/** The extension's file name inside pi's extensions folder. */
const FILE_NAME = "collie-inbox.ts";

/**
 * The bytes `install pi` writes: the extension with LF line ends (a Windows checkout may hand CRLF).
 *
 * `with { type: "text" }` makes Bun bind the file's TEXT as the default export, but `tsc` ignores the
 * attribute and types a `.ts` import as the module it resolves to. `String()` is the identity on the
 * text at run time and states the type honestly without an assertion. `cli/inbox.test.ts` pins the value
 * to the file on disk.
 */
export const PI_EXTENSION_TEXT: string = String(extensionText).replaceAll("\r\n", "\n");

/** The marker version in a file's first line, or null when the file is not ours. */
export function inboxMarkerVersion(text: string): number | null {
  const first = text.split("\n", 1)[0] ?? "";
  if (!first.startsWith(INBOX_MARKER_PREFIX)) return null;
  const digits = /^\d+/u.exec(first.slice(INBOX_MARKER_PREFIX.length));
  return digits === null ? null : Number(digits[0]);
}

export interface InboxDeps {
  readonly ctx: CliContext;
  readonly io: Io;
  readonly files: Files;
  /** `lstat` without following: the symlinked-file refusal, and the resolve of a symlinked folder. */
  readonly fs: LinkReader;
}

const RELOAD_HINT = "A running pi loads it after `/reload` or a restart.";

/** pi's agent folder: `$PI_CODING_AGENT_DIR` with `~` expanded, else `~/.pi/agent`. Null for a relative value. */
function piAgentDir(ctx: Pick<CliContext, "home" | "env">): string | null {
  const own = ctx.env.PI_CODING_AGENT_DIR?.trim() ?? "";
  if (own === "") return join(ctx.home, ".pi", "agent");
  const expanded = own === "~" ? ctx.home : own.startsWith("~/") ? join(ctx.home, own.slice(2)) : own;
  // A relative value means pi's own working directory, which no verb here can know.
  return isAbsolute(expanded) ? expanded : null;
}

type Resolved =
  | { readonly kind: "ok"; readonly path: string }
  | { readonly kind: "refused"; readonly reason: string };

/** The file this verb reads and writes, every guard applied: the folder resolved, the file not a link. */
function resolveTarget(deps: InboxDeps): Resolved {
  const agent = piAgentDir(deps.ctx);
  if (agent === null) {
    return { kind: "refused", reason: "PI_CODING_AGENT_DIR is a relative path, so Collie cannot tell which folder pi reads" };
  }
  const dir = realpathVia(deps.fs, join(agent, "extensions"));
  const path = join(dir, FILE_NAME);
  if (deps.fs.probe(path).kind === "symlink") return { kind: "refused", reason: `${path} is a symlink` };
  return { kind: "ok", path };
}

export type InboxState =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "not-installed"; readonly path: string }
  | { readonly kind: "current"; readonly path: string }
  | { readonly kind: "stale"; readonly path: string; readonly at: number }
  | { readonly kind: "foreign"; readonly path: string };

/** One reading of the target, shared by all three verbs. Reads only. */
export function inboxState(deps: InboxDeps): InboxState {
  const target = resolveTarget(deps);
  if (target.kind === "refused") return { kind: "refused", reason: target.reason };
  const text = deps.files.read(target.path);
  if (text === null) return { kind: "not-installed", path: target.path };
  const at = inboxMarkerVersion(text);
  if (at === null) return { kind: "foreign", path: target.path };
  return text === PI_EXTENSION_TEXT ? { kind: "current", path: target.path } : { kind: "stale", path: target.path, at };
}

function readHarness(deps: InboxDeps, args: readonly string[], verb: string): boolean {
  const name = args[0];
  if (name !== undefined && INBOX_HARNESSES.some((h) => h === name)) return true;
  deps.io.err(`usage: collie inbox ${verb} {${INBOX_HARNESSES.join("|")}}`);
  if (name !== undefined && name !== "") deps.io.err(`  \`${name}\` has no inbox extension — only ${INBOX_HARNESSES.join(", ")} does.`);
  return false;
}

/** `collie inbox install pi` — write the extension, or replace our own older or changed copy. */
export function cmdInboxInstall(deps: InboxDeps, args: readonly string[]): number {
  if (!readHarness(deps, args, "install")) return EXIT.USAGE;
  const state = inboxState(deps);
  switch (state.kind) {
    case "refused":
      deps.io.err(`error: ${state.reason} — refusing to write there.`);
      return EXIT.FAIL;
    case "foreign":
      deps.io.err(`error: ${state.path} is not Collie's (it has no collie-inbox marker) — leaving it alone.`);
      deps.io.err("  Move it aside, then re-run `collie inbox install pi`.");
      return EXIT.FAIL;
    case "current":
      deps.io.out(`${state.path} is already installed — no bytes changed.`);
      return EXIT.OK;
    case "not-installed":
    case "stale": {
      const temp = `${state.path}.collie-tmp`;
      try {
        deps.files.mkdirp(dirname(state.path));
        deps.files.write(temp, PI_EXTENSION_TEXT, 0o644);
        deps.files.rename(temp, state.path);
      } catch (err) {
        deps.files.remove(temp);
        deps.io.err(`error: could not write ${state.path} — ${err instanceof Error ? err.message : String(err)}`);
        return EXIT.FAIL;
      }
      deps.io.out(`✓ ${state.path}${state.kind === "stale" ? ` (replaced the older copy, v${state.at})` : ""}`);
      deps.io.out(`  ${RELOAD_HINT}`);
      return EXIT.OK;
    }
  }
}

/** `collie inbox uninstall pi` — remove the file only when it carries our marker. */
export function cmdInboxUninstall(deps: InboxDeps, args: readonly string[]): number {
  if (!readHarness(deps, args, "uninstall")) return EXIT.USAGE;
  const state = inboxState(deps);
  switch (state.kind) {
    case "refused":
      deps.io.err(`error: ${state.reason} — refusing to remove it.`);
      return EXIT.FAIL;
    case "foreign":
      deps.io.err(`error: ${state.path} is not Collie's (it has no collie-inbox marker) — leaving it alone.`);
      return EXIT.FAIL;
    case "not-installed":
      deps.io.out("nothing to remove — the pi inbox extension is not installed.");
      return EXIT.OK;
    case "current":
    case "stale":
      try {
        deps.files.remove(state.path);
      } catch (err) {
        deps.io.err(`error: could not remove ${state.path} — ${err instanceof Error ? err.message : String(err)}`);
        return EXIT.FAIL;
      }
      deps.io.out(`✓ removed ${state.path}`);
      deps.io.out("  A running pi keeps it until `/reload` or a restart.");
      return EXIT.OK;
  }
}

/** `collie inbox status [pi]` — READ-ONLY. It reports; it never repairs. */
export function cmdInboxStatus(deps: InboxDeps, args: readonly string[]): number {
  if (args.length > 0 && !readHarness(deps, args, "status")) return EXIT.USAGE;
  const state = inboxState(deps);
  switch (state.kind) {
    case "refused":
      deps.io.out(`pi: refused — ${state.reason}`);
      break;
    case "not-installed":
      deps.io.out(`pi: not installed (${state.path}) — \`collie inbox install pi\` writes it`);
      break;
    case "current":
      deps.io.out(`pi: installed and current (${state.path})`);
      break;
    case "stale":
      deps.io.out(`pi: installed but stale (v${state.at}, ${state.path}) — \`collie inbox install pi\` heals it`);
      break;
    case "foreign":
      deps.io.out(`pi: a file that is not Collie's is in the way (${state.path}) — install leaves it alone`);
      break;
  }
  return EXIT.OK;
}

export function inboxUsage(): string {
  return `usage: collie inbox {${INBOX_SUBCOMMANDS.join("|")}} {${INBOX_HARNESSES.join("|")}}`;
}

/** The parent verb. Reached by a bare `collie inbox` or a misspelt sub-verb, as `cmdHooks` is. */
export function cmdInbox(deps: InboxDeps, args: readonly string[]): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "install":
      return cmdInboxInstall(deps, rest);
    case "uninstall":
      return cmdInboxUninstall(deps, rest);
    case "status":
      return cmdInboxStatus(deps, rest);
    default:
      if (sub !== undefined && sub !== "" && sub !== "help") deps.io.err(`error: unknown inbox subcommand \`${sub}\``);
      deps.io.err(inboxUsage());
      deps.io.err("  install     write the pi extension that hands a phone message to the live session: `inbox install pi`");
      deps.io.err("  uninstall   remove it again, only when it is Collie's: `inbox uninstall pi`");
      deps.io.err("  status      whether it is installed, current or stale (reads only)");
      return EXIT.USAGE;
  }
}
