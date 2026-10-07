import type { FileLinkOpener } from "@/components/file-links";
import { resolveFilePathLink } from "@/lib/file-paths";
import { filesPath } from "@/lib/nav";

/**
 * An opener as the pane screen builds one (ADR 0088), for pane `w1:p1` with its root and cwd at
 * `root` and home at `/home/you`, that records each tap's address in `opened` instead of navigating.
 */
export function testFileOpener(opened: string[], root = "/home/you/webapp"): FileLinkOpener {
  return ({ path, line }) => {
    const rel = resolveFilePathLink({ path, root, cwd: root, home: "/home/you" });
    if (rel === null) return null;
    const href = filesPath("w1:p1", undefined, line === undefined ? { path: rel } : { path: rel, line });
    return { href, onOpen: () => opened.push(href) };
  };
}
