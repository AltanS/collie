// Where a multiplexer's pane identity lives in the environment of a process running inside it.
//
// ONE TABLE, READ BY TWO SIDES. The hook emitter (`cli/beacon.ts`, `collie beacon emit`) reads the
// variables out of its own environment, and the inside wire (`bridge/inside/`, M99 spec 01) reads the
// same variables out of a part's `hello`, where the part copied them from its own process. A part never
// shapes a marker itself: it sends the raw values of {@link MARKER_ENV_NAMES} and the bridge runs this
// table over them, so a new multiplexer joins both paths with one row here.
//
// Pure: no environment is read here, the caller passes one in.

import type { BeaconMarker } from "./types.ts";

/** An environment to read the markers from: the process's own, or the values a part sent. */
export type MarkerEnv = Readonly<Record<string, string | undefined>>;

/** The marker namespace of a Herdr pane, which is the Herdr adapter's registry key. */
export const HERDR_NAMESPACE = "herdr";

/**
 * The marker namespace of a herdr-core terminal, which is that adapter's registry key. A literal, not
 * an import, because this verb runs on every hook event and must stay a handful of module loads;
 * `cli/beacon.test.ts` pins it to the adapter's own constant.
 */
export const HERDR_CORE_NAMESPACE = "herdr-core";

/**
 * Where a multiplexer's pane identity lives in the environment of a process running inside it.
 *
 * THE GATE IS THIS TABLE, and it is consulted BEFORE stdin is read. An agent in a plain terminal has
 * none of these variables, so it costs one process spawn and no file — which is what makes the
 * global hook install (`cli/hooks.ts`) affordable.
 *
 * `pane` is stored RAW, exactly as `BeaconMarker` requires: `%7` for tmux, a bare integer for zellij.
 * Any prefixing a multiplexer's Collie ids need (zellij's `terminal_`) belongs to that adapter's
 * matcher at the join (M11/03) — the emitter cannot know which multiplexer this Collie drives, and a
 * value rewritten here could never be un-rewritten there.
 */
interface MuxEnvMarker {
  /** The mux registry's own key (`bridge/mux/registry.ts`) — tmux, zellij. */
  readonly namespace: string;
  /** The variable holding the pane id. Its absence is what "not in this multiplexer" means. */
  readonly paneVar: string;
  /** The variable holding the addressing space — see {@link BeaconMarker.scope}. */
  readonly scopeVar: string;
  /** The scope value inside that variable, for a variable that carries more than the scope. */
  scopeOf(raw: string): string;
}

const MUX_ENV_MARKERS: readonly MuxEnvMarker[] = [
  {
    namespace: "tmux",
    paneVar: "TMUX_PANE",
    // `$TMUX` is `<socket-path>,<server-pid>,<session-index>` and only the first field is the server
    // socket — which is what `BeaconMarker.scope` is defined to hold. The server pid changes nothing
    // about which panes exist, so carrying it would make the scope differ from the one the adapter
    // addresses tmux with.
    scopeVar: "TMUX",
    scopeOf: (raw) => raw.split(",")[0] ?? raw,
  },
  {
    namespace: "tern",
    paneVar: "TERN_PANE",
    scopeVar: "TERN_PANE_SOCKET",
    scopeOf: (raw) => raw,
  },
  {
    namespace: "zellij",
    paneVar: "ZELLIJ_PANE_ID",
    // zellij pane ids are per-session integers, so the session name IS the addressing space.
    scopeVar: "ZELLIJ_SESSION_NAME",
    scopeOf: (raw) => raw,
  },
  {
    // Herdr exports its own wire id (`w54:pW`) and the socket of the server that owns the pane
    // (M56 spec 11). Herdr names its agents itself, so a Herdr marker never names a pane's agent: it
    // places the hook edges on a Herdr pane, and nothing else.
    namespace: HERDR_NAMESPACE,
    paneVar: "HERDR_PANE_ID",
    scopeVar: "HERDR_SOCKET_PATH",
    scopeOf: (raw) => raw,
  },
  {
    // The new Herdr core exports the terminal's address and the socket of the core that owns it
    // (M74 spec 04, probed 2026-10-29 on hc 0.1.14). A core terminal started from inside the Herdr
    // TUI inherits that TUI's variables too, so a pane can carry both markers; each names only its own.
    namespace: HERDR_CORE_NAMESPACE,
    paneVar: "HC_TERMINAL_ID",
    scopeVar: "HC_TERMINAL_SOCKET",
    scopeOf: (raw) => raw,
  },
];

/**
 * Every multiplexer this process can see itself inside — a LIST, because nesting is real (tmux inside
 * zellij and the other way round) and the emitter cannot know which one Collie is driving.
 *
 * A namespace whose scope variable is missing is skipped rather than given a default: without the
 * addressing space, `%7` from another tmux server would join to this pane's agent.
 */
export function readEnvMarkers(env: MarkerEnv): BeaconMarker[] {
  const markers: BeaconMarker[] = [];
  for (const source of MUX_ENV_MARKERS) {
    const pane = env[source.paneVar]?.trim();
    const rawScope = env[source.scopeVar]?.trim();
    if (!pane || !rawScope) continue;
    const scope = source.scopeOf(rawScope).trim();
    if (scope === "") continue;
    markers.push({ namespace: source.namespace, scope, pane });
  }
  return markers;
}

/** Every variable name the table reads, pane and scope, in table order. A part sends these and no others. */
export const MARKER_ENV_NAMES: readonly string[] = MUX_ENV_MARKERS.flatMap((source) => [source.paneVar, source.scopeVar]);
