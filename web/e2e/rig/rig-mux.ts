// The multiplexer each machine of the rig runs, chosen by COLLIE_RIG_MUX (M78 spec 03). Pure: no
// side effects, Node builtins and the web's JSON readers only, so the rig CLI (bun), the Playwright runner (node) and the tests
// import the same rules.
//
//   COLLIE_RIG_MUX unset or `herdr`      every machine runs a scratch Herdr TUI server (the gate as it was)
//   COLLIE_RIG_MUX=herdr-core            every machine runs a scratch herdr-core (`hc server start`)
//   COLLIE_RIG_MUX=herdr,herdr-core      the lead on Herdr, the member on herdr-core (the dev lane's shape)
//
// The driver itself (start, a pane, a harness, a close, the stop) is in rig-lib.ts for the panes and in
// rig.ts for the server's life, one branch per mux. The herdr branch is the rig as it was before M78.
import { join } from "node:path";

import { asJsonObject, type JsonObject, type JsonValue } from "../../src/lib/json";

export type RigMux = "herdr" | "herdr-core";
export const RIG_MUXES: readonly RigMux[] = ["herdr", "herdr-core"];

/** The mux each machine of the rig runs. */
export interface RigMuxes {
  readonly lead: RigMux;
  readonly member: RigMux;
}

/** The mux a word names, or null for any other word. */
function rigMuxOf(word: string): RigMux | null {
  return RIG_MUXES.find((mux) => mux === word.trim()) ?? null;
}

/** The mux of each machine from COLLIE_RIG_MUX: one name for both, or `<lead>,<member>`. Throws on any other word. */
export function rigMuxFrom(raw: string | undefined): RigMuxes {
  if ((raw ?? "").trim() === "") return { lead: "herdr", member: "herdr" };
  const words = (raw ?? "").split(",");
  const muxes = words.map(rigMuxOf);
  const lead = muxes[0] ?? null;
  const member = muxes.length === 1 ? lead : (muxes[1] ?? null);
  if (words.length > 2 || lead === null || member === null) {
    throw new Error(`COLLIE_RIG_MUX takes ${RIG_MUXES.join(" or ")}, or two of them as <lead>,<member>; not ${JSON.stringify(raw)}`);
  }
  return { lead, member };
}

/**
 * The scratch core's client socket: `hc.sock` in the machine's short rig home. Not under the state root:
 * the core binds its holder sockets beside it (`hc.holder.<8 hex>.sock`), and a long state root such as
 * the nightly runner's must not push them past sun_path. The short home is the rig's own (sock-path.ts).
 */
export const coreSocketIn = (xdgHome: string): string => join(xdgHome, "hc.sock");

/**
 * The beacon hooks `collie hooks install claude` writes (cli/hooks.ts installDocument over
 * cli/beacon.ts BEACON_HOOKS: five events, no matcher, `timeout: 10`, the marker comment), for a
 * Claude in a core terminal. herdr-core keeps no conversation id, so without them a core pane has no
 * History and no Chat (HC_API.md "What does not fit"). An operator on the core installs them; the rig
 * writes the same groups into its scratch CLAUDE_CONFIG_DIR, with the rig's own `collie` shim.
 */
export const BEACON_EVENTS: readonly string[] = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "Notification"];
export const beaconHookCommand = (collie: string): string => `${collie} beacon emit # collie-beacon v1`;

/**
 * The hc label that carries a rig terminal's workspace label (`leg-pi`, `rig-<time>`). Never the terminal's
 * NAME: the bridge reads a core terminal's name as the pane's own label (MUX_CONTRACT.md § Pane naming),
 * and a walky talky header names the sender by it. On Herdr the rig names the workspace, not the pane, so
 * the header says the folder (`(pi, project)`); a named terminal made it `(pi, leg-pi-<stamp>)` on the core,
 * a prompt no recording holds, and the Claude replay fell out of step from pi case 8 on (M79 spec 03).
 * herdr-app's own labels are `herdr.space`, `herdr.tab` and `where`; the bridge reads no other key.
 */
export const CORE_RIG_LABEL = "collie-rig.label";

/** The `hc run` arguments of a new rig terminal: no name, the rig's label as an hc label, then any more labels. */
export function coreRunArgs(cwd: string, label: string, argv: readonly string[], labels: Readonly<Record<string, string>> = {}): string[] {
  const more = Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  return ["run", "--bg", "--label", `${CORE_RIG_LABEL}=${label}`, ...more, "--cwd", cwd, "--no-parent", "--no-notify", ...(argv.length === 0 ? [] : ["--", ...argv])];
}

// ── spaces on the core (M98 spec 06) ─────────────────────────────────────────────────────────────
//
// A walky talky message stays in its space, and a space is the multiplexer's own grouping. On Herdr a
// space is a workspace and its label is its name (rig-lib.ts). On herdr-core the bridge reads a space
// from herdr-app's layout document (`doc.get herdr-app`) and the `herdr.space` and `herdr.tab` labels of
// a terminal (bridge/mux/herdr-core/layout.ts), and counts a space as named only when the DOCUMENT names
// it. The rig has no herdr-app, so it writes the same few fields herdr-app would (`doc.set`, which the
// core stores as an opaque value) and labels its terminals. A terminal with no such labels is in the
// core's implicit space, which is unnamed: that is the shape of the rig's view shell.

/** The labels herdr-app puts on a terminal to place it in a space and a tab (layout.ts SPACE_LABEL and TAB_LABEL). */
export const CORE_SPACE_LABEL = "herdr.space";
export const CORE_TAB_LABEL = "herdr.tab";

/** The name of herdr-app's layout document on a core. */
export const CORE_LAYOUT_DOC = "herdr-app";

/** The ids a rig space has in the layout document: one tab holds every terminal of the space. */
export interface CoreSpaceIds {
  readonly space: string;
  readonly tab: string;
}

/** A space's ids from its name: the same name gives the same ids on every machine and every run. */
export function coreSpaceIds(name: string): CoreSpaceIds {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  return { space: `sp-rig-${slug}`, tab: `tb-rig-${slug}` };
}

/** The labels that put a terminal in a rig space. */
export const coreSpaceLabels = (ids: CoreSpaceIds) => ({ [CORE_SPACE_LABEL]: ids.space, [CORE_TAB_LABEL]: ids.tab });

/** A fresh unnamed space: ids no document names, so the bridge reads it as a space of its own with no name. */
export function coreUnnamedSpaceIds(stamp: string): CoreSpaceIds {
  return { space: `sp-rig-unnamed-${stamp}`, tab: `tb-rig-unnamed-${stamp}` };
}

/** The layout document with a space in it, and whether the caller must write it. */
export interface LayoutWithSpace {
  readonly value: JsonObject;
  readonly ids: CoreSpaceIds;
  /** False when the document named the space already: write nothing. */
  readonly changed: boolean;
}

/**
 * The layout document with a space named `name` in it. The document as it was when it already holds
 * one; else every other field kept and the space added, with one unnamed tab. Pure: the caller reads
 * the document (`doc.get`) and writes the result (`doc.set`).
 */
export function layoutWithSpace(value: JsonValue | undefined, name: string): LayoutWithSpace {
  const doc = asJsonObject(value) ?? {};
  const spaces = Array.isArray(doc.spaces) ? doc.spaces : [];
  const ids = coreSpaceIds(name);
  const held = spaces.some((space) => asJsonObject(space)?.name === name && asJsonObject(space)?.id === ids.space);
  if (held) return { value: doc, ids, changed: false };
  const added = { id: ids.space, name, folder: "", tabs: [{ id: ids.tab, name: "" }] };
  return { value: { ...doc, spaces: [...spaces, added] }, ids, changed: true };
}
