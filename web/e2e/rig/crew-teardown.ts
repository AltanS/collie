// The crew leg's global teardown: the crew table (cases 12 to 15 and 19 to 21), then `rig.ts down --crew`.
import "./crew-env";

import { finishRun } from "./global-teardown";

export default async function crewTeardown(): Promise<void> {
  await finishRun("crew");
}
