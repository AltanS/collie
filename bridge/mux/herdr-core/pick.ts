import { posix } from "node:path";

import { DEFAULT_MUX, muxEndpointVar } from "../registry.ts";
import { HERDR_CORE_MUX, herdrCoreSocketFor } from "./adapter.ts";

// WHEN NOBODY NAMED A MULTIPLEXER, AND ONLY THE NEW CORE IS HERE (M74, decided 2026-10-30).
//
// The default stays `herdr`, the Herdr TUI. One case moves: no `COLLIE_MUX`, no Herdr TUI socket,
// no sign that this host has the Herdr TUI installed at all, and a herdr-core socket where `hc`
// would dial. That box runs herdr-app and not the TUI, and `herdr` there would mirror a socket that
// is not there. The bridge (`bridge/config.ts`), `collie start` (`cli/mux.ts`), `collie status`,
// `collie update` and the config-dir lookup (`cli/context.ts`) all ask this one file, so none of
// them can disagree.
//
// A socket FILE is the evidence, as for the TUI (`doctor`'s `herdr-socket` row): nothing is dialled
// here. A stale socket of a dead core is picked too, on a host with no Herdr TUI install, and then
// reads as unreachable, which names the socket. That is accepted: such a host has nothing else to
// drive.
//
// The TUI's absent socket is NOT enough on its own (release-night counsel, 2026-10-30). A host with
// both Herdrs whose TUI is not up yet when Collie's unit starts would get the core until a restart.
// So a Herdr TUI INSTALL counts as well as a running TUI: Herdr's own `config.toml`, or a Collie
// plugin config dir under Herdr's (`herdr.collie`, `herdr.collie-<instance>`). herdr-app keeps its
// own files under `~/.config/herdr-app`, never under `~/.config/herdr`. A named instance of a
// herdr-core install keeps its `.env` under Herdr's plugin config dir too, so on such a host the
// auto-pick stands down; `collie start` writes `COLLIE_MUX` down on its first run anyway, and
// `COLLIE_MUX=herdr-core` is the one sentence that always wins.

/** herdr-core picked in place of the default, with the reason for an operator to read. */
export interface HerdrCorePick {
  readonly mux: string;
  /** The socket the adapter will dial. */
  readonly socket: string;
  readonly evidence: string;
}

/** What the pick may read on this host. Nothing here dials, spawns or writes. */
export interface PickHost {
  readonly home: string;
  readonly exists: (path: string) => boolean;
  /** The entry names of a directory, or `[]` when it cannot be read. */
  readonly list: (dir: string) => readonly string[];
}

/**
 * What one look at the host found: herdr-core picked, herdr-core seen and NOT picked (with the
 * reason, said once at boot), or no core socket at all, which says nothing.
 */
export type HerdrCoreLook =
  | { readonly kind: "picked"; readonly pick: HerdrCorePick }
  | { readonly kind: "declined"; readonly socket: string; readonly reason: string }
  | { readonly kind: "absent" };

/** Collie's Herdr plugin id, and the prefix of every instance's plugin config dir (`bridge/front-door.ts`). */
const TUI_PLUGIN_PREFIX = "herdr.collie";

/**
 * The path that shows a Herdr TUI install of Collie on this host, or `null`. Herdr's own
 * `config.toml` first, then any Collie plugin config dir under Herdr's. POSIX paths: herdr-core runs
 * on Linux and macOS only, and every caller skips this look on Windows.
 */
export function herdrTuiMarker(host: PickHost): string | null {
  const herdrDir = posix.join(host.home, ".config", "herdr");
  const config = posix.join(herdrDir, "config.toml");
  if (host.exists(config)) return config;
  const plugins = posix.join(herdrDir, "plugins", "config");
  const own = host.list(plugins).find((name) => name === TUI_PLUGIN_PREFIX || name.startsWith(`${TUI_PLUGIN_PREFIX}-`));
  return own === undefined ? null : posix.join(plugins, own);
}

/**
 * Look for herdr-core in place of the Herdr TUI. The caller has already checked that `COLLIE_MUX`
 * is unset, and that the platform is not Windows.
 */
export function lookForHerdrCore(
  tuiSocket: string,
  env: Readonly<Record<string, string | undefined>>,
  host: PickHost,
): HerdrCoreLook {
  const socket = herdrCoreSocketFor(env[muxEndpointVar(HERDR_CORE_MUX)] ?? "", env);
  if (!host.exists(socket)) return { kind: "absent" };
  if (host.exists(tuiSocket)) {
    return { kind: "declined", socket, reason: `a Herdr socket at ${tuiSocket}` };
  }
  const marker = herdrTuiMarker(host);
  if (marker !== null) {
    return { kind: "declined", socket, reason: `this host has a Herdr TUI install (${marker})` };
  }
  return { kind: "picked", pick: { mux: HERDR_CORE_MUX, socket, evidence: `a herdr-core socket at ${socket}, and no Herdr socket at ${tuiSocket}` } };
}

/** herdr-core, when {@link lookForHerdrCore} picks it; else `null`. */
export function herdrCoreInPlaceOfTui(
  tuiSocket: string,
  env: Readonly<Record<string, string | undefined>>,
  host: PickHost,
): HerdrCorePick | null {
  const look = lookForHerdrCore(tuiSocket, env, host);
  return look.kind === "picked" ? look.pick : null;
}

/** The one log line for a core socket that was seen and not picked. */
export function declinedLine(look: HerdrCoreLook): string | null {
  if (look.kind !== "declined") return null;
  return `a herdr-core socket at ${look.socket}, not picked: ${look.reason}; set COLLIE_MUX=herdr-core to drive it`;
}

/**
 * Does this environment drive herdr-core? In this order: `COLLIE_MUX` as the instance's merged
 * environment carries it (its `.env` and its unit), then a Herdr TUI install (never the core), and
 * only then the sockets, through {@link lookForHerdrCore}. `collie update` and the config-dir lookup
 * ask this to leave every `herdr plugin` command alone on such a host (M74 spec 04): the Herdr TUI's
 * plugin registry is not part of a herdr-core install. A TUI host whose socket is briefly absent
 * during an update keeps its `herdr plugin` steps, because its install marker is still there.
 */
export function drivesHerdrCore(
  tuiSocket: string,
  env: Readonly<Record<string, string | undefined>>,
  host: PickHost,
): boolean {
  const named = (env.COLLIE_MUX ?? "").trim();
  if (named !== "") return named === HERDR_CORE_MUX;
  return herdrCoreInPlaceOfTui(tuiSocket, env, host) !== null;
}

/** Which multiplexer an environment drives, and why, as the bridge resolves it at boot. */
export interface MuxResolution {
  readonly mux: string;
  /** Why {@link mux} was picked with no `COLLIE_MUX`; `""` when it was named or is the default. */
  readonly pickedBecause: string;
  /** The socket the picked adapter dials; `""` unless herdr-core was picked. */
  readonly pickedSocket: string;
  /** Why a herdr-core socket that is present was NOT picked; `""` when there is none to explain. */
  readonly notPickedBecause: string;
}

/**
 * `COLLIE_MUX` when it names one, else herdr-core when {@link lookForHerdrCore} picks it, else the
 * default. herdr-core runs on Linux and macOS only, so Windows keeps the default without a look.
 * `loadConfig` and `collie status` both resolve through here.
 */
export function resolveMux(
  tuiSocket: string,
  env: Readonly<Record<string, string | undefined>>,
  host: PickHost,
  platform: string,
): MuxResolution {
  const named = (env.COLLIE_MUX ?? "").trim();
  if (named !== "") return { mux: named, pickedBecause: "", pickedSocket: "", notPickedBecause: "" };
  if (platform === "win32") return { mux: DEFAULT_MUX, pickedBecause: "", pickedSocket: "", notPickedBecause: "" };
  const look = lookForHerdrCore(tuiSocket, env, host);
  if (look.kind === "picked") {
    return { mux: look.pick.mux, pickedBecause: look.pick.evidence, pickedSocket: look.pick.socket, notPickedBecause: "" };
  }
  return { mux: DEFAULT_MUX, pickedBecause: "", pickedSocket: "", notPickedBecause: declinedLine(look) ?? "" };
}
