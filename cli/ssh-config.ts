// `~/.ssh/config` AS A LIST OF CANDIDATE HOSTS — the first of `crew add`'s two providers (M22/07).
//
// ── IT READS, AND THAT IS THE WHOLE OF IT ────────────────────────────────────
// Collie never touches your ssh configuration (`cli/remote.ts` says it to the operator, ADR 0015).
// Nothing here writes, renames, chmods or creates a file, and nothing here re-implements ssh's
// resolution: a candidate is offered as the ALIAS THE OPERATOR WROTE, which is exactly what
// `bridge/crew/ops-store.ts` already stores as a destination. Resolution is a separate step, done by
// asking ssh itself (`cli/candidates.ts`), and it never happens here.
//
// ── NOT AN ADAPTER PROVIDER ──────────────────────────────────────────────────
// This needs no multiplexer at all, so it is not on `MuxAdapterFactory` — it belongs with the CLI's
// own file seam (`cli/crew.ts`'s `Files`), which is why no test in this suite reads a real
// `~/.ssh/config`. It is listed FIRST, ahead of any adapter provider, because it is the list the
// operator maintains by hand and therefore the spelling they recognise.
//
// ── WHAT IS DROPPED, AND WHY ─────────────────────────────────────────────────
// A pattern is not a machine. `Host *`, `Host *.internal` and `Host !gateway` describe SETS of hosts
// that ssh matches a name against; none of them is a name that can be handed to `crew add`. So a
// token carrying a wildcard, and a negation, are dropped rather than offered — offering `*` would
// put a candidate on the list that cannot be enrolled.

import type { HostCandidate } from "../bridge/mux/host-candidates.ts";
import type { Files } from "./sys.ts";

/** The two file operations this module performs, and it performs no others. */
export type SshConfigFiles = Pick<Files, "read" | "list">;

/** How deep {@link sshConfigCandidates} follows an `Include`. One level, and this is the number. */
const INCLUDE_DEPTH = 1;

/** `~/.ssh` — the directory an `Include` must resolve inside, and the config's own home. */
function sshDir(home: string): string {
  return `${home}/.ssh`;
}

/**
 * The operator's ssh aliases, in file order, as candidates.
 *
 * `home` is the resolved home directory (`CliContext.home`), never `$HOME` read here: a verb that
 * re-read the environment would disagree with every other path this CLI composes.
 */
export function sshConfigCandidates(files: SshConfigFiles, home: string): readonly HostCandidate[] {
  const seen = new Set<string>();
  const out: HostCandidate[] = [];
  for (const alias of sshConfigAliases(files, `${sshDir(home)}/config`, home, 0)) {
    if (seen.has(alias)) continue;
    seen.add(alias);
    // No label and no id: an ssh config alias IS the name, and inventing a second one from a
    // `HostName` line would be this module resolving, which is not its job.
    out.push({ target: alias, label: null, id: null });
  }
  return out;
}

/**
 * Every `Host` token one config file declares, plus those of the files it `Include`s.
 *
 * `depth` is the recursion guard and the policy in one value: {@link INCLUDE_DEPTH} is the last
 * depth that may follow an include, so an included file's own includes are simply not read. That is
 * a deliberate stop, not a limitation to lift — an ssh config can include a tree, and a picker that
 * walked one would spend an operator's patience on files they did not know were in play. An operator
 * whose alias sits deeper than one level types the name, exactly as they do today.
 */
function sshConfigAliases(files: SshConfigFiles, path: string, home: string, depth: number): readonly string[] {
  const raw = files.read(path);
  if (raw === null) return [];
  const aliases: string[] = [];
  for (const line of raw.split("\n")) {
    const directive = readDirective(line);
    if (directive === null) continue;
    const [keyword, values] = directive;
    if (keyword === "host") {
      for (const token of values) {
        if (!offerable(token)) continue;
        aliases.push(token);
      }
      continue;
    }
    if (keyword !== "include" || depth >= INCLUDE_DEPTH) continue;
    for (const pattern of values) {
      for (const included of resolveInclude(files, pattern, home)) {
        aliases.push(...sshConfigAliases(files, included, home, depth + 1));
      }
    }
  }
  return aliases;
}

/**
 * One config line as `[keyword, values]`, or `null` for a blank or a comment.
 *
 * ssh's own grammar: the keyword is case-insensitive, and it is separated from its arguments by
 * whitespace, or by `=` with optional whitespace around it. Both spellings are in the wild and
 * `Host=attic` is a valid entry, so both are read.
 */
function readDirective(line: string): readonly [string, readonly string[]] | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const match = /^([A-Za-z][A-Za-z0-9-]*)(?:\s*=\s*|\s+)(.*)$/u.exec(trimmed);
  if (match === null) return null;
  const values = match[2]!.trim().split(/\s+/u).filter((v) => v !== "");
  if (values.length === 0) return null;
  return [match[1]!.toLowerCase(), values];
}

/** Is this `Host` token a name that could be handed to `crew add`? Patterns and negations are not. */
function offerable(token: string): boolean {
  if (token.startsWith("!")) return false;
  return !token.includes("*") && !token.includes("?");
}

/**
 * The files one `Include` pattern names, or none.
 *
 * Three rules, and the middle one is the containment: a relative pattern is resolved against
 * `~/.ssh` (ssh's own rule for a user config), a `~/` pattern against `home`, and an absolute one
 * stands — and then the RESULT must sit under `~/.ssh/`. A path that resolves anywhere else is
 * skipped in silence. This is a picker reading files nobody asked it to read, so the boundary is the
 * directory the operator's ssh configuration already lives in and nothing wider; an `Include
 * /etc/ssh/…` or an `Include ../../notes` is simply not followed, and the operator can still type
 * the host.
 *
 * A glob is allowed, because `Include config.d/*` is how the directive is normally used. It is
 * matched against ONE directory's entries — `files.list` on the pattern's parent — so no walk
 * happens and a `**` buys nothing.
 */
function resolveInclude(files: SshConfigFiles, pattern: string, home: string): readonly string[] {
  const normalised = normalise(absoluteInclude(pattern, home));
  const boundary = `${normalise(sshDir(home))}/`;
  if (!normalised.startsWith(boundary)) return [];
  const cut = normalised.lastIndexOf("/");
  const parent = normalised.slice(0, cut);
  const base = normalised.slice(cut + 1);
  if (!base.includes("*") && !base.includes("?")) return [normalised];
  // A glob in a directory component is not expanded: only the final component is matched, which is
  // the shape `Include` is used in, and the shape that needs no directory walk.
  if (parent.includes("*") || parent.includes("?")) return [];
  const matcher = globToRegExp(base);
  const matched = files.list(parent).filter((entry) => matcher.test(entry));
  return matched.toSorted().map((entry) => `${parent}/${entry}`);
}

/** Where one `Include` pattern points before containment is judged. ssh's own three spellings. */
function absoluteInclude(pattern: string, home: string): string {
  if (pattern.startsWith("~/")) return `${home}/${pattern.slice(2)}`;
  if (pattern.startsWith("/")) return pattern;
  return `${sshDir(home)}/${pattern}`;
}

/** Collapse `.` and `..` and duplicate slashes, textually. No filesystem is touched. */
function normalise(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** `*` and `?` as a shell glob does, over one path component. Everything else is a literal. */
function globToRegExp(glob: string): RegExp {
  const source = glob.replaceAll(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]");
  return new RegExp(`^${source}$`, "u");
}
