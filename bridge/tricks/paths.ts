import { join } from "node:path";

// Where tricks live on disk (M94, Collie tricks, slice 01). Two folders, one per side of the line:
//
//   * `<configDir>/tricks/<id>/` holds a trick: its `trick.toml` and its provider. The operator's code,
//     beside the other operator files, and per instance like them. Collie never writes here except
//     `collie trick init`, which makes a new folder and refuses an existing one.
//   * `<stateDir>/tricks/` holds what the bridge keeps about tricks: `switches.json` (which tricks are on)
//     and one `<id>/` per trick that has run, handed to the provider as its own state folder.
//
// The state folder is created only when a switch is written or a trick runs, so an install with no
// tricks writes no file (solo-baseline.test.ts).

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

/** `<stateDir>/tricks/<id>`: the provider's own state folder, `trick.state` in the facts. */
export function trickStateDir(stateDir: string, id: string): string {
  return join(tricksStateDir(stateDir), id);
}
