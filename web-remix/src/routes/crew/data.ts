// `GET /api/crew`, the census, as a store the polling scheduler writes (web/'s `crewLoader`). Only a
// LEAD serves it: a solo collie and a peer answer 404, and that refusal is the truthful answer "there
// is no crew here", so it folds to `status: null, error: false`. Every other refusal sets `error`,
// because "I could not ask" and "there is nothing to ask about" are different sentences. A failed
// read keeps the last good census beside the flag, so a bad tick shows a stale formation, not a hole.
import type { CrewStatusResponse } from "@web/lib/types";

import { ApiError, bridgeGet, isAbort } from "../../lib/api";
import { createStore } from "../../lib/store";
import { crewUrl } from "../../lib/urls";

export interface CrewData {
  /** The census, or `null` when this collie leads no crew (404) or nothing has landed. */
  status: CrewStatusResponse | null;
  /** The last read FAILED. A 404 is an answer, not an error. */
  error: boolean;
  /** False until the first answer or failure lands: a skeleton shows until then, never the solo card. */
  loaded: boolean;
}

export const crew = createStore<CrewData>(
  { status: null, error: false, loaded: false },
  (a, b) => a.status === b.status && a.error === b.error && a.loaded === b.loaded,
);

export async function loadCrew(signal: AbortSignal): Promise<boolean> {
  try {
    const status = await bridgeGet<CrewStatusResponse>(crewUrl(), undefined, signal);
    const changed = JSON.stringify(status) !== JSON.stringify(crew.get().status);
    crew.set({ status: changed ? status : (crew.get().status ?? status), error: false, loaded: true });
    return changed;
  } catch (error) {
    if (error instanceof Error && isAbort(error)) throw error;
    if (error instanceof ApiError && error.status === 404) {
      crew.set({ status: null, error: false, loaded: true });
      return false;
    }
    crew.update((prev) => ({ ...prev, error: true, loaded: true }));
    return false;
  }
}

export const CREW_SOURCE = { key: "crew", poll: loadCrew };
