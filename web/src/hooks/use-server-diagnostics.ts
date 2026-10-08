import { useEffect, useState } from "react";

import { fetchConfig } from "@/lib/api";

/** What the diagnostics panel reads off `/api/config`. Each field is `undefined` until known. */
export interface ServerDiagnostics {
  /** The build the bridge reports it is serving. */
  build: string | undefined;
  /** Whether the bridge masks secret shapes (`COLLIE_REDACT`). Also `undefined` for an older bridge. */
  redact: boolean | undefined;
}

/**
 * The facts the bridge reports about itself, for the diagnostics panel beside the local stamp: the
 * build it is serving and whether it masks secrets. ONE read of `/api/config` feeds both, so the
 * System page does not fetch the same body twice.
 *
 * Best-effort on purpose: both stay `undefined` when the bridge is unreachable, because a
 * diagnostics line that cannot be read is not an error to render on a settings page.
 */
export function useServerDiagnostics(): ServerDiagnostics {
  const [facts, setFacts] = useState<ServerDiagnostics>({ build: undefined, redact: undefined });
  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then((c) => alive && setFacts({ build: c.build, redact: c.redact }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return facts;
}
