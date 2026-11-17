// The chaos leg's global setup on the solo rig: `rig.ts up --second-bridge`, the lead's bridge and a second
// one on the same Herdr (case C3), each with its own paired device. Everything else is the solo leg's setup.
import { startRun } from "./global-setup";

export default async function chaosSetup(): Promise<void> {
  await startRun(false, ["--second-bridge"]);
}
