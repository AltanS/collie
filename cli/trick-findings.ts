import { scrubEnv } from "../bridge/tricks/env.ts";
import { tricksConfigDir } from "../bridge/tricks/paths.ts";
import { ok, warn, type Finding } from "./finding.ts";
import { trickListRows, type TrickDeps } from "./trick.ts";

// The doctor's `tricks` row (M94 slice 01, design §7): how many tricks, which are on, each one's state and
// last masked error, and the PATH the runner gives providers, so "darius: not found" on the phone has
// its answer here. A read: the folders, the switch file, and this bridge's own `GET /api/tricks` with
// the local credential. No row at all when there is no tricks folder, so a host that never made a trick
// reads exactly as before.

/** States that mean an ON trick is not drawing what it should. */
const TROUBLE = new Set(["failing", "stopped", "skipped"]);

export async function tricksFindings(deps: Pick<TrickDeps, "ctx" | "files" | "fetch">): Promise<Finding[]> {
  const { exists, rows, bridge, path: bridgePath } = await trickListRows(deps);
  if (!exists) return [];
  const path = bridgePath ?? scrubEnv(deps.ctx.env).PATH ?? "";
  const pathLine = bridgePath === undefined ? `PATH ${path} (as this shell sees it; the service has its own)` : `PATH ${path}`;
  const on = rows.filter((r) => r.on);
  const each = rows.map((r) => `${r.id} ${r.on ? "on" : "off"}, ${r.state}${r.error === null ? "" : `: ${r.error}`}`);
  const summary = `${rows.length} trick${rows.length === 1 ? "" : "s"} in ${tricksConfigDir(deps.ctx.configDir)}, ${on.length} on`;
  const detail = [summary, ...each, pathLine].join("; ");
  const data = { tricks: rows, path, bridge };
  const troubled = on.filter((r) => TROUBLE.has(r.state));
  if (troubled.length > 0) {
    const names = troubled.map((r) => r.id).join(", ");
    return [{ ...warn("tricks", detail, `run \`collie trick check --run <folder>\` for ${names}; a change of its code or config.toml, or a tap, restarts it`), data }];
  }
  return [{ ...ok("tricks", detail), data }];
}
