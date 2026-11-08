import { scrubEnv } from "../bridge/mods/env.ts";
import { modsConfigDir } from "../bridge/mods/paths.ts";
import { ok, warn, type Finding } from "./finding.ts";
import { modListRows, type ModDeps } from "./mod.ts";

// The doctor's `mods` row (M94 slice 01, design §7): how many mods, which are on, each one's state and
// last masked error, and the PATH the runner gives providers, so "darius: not found" on the phone has
// its answer here. A read: the folders, the switch file, and this bridge's own `GET /api/mods` with
// the local credential. No row at all when there is no mods folder, so a host that never made a mod
// reads exactly as before.

/** States that mean an ON mod is not drawing what it should. */
const TROUBLE = new Set(["failing", "stopped", "skipped"]);

export async function modsFindings(deps: Pick<ModDeps, "ctx" | "files" | "fetch">): Promise<Finding[]> {
  const { exists, rows, bridge, path: bridgePath } = await modListRows(deps);
  if (!exists) return [];
  const path = bridgePath ?? scrubEnv(deps.ctx.env, deps.ctx.configDir).PATH ?? "";
  const pathLine = bridgePath === undefined ? `PATH ${path} (as this shell sees it; the service has its own)` : `PATH ${path}`;
  const on = rows.filter((r) => r.on);
  const each = rows.map((r) => `${r.id} ${r.on ? "on" : "off"}, ${r.state}${r.error === null ? "" : `: ${r.error}`}`);
  const summary = `${rows.length} mod${rows.length === 1 ? "" : "s"} in ${modsConfigDir(deps.ctx.configDir)}, ${on.length} on`;
  const detail = [summary, ...each, pathLine].join("; ");
  const data = { mods: rows, path, bridge };
  const troubled = on.filter((r) => TROUBLE.has(r.state));
  if (troubled.length > 0) {
    const names = troubled.map((r) => r.id).join(", ");
    return [{ ...warn("mods", detail, `run \`collie mod check --run <folder>\` for ${names}; a change in the folder restarts it`), data }];
  }
  return [{ ...ok("mods", detail), data }];
}
