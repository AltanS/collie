// TMUX'S OWN VOCABULARY — the argv this adapter builds and the text tmux answers with.
//
// Pure, so every format string, every parse and every error classification below is proved by the
// conformance fixture with no tmux installed. Nothing here knows the mux port; adapter.ts is the one
// file holding both vocabularies at once (the same split Herdr's client.ts / adapter.ts has).
//
// THE ONE LISTING CALL. tmux's `-F` format language means the adapter asks for exactly the fields the
// contract wants instead of parsing a human table, and tmux takes several commands in ONE invocation
// — so the whole snapshot is a single spawn whose three sections tag themselves:
//
//   tmux list-sessions -F 'S␟…' ; list-windows -a -F 'W␟…' ; list-panes -a -F 'P␟…'
//
// The separator is U+001F UNIT SEPARATOR, chosen because the free-text fields (a window name, a pane
// title, a working directory) can carry anything a user can type, and `|`, tab and space are all
// things a user types. It is not a proof — a program CAN emit U+001F into its own title — so the
// free-text fields are LAST in every record and the parser folds any excess back into the final
// field rather than mis-binding the fixed ones.
//
// Probed first-hand against tmux 3.6b on a throwaway server (`tmux -L collieprobe`, M10/04).

/** Field separator inside one `-F` record. See the header for why it is this byte. */
export const SEP = "\u001f";

/** Which section a `-F` line belongs to. The first field of every record. */
const SESSION_TAG = "S";
const WINDOW_TAG = "W";
const PANE_TAG = "P";

/**
 * One tmux session — what Collie calls a SPACE (adapter.ts documents the mapping).
 *
 * `id` is `$N`, tmux's own session id: it survives a rename, where `name` does not. That is identity
 * rule 2, and it is the whole reason the name is carried separately rather than used as the id.
 */
export interface TmuxSession {
  readonly id: string;
  readonly name: string;
  readonly windows: number;
  /** tmux's last-activity stamp. The only ordering tmux offers over sessions — see `focused`. */
  readonly activity: number;
}

/** One tmux window — what Collie calls a TAB. `id` is `@N`. */
export interface TmuxWindow {
  readonly id: string;
  readonly sessionId: string;
  readonly index: number;
  readonly active: boolean;
  readonly panes: number;
  /** tmux is renaming this window after whatever runs in it, so its name is not the operator's. */
  readonly autoNamed: boolean;
  readonly name: string;
}

/** One tmux pane. `id` is `%N`, carried into Collie unchanged (identity rule 1). */
export interface TmuxPaneRecord {
  readonly id: string;
  readonly windowId: string;
  readonly sessionId: string;
  /** The pane's process has ended and `remain-on-exit` kept its record. A write to it is `gone`. */
  readonly dead: boolean;
  readonly active: boolean;
  readonly windowActive: boolean;
  readonly height: number;
  /** Lines tmux has kept behind this pane's viewport. With `height`, the bound on a `recent` read. */
  readonly historySize: number;
  /** tmux's default `pane_title`. A title equal to it is tmux's, not the operator's. */
  readonly host: string;
  readonly cwd: string;
  readonly title: string;
}

/** Everything one listing call returned. */
export interface TmuxListing {
  readonly sessions: readonly TmuxSession[];
  readonly windows: readonly TmuxWindow[];
  readonly panes: readonly TmuxPaneRecord[];
}

const SESSION_FORMAT = [SESSION_TAG, "#{session_id}", "#{session_windows}", "#{session_activity}", "#{session_name}"].join(SEP);
const WINDOW_FORMAT = [
  WINDOW_TAG,
  "#{window_id}",
  "#{session_id}",
  "#{window_index}",
  "#{window_active}",
  "#{window_panes}",
  "#{automatic-rename}",
  "#{window_name}",
].join(SEP);
const PANE_FORMAT = [
  PANE_TAG,
  "#{pane_id}",
  "#{window_id}",
  "#{session_id}",
  "#{pane_dead}",
  "#{pane_active}",
  "#{window_active}",
  "#{pane_height}",
  "#{history_size}",
  "#{host}",
  "#{pane_current_path}",
  "#{pane_title}",
].join(SEP);

/**
 * The one invocation that answers `snapshot()`.
 *
 * The bare `";"` elements are tmux's command separator, and that is exactly what is wanted here —
 * one spawn, three commands. It is also the trap the write paths have to dodge: an argument that IS
 * a `;` is eaten by the same lexer, which is why literal text never travels as an argument at all
 * (exec.ts) and why a `;` KEY is escaped (keys.ts). Both probed, M10/04.
 */
export const LISTING_ARGS: readonly string[] = [
  "list-sessions",
  "-F",
  SESSION_FORMAT,
  ";",
  "list-windows",
  "-a",
  "-F",
  WINDOW_FORMAT,
  ";",
  // `list-panes -a -F <format>`: every pane of the server, asking for exactly the fields the contract
  // wants — never a human table parsed back into records.
  "list-panes",
  "-a",
  "-F",
  PANE_FORMAT,
];

/** The `-F` a create call asks for, so a fresh pane's identity comes back on the same round trip. */
export const CREATED_FORMAT = ["#{pane_id}", "#{window_id}", "#{session_id}", "#{session_name}", "#{pane_current_path}"].join(SEP);

/** A freshly created pane, as `new-window -P -F` / `new-session -P -F` reports it. */
export interface TmuxCreated {
  readonly paneId: string;
  readonly windowId: string;
  readonly sessionId: string;
  readonly sessionName: string;
  readonly cwd: string;
}

/** Split one record into exactly `count` fields, folding any excess back into the last one. */
function fields(line: string, count: number): string[] {
  const parts = line.split(SEP);
  if (parts.length <= count) return parts;
  return [...parts.slice(0, count - 1), parts.slice(count - 1).join(SEP)];
}

/** A tmux `-F` flag field: `1` is true and everything else — including an empty value — is false. */
function flag(value: string | undefined): boolean {
  return value === "1";
}

/** A tmux `-F` numeric field, or 0 when tmux reported nothing usable. */
function num(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Parse the three tagged sections of one listing call.
 *
 * A line whose tag is unknown, or which is short of its fields, is DROPPED rather than half-read: a
 * partially-parsed pane would reach the snapshot with an empty id, and `checkIdentitySet` would fail
 * a whole herd over one malformed row.
 */
export function parseListing(stdout: string): TmuxListing {
  const sessions: TmuxSession[] = [];
  const windows: TmuxWindow[] = [];
  const panes: TmuxPaneRecord[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith(SESSION_TAG + SEP)) {
      const [, id, windowCount, activity, name] = fields(line, 5);
      if (id === undefined || id.length === 0) continue;
      sessions.push({ id, name: name ?? id, windows: num(windowCount), activity: num(activity) });
      continue;
    }
    if (line.startsWith(WINDOW_TAG + SEP)) {
      const [, id, sessionId, index, active, paneCount, auto, name] = fields(line, 8);
      if (id === undefined || id.length === 0 || sessionId === undefined) continue;
      windows.push({
        id,
        sessionId,
        index: num(index),
        active: flag(active),
        panes: num(paneCount),
        autoNamed: flag(auto),
        name: name ?? "",
      });
      continue;
    }
    if (!line.startsWith(PANE_TAG + SEP)) continue;
    const [, id, windowId, sessionId, dead, active, windowActive, height, history, host, cwd, title] = fields(line, 12);
    if (id === undefined || id.length === 0 || windowId === undefined || sessionId === undefined) continue;
    panes.push({
      id,
      windowId,
      sessionId,
      dead: flag(dead),
      active: flag(active),
      windowActive: flag(windowActive),
      height: num(height),
      historySize: num(history),
      host: host ?? "",
      cwd: cwd ?? "",
      title: title ?? "",
    });
  }
  return { sessions, windows, panes };
}

/** Parse the one line a `-P -F` create call prints, or null when tmux printed something else. */
export function parseCreated(stdout: string): TmuxCreated | null {
  const line = stdout.split("\n").find((candidate) => candidate.length > 0);
  if (line === undefined) return null;
  const [paneId, windowId, sessionId, sessionName, cwd] = fields(line, 5);
  if (paneId === undefined || windowId === undefined || sessionId === undefined) return null;
  if (paneId.length === 0) return null;
  return { paneId, windowId, sessionId, sessionName: sessionName ?? sessionId, cwd: cwd ?? "" };
}

/**
 * tmux's "that thing does not exist" answer, probed verbatim: `can't find pane: %999`, and the same
 * sentence for a window and a session. It is the contract's `gone` — the operator's screen is stale,
 * and a retry can only fail the same way.
 */
const MISSING_TARGET = /can't find (?:pane|window|session|client)|(?:pane|window|session) not found/iu;

/**
 * tmux is not answering at all: no server on that socket, or no binary to ask with. The contract's
 * `unreachable` — the only refusal worth retrying, and what drives the connected banner.
 */
const NO_SERVER = /no server running|error connecting|no such file or directory|failed to connect|no tmux binary/iu;

/** Whether this stderr says the addressed pane/window/session has gone away. */
export function saysMissing(stderr: string): boolean {
  return MISSING_TARGET.test(stderr);
}

/** Whether this stderr says the tmux server itself is not there. */
export function saysNoServer(stderr: string): boolean {
  return NO_SERVER.test(stderr);
}

// ── Control mode ──────────────────────────────────────────────────────────────

/**
 * What one line of control-mode output means to the watch.
 *
 * tmux's control protocol prefixes every notification with `%` (probed: `%output`, `%window-add`,
 * `%window-renamed`, `%unlinked-window-add`, `%sessions-changed`, `%session-changed`, `%exit`). The
 * adapter needs three answers out of that and no more, because a notification is a HINT to re-read
 * and never state (mux/types.ts § MuxWatchOptions).
 */
export type TmuxControlLine =
  | { readonly kind: "pane"; readonly paneId: string }
  | { readonly kind: "topology" }
  | { readonly kind: "exit" }
  | { readonly kind: "ignore" };

/**
 * The notifications that mean "the herd's structure moved".
 *
 * Enumerated rather than matched with a wildcard on purpose: a `%` line this adapter has not been
 * taught is ignored, so a future tmux notification cannot silently become a topology storm. The
 * unlisted ones seen in the probe (`%begin`, `%end`, `%error`, `%session-changed`) carry command
 * output or a client fact, not a herd change.
 */
const TOPOLOGY_NOTIFICATIONS: ReadonlySet<string> = new Set([
  "%window-add",
  "%window-close",
  "%window-renamed",
  "%window-pane-changed",
  "%unlinked-window-add",
  "%unlinked-window-close",
  "%unlinked-window-renamed",
  "%layout-change",
  "%sessions-changed",
  "%session-renamed",
  "%session-window-changed",
  "%pane-mode-changed",
]);

/**
 * Classify one control-mode line.
 *
 * `%output %<paneId> <bytes>` is the pane-content push, and the pane id is carried verbatim — it is
 * the same `%N` the listing reports, which is why nothing has to be mapped.
 */
export function classifyControlLine(line: string): TmuxControlLine {
  if (!line.startsWith("%")) return { kind: "ignore" };
  const space = line.indexOf(" ");
  const verb = space < 0 ? line : line.slice(0, space);
  if (verb === "%exit") return { kind: "exit" };
  if (verb === "%output") {
    const rest = line.slice(space + 1);
    const end = rest.indexOf(" ");
    const paneId = end < 0 ? rest : rest.slice(0, end);
    return paneId.startsWith("%") && paneId.length > 1 ? { kind: "pane", paneId } : { kind: "ignore" };
  }
  return TOPOLOGY_NOTIFICATIONS.has(verb) ? { kind: "topology" } : { kind: "ignore" };
}

/**
 * The argv for one control-mode client, attached to one session.
 *
 * Both client flags are load-bearing and neither is a convenience. `ignore-size` stops Collie's
 * watcher from resizing the operator's own windows — a control client is a real client, and without
 * it every window in the session would be squeezed to the watcher's default 80×24. `read-only`
 * means this connection can never type: writes go through `send-keys`, where they are audited and
 * refused, and a stream that could also write would be a second, ungated door into a live terminal.
 */
export function controlArgs(sessionId: string): string[] {
  return ["-C", "attach-session", "-t", sessionId, "-f", "ignore-size,read-only"];
}
