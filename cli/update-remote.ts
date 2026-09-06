import { gitArgs, parseGithubRemote } from "./install-kind.ts";
import type { Exec } from "./sys.ts";

/**
 * Public GitHub release reads must not depend on the service's SSH config or agent. Merely using
 * `https://` is insufficient: `url.git@github.com:.insteadOf=https://github.com/` rewrites it back
 * to SSH. Git's explicit `<transport>::<address>` syntax selects the HTTPS helper without that
 * prefix matching. The helper receives the ordinary HTTPS URL, retaining HTTP proxy and TLS config.
 * This is per-call: no saved remote, rewrite rule or push URL changes. Mirrors stay operator-owned.
 */
export function anonymousTagUrl(url: string): string {
  const raw = url.trim();
  const repo = parseGithubRemote(raw);
  return repo === null ? raw : `https::https://github.com/${repo}.git`;
}

/** Shared by preflight, managed updates and staged updates; the origin guard still runs first. */
export function tagRemote(exec: Exec, root: string): string {
  const r = exec.capture("git", gitArgs(root, ["remote", "get-url", "origin"]));
  const url = r.found && r.code === 0 ? r.stdout.trim() : "";
  const remote = anonymousTagUrl(url);
  // A mirror keeps its named-remote settings (proxy, upload-pack, etc.), not just its URL.
  return remote === url ? "origin" : remote;
}
