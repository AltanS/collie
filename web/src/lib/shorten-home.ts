// A launcher row's pinned `cwd` is an absolute path on whichever host answered — the lead's or, in
// a pack, a peer's — and the two are not always the same string. `tildeHome` (lib/format.ts) GUESSES
// at $HOME by pattern-matching `/home/<user>`, `/var/home/<user>`, `/Users/<user>`; that guess is
// wrong the moment a peer runs a less common layout. `GET /api/launchers` answers the actual home
// dir for the host it read (`LaunchersResponse.home`), so this collapses against THAT fact instead
// of a pattern.

/**
 * Shorten `path` to a leading `~` when it sits under `home`, exactly (path === home) or as a
 * descendant (path === home + "/…"). Anything else — a different tree entirely, or a path that
 * merely shares `home` as a string prefix without the directory boundary (`/home/opera` under
 * `/home/op`) — is returned unchanged, because a false "under home" is a worse reading than none.
 */
export function shortenHome(path: string, home: string): string {
  if (home === "") return path;
  // Trim a trailing slash off `home` so `home + "/"` below never doubles one — the operator's
  // own home dir string is never trusted to already be normalised.
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  if (base === "") return path;
  if (path === base) return "~";
  if (path.startsWith(`${base}/`)) return `~${path.slice(base.length)}`;
  return path;
}
