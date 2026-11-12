import { join } from "node:path";

// Where tricks live on disk (M94, Collie tricks, slice 01). Two folders, one per side of the line:
//
//   * `<configDir>/tricks/<id>/` holds a trick: its `trick.toml` and its program. The operator's code,
//     beside the other operator files, and per instance like them. Collie writes a trick folder only in
//     `collie trick init`, which makes a new folder and refuses an existing one, and in `collie trick add`.
//     Beside the trick folders sit two folders of copies (approved.ts): `.collie-approved/<id>/<hash16>/`,
//     the approved copy that runs, and `.collie-pending/<id>/<hash16>/`, a snapshot of a changed folder
//     that waits for a person's yes. Their names start with a dot, which a trick id never does
//     (`isTrickId`) and the scan skips (discover.ts), so neither is ever taken for a trick.
//     WHY NOT THE STATE FOLDER: the copy is where the program runs, so a Decision's pictures are read
//     from it, and the hill refuses every picture inside the state folder, a trick's root there included
//     (bridge/hill/media.ts, "A TRICK'S OWN FOLDER"). Under the config folder a copy is one trick's root,
//     exactly as the trick folder is, and the hill's guard stays as it is.
//   * `<stateDir>/tricks/` holds what the bridge keeps about tricks: `switches.json` (which tricks are on,
//     each with the code hash approved), `receipts.json` (one receipt per tap that ran), and one `<id>/`
//     per trick that has run, handed to the program as its own state folder.
//
// The state folder is created only when a switch is written, a trick runs or a tap is answered, so an
// install with no tricks writes no file (solo-baseline.test.ts).

/** The folder name, in the config folder and in the state folder alike. */
export const TRICKS_DIR = "tricks";

/** The switch file inside `<stateDir>/tricks/`. */
export const SWITCHES_FILE = "switches.json";

/** The manifest file inside a trick folder. */
export const MANIFEST_FILE = "trick.toml";

/** `<configDir>/tricks`: where the trick folders are. */
export function tricksConfigDir(configDir: string): string {
  return join(configDir, TRICKS_DIR);
}

/** `<stateDir>/tricks`: what the bridge keeps about tricks. */
export function tricksStateDir(stateDir: string): string {
  return join(stateDir, TRICKS_DIR);
}

/** `<stateDir>/tricks/switches.json`. */
export function switchesPath(stateDir: string): string {
  return join(tricksStateDir(stateDir), SWITCHES_FILE);
}

/** `<stateDir>/tricks/<id>`: the program's own state folder, `trick.state` in the facts. */
export function trickStateDir(stateDir: string, id: string): string {
  return join(tricksStateDir(stateDir), id);
}

/** The folder of approved copies inside `<configDir>/tricks/`. The dot keeps it apart from every trick id. */
export const APPROVED_DIR = ".collie-approved";
/** The folder of pending snapshots inside `<configDir>/tricks/`. */
export const PENDING_DIR = ".collie-pending";

/** The short form of a code hash a copy's folder is named by: its first 16 hex characters. */
export function hash16(hash: string): string {
  return hash.slice(0, 16);
}

/** `<configDir>/tricks/.collie-approved/<id>`: every approved copy of one trick. */
export function approvedTrickDir(configDir: string, id: string): string {
  return join(tricksConfigDir(configDir), APPROVED_DIR, id);
}

/** `<configDir>/tricks/.collie-approved/<id>/<hash16>`: the approved copy of one version, the one that runs. */
export function approvedCopyDir(configDir: string, id: string, hash: string): string {
  return join(approvedTrickDir(configDir, id), hash16(hash));
}

/** `<configDir>/tricks/.collie-pending/<id>`: the pending snapshots of one trick. */
export function pendingTrickDir(configDir: string, id: string): string {
  return join(tricksConfigDir(configDir), PENDING_DIR, id);
}

/** `<configDir>/tricks/.collie-pending/<id>/<hash16>`: the snapshot of a changed folder, waiting for a yes. */
export function pendingCopyDir(configDir: string, id: string, hash: string): string {
  return join(pendingTrickDir(configDir, id), hash16(hash));
}
