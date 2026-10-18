// The crew leg's global setup: `rig.ts up --crew`, the lead and its member, then one paired phone.
import "./crew-env";

import { startRun } from "./global-setup";

export default async function crewSetup(): Promise<void> {
  await startRun(true);
}
