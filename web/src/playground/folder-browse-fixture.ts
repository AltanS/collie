// The disk the Browse row reads in the design reference and in the pick pages: a small tree under one home.
import type { FolderBrowse } from "@/components/new-space-browse";
import type { FolderBrowseResponse } from "@/lib/types";

export const BROWSE_HOME = "/home/op";
/** A small disk for the card: each folder's sub-folders, `*` marking a repository. */
const BROWSE_TREE = new Map<string, readonly string[]>([
  [BROWSE_HOME, ["docs", "src", "notes"]],
  [`${BROWSE_HOME}/docs`, []],
  [`${BROWSE_HOME}/notes`, []],
  [`${BROWSE_HOME}/src`, ["*collie", "*plektra-api", "plektra-web", "*website"]],
  [`${BROWSE_HOME}/src/collie`, []],
  [`${BROWSE_HOME}/src/plektra-api`, []],
  [`${BROWSE_HOME}/src/plektra-web`, []],
  [`${BROWSE_HOME}/src/website`, []],
]);

/**
 * The bridge's walk over {@link BROWSE_TREE}: the text resolved under home, the nearest folder that
 * exists, the rest as a case-insensitive name filter. Outside home is the bridge's `unknown-path`.
 */
export const browseFixture: NonNullable<Parameters<typeof FolderBrowse>[0]["read"]> = (text) => {
  const raw = text.trim();
  const abs = (raw === "" || raw === "~" ? BROWSE_HOME : raw.startsWith("~/") ? `${BROWSE_HOME}/${raw.slice(2)}` : raw.startsWith("/") ? raw : `${BROWSE_HOME}/${raw}`).replace(/\/+$/u, "");
  if (abs !== BROWSE_HOME && !abs.startsWith(`${BROWSE_HOME}/`)) return Promise.resolve({ outcome: "unknown-path" });
  const parts = abs.slice(BROWSE_HOME.length).split("/").filter(Boolean);
  for (let depth = parts.length; depth >= 0; depth--) {
    const path = [BROWSE_HOME, ...parts.slice(0, depth)].join("/");
    const subs = BROWSE_TREE.get(path);
    if (subs === undefined) continue;
    const filter = parts.slice(depth).join("/");
    const folders = subs
      .map((s) => ({ name: s.replace(/^\*/u, ""), git: s.startsWith("*") }))
      .filter((f) => f.name.toLowerCase().startsWith(filter.toLowerCase()));
    const parent = depth === 0 ? null : [BROWSE_HOME, ...parts.slice(0, depth - 1)].join("/");
    const body: FolderBrowseResponse = { path, parent, folders, filter, truncated: false };
    return Promise.resolve({ outcome: "body", body });
  }
  return Promise.resolve({ outcome: "unknown-path" });
};
