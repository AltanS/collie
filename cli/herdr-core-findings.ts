import { herdrCoreSocketFor } from "../bridge/mux/herdr-core/adapter.ts";
import { HC_GENERATION, readHcCore, type HcCoreReading } from "../bridge/mux/herdr-core/client.ts";
import { bad, ok, warn, type Finding } from "./finding.ts";
import type { Exec, Files } from "./sys.ts";

// THE TWO DOCTOR ROWS FOR AN INSTALL THAT DRIVES herdr-core (M74 spec 02).
//
// They stand where `herdr-socket` and `herdr-version` stand for the Herdr TUI, and those two are
// dropped on such an install (`appliesToMux` in doctor.ts). Both are reads: the socket row looks
// for the file and then dials it (`hello` and `server.status`, 2 s), and the version row runs
// `hc --version`, which starts no core. The bridge needs only the socket, so a missing `hc` is a
// warning and not an error. Both are reads: a dial that fails writes nothing and starts nothing.

/** How long the dial may take before the socket reads as dead. */
export const HC_DIAL_MS = 2000;

/** The dial, as a seam the tests fake. The real one is {@link readHcCore}. */
export type HcDial = (socketPath: string, timeoutMs: number) => Promise<HcCoreReading>;

export interface HerdrCoreDoctorDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exec: Exec;
  readonly files: Files;
  /** `COLLIE_MUX_ENDPOINT_HERDR_CORE`, trimmed; empty means the core's own default socket. */
  readonly endpoint: string;
  /** Absent means the real dial. */
  readonly dial?: HcDial | undefined;
}

const START_THE_CORE =
  "start the core with `hc server start` (or open herdr-app), or name the session with HC_SESSION, then `collie restart`";

/** `hc-socket` and `hc-version`. */
export async function herdrCoreFindings(deps: HerdrCoreDoctorDeps): Promise<Finding[]> {
  return [await hcSocket(deps), hcVersion(deps)];
}

async function hcSocket(deps: HerdrCoreDoctorDeps): Promise<Finding> {
  const socket = herdrCoreSocketFor(deps.endpoint, deps.env);
  if (!deps.files.exists(socket)) {
    return bad(
      "hc-socket",
      `no herdr-core socket at ${socket}, and everything the bridge shows comes through it`,
      START_THE_CORE,
    );
  }
  try {
    const core = await (deps.dial ?? readHcCore)(socket, HC_DIAL_MS);
    const terminals = `${String(core.live)} live terminal${core.live === 1 ? "" : "s"}`;
    if (core.generation !== HC_GENERATION) {
      return bad(
        "hc-socket",
        `${socket}: herdr-core ${core.version} speaks protocol generation ${String(core.generation)}, and this Collie speaks ${String(HC_GENERATION)}`,
        "update Collie or herdr-core so the two match",
      );
    }
    return ok("hc-socket", `${socket}: herdr-core ${core.version}, ${terminals}`);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return bad(
      "hc-socket",
      `the socket file ${socket} exists, but no core answers on it (${why}). It may be left over from a core that stopped`,
      START_THE_CORE,
    );
  }
}

function hcVersion(deps: HerdrCoreDoctorDeps): Finding {
  const asked = deps.exec.capture("hc", ["--version"], 5000);
  const line = asked.stdout.split("\n")[0]?.trim() ?? "";
  if (asked.found && asked.code === 0 && line !== "") return ok("hc-version", line);
  return warn(
    "hc-version",
    asked.found ? `\`hc --version\` failed (exit ${String(asked.code)})` : "`hc` is not on PATH",
    "install herdr-core so `hc` is on PATH; the bridge itself needs only the socket",
  );
}
