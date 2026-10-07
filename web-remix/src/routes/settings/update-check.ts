// The read behind /settings/updates: `GET /api/update/check`, read-gated and side-effect free (it
// starts nothing and takes no upstream look; the preflight behind it is cached on the bridge).
// Kept beside lib/data.ts's shape: the last good body survives a failed read.
import { mounted } from "@web/lib/base-path";
import type { UpdateCheckResponse } from "@web/lib/types";

import { serverBuild } from "../../lib/api";
import { authHeader } from "../../lib/pairing";
import { createStore } from "../../lib/store";
import { updateCheckUrl } from "../../lib/urls";

export interface UpdateCheckState {
  data: UpdateCheckResponse | undefined;
  error: string | undefined;
}

export const updateCheck = createStore<UpdateCheckState>({ data: undefined, error: undefined });

export async function loadUpdateCheck(signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(mounted(updateCheckUrl()), {
      headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", ...authHeader() },
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    const build = res.headers.get("x-collie-build");
    if (build) serverBuild.set(build);
    if (!res.ok) throw new Error(`/api/update/check → ${String(res.status)}`);
    // SAFETY: a 200 on this endpoint is the bridge's UpdateCheckResponse by contract.
    const body = (await res.json()) as UpdateCheckResponse;
    const changed = JSON.stringify(body) !== JSON.stringify(updateCheck.get().data);
    updateCheck.set({ data: body, error: undefined });
    return changed;
  } catch (error) {
    if (signal.aborted) throw error;
    updateCheck.update((prev) => ({ ...prev, error: error instanceof Error ? error.message : "failed" }));
    return false;
  }
}
