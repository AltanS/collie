import { join } from "node:path";

// Where mods live on disk (M94, Collie mods, slice 01). Two folders, one per side of the line:
//
//   * `<configDir>/mods/<id>/` holds a mod: its `mod.toml` and its provider. The operator's code,
//     beside the other operator files, and per instance like them. Collie never writes here except
//     `collie mod init`, which makes a new folder and refuses an existing one.
//   * `<stateDir>/mods/` holds what the bridge keeps about mods: `switches.json` (which mods are on)
//     and one `<id>/` per mod that has run, handed to the provider as its own state folder.
//
// The state folder is created only when a switch is written or a mod runs, so an install with no
// mods writes no file (solo-baseline.test.ts).

/** The folder name, in the config folder and in the state folder alike. */
export const MODS_DIR = "mods";

/** The switch file inside `<stateDir>/mods/`. */
export const SWITCHES_FILE = "switches.json";

/** The manifest file inside a mod folder. */
export const MANIFEST_FILE = "mod.toml";

/** `<configDir>/mods`: where the mod folders are. */
export function modsConfigDir(configDir: string): string {
  return join(configDir, MODS_DIR);
}

/** `<stateDir>/mods`: what the bridge keeps about mods. */
export function modsStateDir(stateDir: string): string {
  return join(stateDir, MODS_DIR);
}

/** `<stateDir>/mods/switches.json`. */
export function switchesPath(stateDir: string): string {
  return join(modsStateDir(stateDir), SWITCHES_FILE);
}

/** `<stateDir>/mods/<id>`: the provider's own state folder, `mod.state` in the facts. */
export function modStateDir(stateDir: string, id: string): string {
  return join(modsStateDir(stateDir), id);
}
