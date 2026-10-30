// The multiplexer each machine of the rig runs, chosen by COLLIE_RIG_MUX (M78 spec 03). Pure: no
// side effects, Node builtins only, so the rig CLI (bun), the Playwright runner (node) and the tests
// import the same rules.
//
//   COLLIE_RIG_MUX unset or `herdr`      every machine runs a scratch Herdr TUI server (the gate as it was)
//   COLLIE_RIG_MUX=herdr-core            every machine runs a scratch herdr-core (`hc server start`)
//   COLLIE_RIG_MUX=herdr,herdr-core      the lead on Herdr, the member on herdr-core (the dev lane's shape)
//
// The driver itself (start, a pane, a harness, a close, the stop) is in rig-lib.ts for the panes and in
// rig.ts for the server's life, one branch per mux. The herdr branch is the rig as it was before M78.
import { join } from "node:path";

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

/** The `hc run` arguments of a new rig terminal: no name, the rig's label as an hc label. */
export function coreRunArgs(cwd: string, label: string, argv: readonly string[]): string[] {
  return ["run", "--bg", "--label", `${CORE_RIG_LABEL}=${label}`, "--cwd", cwd, "--no-parent", "--no-notify", ...(argv.length === 0 ? [] : ["--", ...argv])];
}
