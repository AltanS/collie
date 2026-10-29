import { herdrCoreSocketFor } from "../bridge/mux/herdr-core/adapter.ts";
import { bad, ok, warn, type Finding } from "./finding.ts";
import type { Exec, Files } from "./sys.ts";

// THE TWO DOCTOR ROWS FOR AN INSTALL THAT DRIVES herdr-core (M74 spec 02).
//
// They stand where `herdr-socket` and `herdr-version` stand for the Herdr TUI, and those two are
// dropped on such an install (`appliesToMux` in doctor.ts). Both are reads: the socket row looks
// for the file, as `herdr-socket` does, and the version row runs `hc --version`, which starts no
// core. The bridge needs only the socket, so a missing `hc` is a warning and not an error.

export interface HerdrCoreDoctorDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exec: Exec;
  readonly files: Files;
  /** `COLLIE_MUX_ENDPOINT_HERDR_CORE`, trimmed; empty means the core's own default socket. */
  readonly endpoint: string;
}

/** `hc-socket` and `hc-version`. */
export function herdrCoreFindings(deps: HerdrCoreDoctorDeps): Finding[] {
  return [hcSocket(deps), hcVersion(deps)];
}

function hcSocket(deps: HerdrCoreDoctorDeps): Finding {
  const socket = herdrCoreSocketFor(deps.endpoint, deps.env);
  if (deps.files.exists(socket)) return ok("hc-socket", socket);
  return bad(
    "hc-socket",
    `no herdr-core socket at ${socket}, and everything the bridge shows comes through it`,
    "start the core with `hc server start` (or open herdr-app), or name the session with HC_SESSION, then `collie restart`",
  );
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
