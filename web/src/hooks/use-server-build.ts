import { useEffect, useState } from "react";

import { fetchConfig } from "@/lib/api";

/**
 * The build the bridge reports it is serving, for the diagnostics panel beside the local stamp.
 *
 * Best-effort on purpose: it stays `undefined` when the bridge is unreachable, because a
 * diagnostics line that cannot be read is not an error to render on a settings page.
 */
export function useServerBuild(): string | undefined {
  const [build, setBuild] = useState<string | undefined>();
  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then((c) => alive && setBuild(c.build))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return build;
}
