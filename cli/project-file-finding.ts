// `project-file` — the `collie.toml` that speaks for the folder `collie doctor` runs in (ADR 0160).
//
// One row, and none at all when there is no such file and the switch is on, so a machine that never
// met a project file reads exactly as before. The row names the file, the tables and keys this release
// ignored, the values it refused and whether the picture passed its checks: file and key names and
// short reasons only, never a value from the file. A file nobody asked about is not an error, so the
// row warns only when something in the file is refused.

import { envBool } from "../bridge/config.ts";
import type { Environment } from "../bridge/config-source.ts";
import { cleanText } from "../bridge/project-file.ts";
import { ProjectPictures, projectPictureDenied, type ProjectFileReport } from "../bridge/project-picture.ts";
import { ok, warn, type Finding } from "./finding.ts";

const CHECK = "project-file";

/** The row's words for one report. Exported for the test, which drives it without a disk. */
export function projectFileLine(report: ProjectFileReport): Finding | null {
  if (report.file === null) return null;
  // The folder path is the disk's, and a folder name may hold any character: cleaned like a name.
  const parts = [cleanText(report.file, 512)];
  if (report.enclosing !== null) parts.push(`from the enclosing repository ${cleanText(report.enclosing, 512)}, since this repository has no collie.toml`);
  if (report.problem !== null) parts.push(`the file ${report.problem}`);
  if (report.icon !== null) parts.push(report.icon.ok ? `picture ${report.icon.path} passes` : `picture ${report.icon.path} ${report.icon.why ?? "is refused"}`);
  if (report.ignored.length > 0) parts.push(`ignored: ${report.ignored.join(", ")}`);
  if (report.refused.length > 0) parts.push(`refused: ${report.refused.join("; ")}`);
  const detail = parts.join(" · ");
  const fault = report.problem !== null || report.refused.length > 0 || (report.icon !== null && !report.icon.ok);
  return fault ? warn(CHECK, detail, "fix the file, or leave it: Collie shows the agent's own logo instead") : ok(CHECK, detail);
}

/** The finding for `folder`, under this install's switch and private folders. */
export async function projectFileFindings(input: { env: Environment; folder: string; stateDir: string; configDir: string }): Promise<Finding[]> {
  if (!envBool("COLLIE_PROJECT_FILES", true, input.env)) return [ok(CHECK, "off (COLLIE_PROJECT_FILES=0): no repository's collie.toml is read")];
  // The bridge's own list (projectPictureDenied), so doctor and the bridge refuse the same folders.
  const report = await new ProjectPictures(true, projectPictureDenied({ stateDir: input.stateDir, configDir: input.configDir })).report(input.folder);
  const line = projectFileLine(report);
  return line === null ? [] : [line];
}
