import { PACKAGED_SENTENCE } from "./install-kind.ts";

// NAMING THE MANAGER, never deciding the kind. Every path prefix Collie recognises lives here and
// nowhere else — `install-kind.ts` spells none of them, because a prefix is not evidence (M17
// principle 3). `classifyInstall` has already said `packaged` by the time anything here runs; these
// functions only choose which words to print.

/**
 * The command that takes the new version, when the resolved root names a manager we know — else null.
 *
 * THE PREFIX IS NOT EVIDENCE. By the time this runs the kind is already decided, structurally, by
 * {@link classifyInstall}; this only chooses which words to print. A prefix nobody recognises costs
 * the operator a command, never a wrong kind (M17 principle 3), which is why an unknown prefix is
 * `null` and the caller falls back to {@link PACKAGED_SENTENCE} alone.
 *
 * The roots are the ones our own packages install to (M17 spec 05) plus Homebrew's two prefixes.
 */
export function packageCommand(root: string): string | null {
  const under = (prefix: string): boolean => root === prefix || root.startsWith(`${prefix}/`);
  // Two Arch roots, one package. `/opt/collie` is where `collie-bin` installs since the PKGBUILD
  // took the layout Omarchy's package repository expects; `/usr/lib/collie` is where every copy
  // installed before that, and it stays here for as long as one of those hosts is still running.
  if (under("/opt/collie") || under("/usr/lib/collie")) return "sudo pacman -Syu collie-bin";
  if (under("/nix/store")) return "nix profile upgrade collie";
  if (under("/opt/homebrew") || under("/usr/local/Cellar")) return "brew upgrade collie";
  return null;
}

/**
 * The whole sentence for a packaged install, with the command named when one is known.
 *
 * One spelling for every surface — a second would drift the moment either half is reworded.
 */
export function packagedReason(root: string): string {
  const cmd = packageCommand(root);
  return cmd === null ? PACKAGED_SENTENCE : `${PACKAGED_SENTENCE} — \`${cmd}\``;
}
