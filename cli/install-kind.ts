import { basename, dirname, join, resolve } from "node:path";

import type { CliContext } from "./context.ts";
import type { LinkReader } from "./link.ts";
import type { Exec, Files } from "./sys.ts";
import { collieBinary } from "./unit.ts";

// HOW THIS COLLIE GOT HERE, and where its updates come from — the two questions `update` and
// `doctor` must answer the same way, so they are answered once, here.
//
// The detection is STRUCTURAL: no marker file is WRITTEN by anything, and none is read as the
// primary signal. Every kind is decided from shapes that already exist on disk — a git dir, a
// `versions/<X.Y.Z>` parent with a `current` symlink beside it, a root that is read-only, outside
// `$HOME` or owned by uid 0 — because a marker is a fact that can be copied, stale or absent while
// the tree around it says otherwise (M14/01 §4.2).
//
// ONE kind does read the marker as part of its predicate, and the amendment is deliberate:
// `packaged` requires `herdr-plugin.toml` at the root. That file is not written by an installer —
// it ships INSIDE the release tarball every package wraps — so it is still a shape on disk rather
// than a flag somebody set, and it is what separates a Collie we cannot name from a directory that
// is not a Collie at all (ADR 0035).
//
// One canonical root: `CliContext.root`, which is `bridge/root.ts`'s `pluginRoot()` and nothing
// else. A binary install's root is `<install-root>/versions/X.Y.Z` — the version directory the
// running process was launched from, never the `current` symlink — because `process.execPath` is
// realpath-resolved. The install root above it is derived only after the binary kind is confirmed.

const gitArgsOf = (root: string, args: readonly string[]): string[] => ["-C", root, ...args];

/** `git -C <root> <args…>` — the one spelling every predicate here and in `update` uses. */
export const gitArgs = gitArgsOf;

/**
 * True when the checkout has no branch — exactly how `herdr plugin install` leaves it.
 *
 * ONE predicate decides how the checkout advances (`updateCheckout`), whether it is re-linked
 * (`refreshRegistry`) and, since M14, which install kind it is ({@link classifyInstall}). Three
 * consumers, one answer: two detections would eventually disagree, and the disagreement would be
 * silent — an install that advances correctly and then re-registers itself as `local`, after which
 * Herdr refuses `plugin install` and the operator has no way back (ADR 0006).
 */
export function isManagedCheckout(exec: Exec, root: string): boolean {
  const r = exec.capture("git", gitArgsOf(root, ["symbolic-ref", "-q", "HEAD"]));
  return !r.found || r.code !== 0;
}

export function isGitCheckout(exec: Exec, root: string): boolean {
  const r = exec.capture("git", gitArgsOf(root, ["rev-parse", "--git-dir"]));
  return r.found && r.code === 0;
}

// ── The pure core ────────────────────────────────────────────────────────────

/** The probed facts {@link classifyInstall} decides from. Nothing here is an opinion. */
export interface InstallProbe {
  readonly isGitCheckout: boolean;
  /** Only meaningful when {@link isGitCheckout} — a detached HEAD is the Herdr-managed shape. */
  readonly isDetached: boolean;
  /** `basename(dirname(root)) === "versions"`. */
  readonly parentIsVersions: boolean;
  readonly currentIsSymlink: boolean;
  /** `current` resolves to something under the same `versions/` directory. */
  readonly currentResolvesHere: boolean;
  /**
   * `herdr-plugin.toml` sits at the root. Not a marker the installer writes — it is the manifest
   * Herdr reads and `bridge/root.ts` already requires — and it separates a Collie we cannot name
   * from a directory that is not a Collie at all.
   */
  readonly hasMarker: boolean;
  /**
   * Who owns the root — the uid off `stat(2)`, or null when it could not be read.
   *
   * OWNERSHIP, never writability. `access(root, W_OK)` is true for uid 0, so a writability probe
   * makes `collie update` and `sudo collie update` disagree about what kind of install this is, and
   * hides a packaged tree completely from a bridge running as root. Ownership is a fact about
   * the tree rather than about who asked, so every caller reads the same answer.
   *
   * Consulted LAST and only where nothing else claimed the tree, because it is the weakest signal
   * here: a checkout or a `versions/` layout means what it means whoever owns it.
   */
  readonly rootOwnerUid: number | null;
  /**
   * The root refuses this process's writes — an `access(root, W_OK)` style probe through
   * {@link Files.writable}.
   *
   * FALSE when it cannot be answered, which is the open direction: a probe that reached nothing has
   * seen no evidence that a package manager owns this tree, and the other two disjuncts are still
   * free to claim it. This is the Nix store's fact.
   */
  readonly rootIsReadOnly: boolean;
  /** `!root.startsWith(ctx.home + "/")` — the root sits outside the operator's home. Homebrew's fact. */
  readonly rootOutsideHome: boolean;
}

export type InstallKind =
  | { readonly kind: "linked-clone"; readonly alsoLayout: boolean }
  | { readonly kind: "detached-checkout"; readonly alsoLayout: boolean }
  | { readonly kind: "binary" }
  /**
   * A package manager owns this folder. Collie reads it, serves from it and reports its version,
   * and never updates it in place (ADR 0035).
   *
   * Not a checkout, not a `versions/` layout, carrying the manifest the release payload ships, and
   * sitting in a tree the operator does not administer — read-only, outside `$HOME`, or owned by
   * root. Each of those three is on its own enough evidence; see {@link classifyInstall}.
   */
  | { readonly kind: "packaged" }
  | { readonly kind: "unknown"; readonly why: "no-marker" | "orphan-layout" | "loose-binary" };

/**
 * The five kinds, decided from the probe alone — pure, so `bun test` covers the whole truth table
 * with no filesystem, matching how `planUpdate` and `classifyLink` are already tested.
 *
 * **The degenerate both-signals case: git wins.** A clone placed at `<root>/versions/1.1.0` reports
 * `linked-clone`/`detached-checkout` with `alsoLayout: true`. A `.git` means a human put a working
 * tree there, and the binary path renames a version directory into `.trash/` — doing that to a
 * working tree with uncommitted work is unrecoverable. `update` takes the git path; `doctor` prints
 * the ambiguity rather than hiding it.
 */
export function classifyInstall(p: InstallProbe): InstallKind {
  const alsoLayout = p.parentIsVersions && p.currentIsSymlink && p.currentResolvesHere;
  if (p.isGitCheckout) {
    return p.isDetached ? { kind: "detached-checkout", alsoLayout } : { kind: "linked-clone", alsoLayout };
  }
  if (p.parentIsVersions) {
    if (p.currentIsSymlink && p.currentResolvesHere) return { kind: "binary" };
    // A half-finished manual copy: the layout is there and the one thing that makes it navigable is
    // not. Guessing here would flip a symlink nobody published.
    return { kind: "unknown", why: "orphan-layout" };
  }
  if (!p.hasMarker) return { kind: "unknown", why: "no-marker" };
  // CLAUSE 4, and it is a DISJUNCTION of three probed facts. Nothing above claimed the tree, and
  // there IS a Collie here. Any one of these three means the folder is administered by something
  // other than the operator, and each covers a real packager the other two miss:
  //
  //   read-only  — the Nix store, which is mounted read-only and would answer nothing else;
  //   outside $HOME — Homebrew's prefix, which the operator CAN write and still does not own;
  //   owned by root — a tree unpacked as root inside `$HOME`, and the same tree probed as root,
  //                   where `access(2)` lies because it is always true for uid 0.
  //
  // Asked last, and only in this branch, on purpose. All three are weaker signals than layout: a
  // `.git` or a `versions/` parent still means what it means in a root-owned or read-only tree, and
  // reading them earlier would reclassify a perfectly ordinary install the moment someone chowned it.
  //
  // A writable, user-owned tree inside `$HOME` stays `loose-binary`. That is the closed direction:
  // Collie declines to update what it cannot describe rather than claiming a package manager that
  // may not exist.
  //
  // NO PATH PREFIX IS EVIDENCE HERE. This module spells none. Every prefix Collie recognises lives
  // in `package-command.ts`, and is read only to NAME a command once the kind is already decided
  // (M17 principle 3).
  const notOurs = p.rootIsReadOnly || p.rootOutsideHome || p.rootOwnerUid === 0;
  return notOurs ? { kind: "packaged" } : { kind: "unknown", why: "loose-binary" };
}

/**
 * What a packaged install is told, in ONE place — the preflight's `package` check, `collie update`'s
 * refusal, `doctor`'s install line and the crew skip all print this sentence.
 *
 * It asserts a boundary and no more. Which manager owns the folder is a separate question, answered
 * by `packageCommand` in `package-command.ts` where the prefix answers it, and left unanswered
 * where it does not.
 */
export const PACKAGED_SENTENCE = "updates come from your package manager";

// ── The probe, and what a binary install's paths are ─────────────────────────

/** The paths of a binary install, all derived from the version directory the process runs from. */
export interface BinaryLayout {
  /** `<install-root>` — the directory holding `versions/`, `current`, `.staging` and `.trash`. */
  readonly installRoot: string;
  readonly versionsDir: string;
  /** The `current` symlink itself, never its target. */
  readonly currentLink: string;
  readonly stagingDir: string;
  readonly trashDir: string;
  /** The version directory name the running process was launched from (`1.1.0`). */
  readonly version: string;
}

export function binaryLayout(root: string): BinaryLayout {
  const versionsDir = dirname(root);
  const installRoot = dirname(versionsDir);
  return {
    installRoot,
    versionsDir,
    currentLink: join(installRoot, "current"),
    stagingDir: join(installRoot, ".staging"),
    trashDir: join(installRoot, ".trash"),
    version: basename(root),
  };
}

/**
 * The binary the PATH name must point at for an install rooted at `root`.
 *
 * ADR 0021's rule is that the name is a POINTER, never a copy — so on a binary install it points one
 * level up from the version: at `<install-root>/current/bin/collie`, the same symlink `update` flips.
 * That is what makes `~/.local/bin/collie` survive every version flip with nothing to refresh, and it
 * is why `link`, `unlink` and `doctor` all ask THIS function rather than spelling a path: three
 * answers would disagree the first time a version changed.
 *
 * Structural and git-free — only the layout decides, so a checkout keeps pointing at its own
 * `bin/collie` exactly as before.
 */
export function publishedBinary(root: string, link: LinkReader): string {
  const layout = binaryLayout(root);
  if (basename(layout.versionsDir) !== "versions") return collieBinary(root);
  const probe = link.probe(layout.currentLink);
  if (probe.kind !== "symlink") return collieBinary(root);
  const target = resolve(layout.installRoot, probe.target);
  const inLayout = target === layout.versionsDir || target.startsWith(`${layout.versionsDir}/`);
  return inLayout ? join(layout.currentLink, "bin", "collie") : collieBinary(root);
}

/** What the world says about `root` — one `git` call, one `lstat`, one `readlink`. All reads. */
export function probeInstall(
  deps: { readonly ctx: Pick<CliContext, "home">; readonly exec: Exec; readonly files: Files; readonly link: LinkReader },
  root: string,
): InstallProbe {
  const git = isGitCheckout(deps.exec, root);
  const layout = binaryLayout(root);
  const probe = deps.link.probe(layout.currentLink);
  const target = probe.kind === "symlink" ? resolve(layout.installRoot, probe.target) : null;
  return {
    isGitCheckout: git,
    isDetached: git && isManagedCheckout(deps.exec, root),
    parentIsVersions: basename(layout.versionsDir) === "versions",
    currentIsSymlink: probe.kind === "symlink",
    currentResolvesHere:
      target !== null && (target === layout.versionsDir || target.startsWith(`${layout.versionsDir}/`)),
    hasMarker: deps.files.exists(join(root, "herdr-plugin.toml")),
    rootOwnerUid: deps.files.ownerUid(root),
    // `null` — the probe could not reach the question — is NOT read-only. See the field's comment.
    rootIsReadOnly: deps.files.writable(root) === false,
    rootOutsideHome: !root.startsWith(`${deps.ctx.home}/`),
  };
}

/** {@link classifyInstall} over {@link probeInstall} — the one call a verb makes. */
export function detectInstall(deps: {
  readonly ctx: CliContext;
  readonly exec: Exec;
  readonly files: Files;
  readonly link: LinkReader;
}): InstallKind {
  return classifyInstall(probeInstall(deps, deps.ctx.root));
}

// ── Where updates come from ──────────────────────────────────────────────────
// ONE override, read in ONE place. `COLLIE_UPDATE_REPO` used to move only the bridge's update
// banner, which meant a fork's banner pointed at the fork while `update` still fetched — and
// force-checked-out onto — whatever `origin` happened to be. It is now the single source for both:
// the SOURCE on a binary install (it selects the tags endpoint and every constructed download URL)
// and an ASSERTION on the git paths (M14/01 §3.5, M14/02 amendment §1–2).

export const DEFAULT_UPDATE_REPO = "AltanS/collie";

/** The `owner/repo` releases come from — `COLLIE_UPDATE_REPO`, or Collie's own repo. */
export function updateRepoOf(env: { readonly COLLIE_UPDATE_REPO?: string | undefined }): string {
  return env.COLLIE_UPDATE_REPO?.trim() || DEFAULT_UPDATE_REPO;
}

/**
 * A git remote URL → `owner/repo`, or null when it names no GitHub repository. All three spellings
 * git hands out are accepted (`https://`, `git@host:owner/repo`, `ssh://git@host/owner/repo`), a
 * trailing `.git` and trailing slashes are stripped, and the host is compared case-insensitively —
 * but only `github.com` parses, because the value it is compared against is a GitHub `owner/repo`.
 */
export function parseGithubRemote(url: string): string | null {
  const raw = url.trim();
  if (raw === "") return null;
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw);
  const withoutScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)
    ? raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").replace(/^[^@/]+@/, "")
    : scp !== null
      ? `${scp[1]}/${scp[2]}`
      : null;
  if (withoutScheme === null) return null;
  const [host, ...rest] = withoutScheme.split("/");
  if (host === undefined || host.toLowerCase().replace(/^www\./, "") !== "github.com") return null;
  const path = rest.join("/").replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = path.split("/").filter((s) => s !== "");
  if (parts.length !== 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

/** What `origin` says this checkout came from, as `owner/repo` — or why we cannot say. */
export type OriginVerdict =
  | { readonly kind: "repo"; readonly repo: string }
  /** There is a remote, and it is not a GitHub repository (a local path, a mirror, a self-host). */
  | { readonly kind: "other"; readonly url: string }
  /** No `origin`, or no git at all. A checkout that cannot say where it came from. */
  | { readonly kind: "unresolvable" };

export function originOf(exec: Exec, root: string): OriginVerdict {
  const r = exec.capture("git", gitArgsOf(root, ["remote", "get-url", "origin"]));
  if (!r.found || r.code !== 0) return { kind: "unresolvable" };
  const url = r.stdout.trim();
  if (url === "") return { kind: "unresolvable" };
  const repo = parseGithubRemote(url);
  return repo === null ? { kind: "other", url } : { kind: "repo", repo };
}

/**
 * Does `origin` agree with the repo updates are configured to come from?
 *
 * Both sides are normalised before they are compared: a GitHub origin is reduced to `owner/repo`
 * case-insensitively, and a non-GitHub origin (a local path, a self-hosted mirror) can still match
 * a `COLLIE_UPDATE_REPO` spelled the same way — which is the only self-consistent answer for an
 * operator who deliberately points both at their own remote.
 */
export function originMatches(origin: OriginVerdict, configured: string): boolean {
  const want = configured.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  if (origin.kind === "unresolvable") return false;
  if (origin.kind === "repo") {
    const wanted = parseGithubRemote(want) ?? want;
    return origin.repo.toLowerCase() === wanted.toLowerCase();
  }
  return origin.url.trim().replace(/\/+$/, "").replace(/\.git$/, "") === want;
}
